// main.js — composition root. Loads feels (from JSON + localStorage) and songs (from
// localStorage), wires controls/import/export -> state -> derive -> ui across both the
// Progressions and Songs tabs, and registers the service worker. The only stateful,
// side-effectful module.
//
// Tab/song state (currentView, currentSongId, pendingNew) is intentionally in-memory
// only: it is not part of the deep-linkable generator state (persistence.js), and on
// reload the app opens on Progressions with the Songs tab blank. Songs live in the
// localStorage working cache (sn_songs) and autosave on every edit; the durable, portable
// artifact is the .json a song is Opened from / Saved to (see onSaveSongFile / onOpenSong*).
import { deriveOutput } from './derive.js';
import { validate, randomize, DEFAULT_FEEL } from './session.js';
import { load, save, reflectUrl } from './persistence.js';
import { loadBuiltinFeels, loadUserFeels, saveUserFeels } from './feelStore.js';
import { validateFeel, normalizeFeel, mergeFeels } from './feels.js';
import { loadSongs, saveSongs, onSaveError } from './songStore.js';
import {
  validateSong, normalizeSong, nextUntitledName, slugifySongId, buildCapturedProgression,
  createSong, appendProgressions, reorderProgression, removeProgression, copyProgression,
  setProgressionLabel, setLyrics, renameSong, finalizeDraft, duplicateSong,
  appendRow, addChord, setChord, removeChord, toMarkdown,
  toSongFile, resolveOpenedTapeDeck,
} from './songs.js';
import { isAcceptedAudio, makeSketchMeta, addSketchMeta, removeSketchMeta, setSketchNotes } from './sketches.js';
import * as audioStore from './audioStore.js';
import { chordFromRootAndQuality } from './theory/roman.js';
import * as takeModel from './tape/takeModel.js';
import * as meterModel from './tape/meterModel.js';
import { clampClickConfig, defaultClickConfig, lockClickEdit, barSeconds } from './tape/clickModel.js';
import { clampDrumConfig, defaultDrumConfig, toggleCell, setBars, smfToPattern, lockDrumEdit, MAX_FLAT_BARS } from './tape/drumModel.js';
import { realizeSequence, flattenRealizedSequence, sequenceBars, validateRuleset, normalizeRuleset } from './tape/rulesetModel.js';
import { makeLoopPicker, makeSingleMidiPicker } from './tape/loopPicker.js';
import { loadBuiltinRulesets, loadUserRulesets, saveUserRulesets } from './tape/rulesetStore.js';
import * as takeStore from './tape/takeStore.js';
import * as folderStore from './tape/folderStore.js';
import { runDeckRestore, planDupeTakes, pruneTapeDeckToCopied } from './tape/deckRestore.js';
import { SIZE_FIELDS, sliceWavBytes, wavSampleCount } from './tape/wav.js';
import { makeTapeDeck } from './tape/audioEngine.js';
import { estimateMonitorLatencySec } from './tape/latency.js';
import { mountApp } from './ui.js';

const rootEl = document.getElementById('app');
const nowISO = () => new Date().toISOString();
// A globally-unique, song-independent sketch id — also the IndexedDB key for its audio.
const newSketchId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : 's-' + Date.now() + '-' + Math.random().toString(36).slice(2));

// Best-effort durable storage so iOS is less likely to evict a user's audio. Requested
// once, lazily, the first time a sketch is stored.
let persistRequested = false;
function ensurePersist() {
  if (persistRequested) return Promise.resolve();
  persistRequested = true;
  try { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(() => {}); } catch {}
  return Promise.resolve();
}

// The default chord for a new row / the + button: C major.
const cMajor = () => chordFromRootAndQuality({ letter: 0, acc: 0 }, 'maj');

let builtinFeels = [];
let builtinIds = [];
let userFeels = [];
let feelList = [];   // merged, ordered, tagged builtin:true/false
let feelsById = {};
let feelIds = [];
let state;
let app;
let lastModel;       // the most recent deriveOutput(state) — reused for song-only re-renders

// ---- songs state (in-memory; sn_songs is the only persisted part) ----
let songs = [];
let currentView = 'progressions';
let currentSongId = null;   // id of the selected song (null when none)
let pendingNew = null;      // a new song awaiting its name: { snaps } (snaps=null → blank seed)
let genFlash = null;        // transient note on the generator (e.g. "Added to …")
let currentSketchId = null; // id of the selected sketch in the active song (master-detail)
let sketchFlash = null;     // transient sketch add accept/reject status (survives one render)
let songFlash = null;       // transient Save/Open status on the Songs tab (survives one render)
// Per-song File System Access handles for silent Save (overwrite in place). Session cache;
// also persisted in IndexedDB (audioStore.fileHandles). Empty on iOS / Chrome Android.
const fileHandles = new Map();

// ---- tape deck state (in-memory; the manifest + audio are OPFS, not sn_songs) ----
let songSubView = 'sections';  // 'sections' | 'tapedeck' — per-song sub-view flag (NOT a top-level tab)
let tapeDeck = null;           // the audioEngine controller — created once, lazily; outlives every render
let tapeLive = { timerEl: null, meterEls: null, setPlayStatus: null }; // current render's live DOM refs (§5.6)
let deckManifest = null;       // the active song's tape manifest (or null if not open/loaded yet)
let currentTake = null;        // take NUMBER loaded in the deck (or null)
let deckStatus = null;         // transient { type:'warn'|'error', message } banner
let deckBlocked = false;       // AC-26: mic permission denied
let deckUnsupported = false;   // OPFS/createSyncAccessHandle unsupported (§2 — no fallback store)
let deckRecording = false;
let deckArming = false;        // synchronous re-entrancy guard for the Record button's async setup window
let deckBouncing = false;
let deckSaving = false;        // a Save (OPFS -> song folder migration) is in flight; mutually exclusive with record/bounce
let deckHasJsonHandle = false; // cached (sync for the view-model): the active song has a retained .json handle
let deckHasFolderHandle = false; // cached: the active song has a remembered folder (::dir) handle
let deckFolderNeedsGrant = false; // takes restored but folder access is needed (once/session) to PLAY their audio
let deckOfferRecover = false;  // empty deck, but a remembered-yet-ungranted folder MAY hold saved takes → offer grant+recover
let deckOpenSeq = 0;           // bumped on every onOpenTapeDeck call; a stale in-flight open detects itself via this
let deckPendingNewTake = false; // a "+ New take" container awaiting its first pass (materialized lazily at Record)
let deckArmed = [];             // [{ slotKey, inputIndex }] — REC-armed strips for the next pass (normalized each render)
let deckPanelOpen = null;       // 'drums' | 'cal' | 'share' | null — which flip-panel is open (UI-local, not persisted)
let deckLogOpen = false;        // TAPE LOG <details> open state (UI-local; the <details> reflects it, no render on toggle)
let deckTab = 'mix';            // 'mix' | 'timeline' — the deck's active tab (Mix mixer vs Timeline clips)
let deckHead = 0;               // the timeline record/play HEAD bar (0 = song start); Timeline-only concept
let deckTool = null;            // 'slice' | 'trim' | 'delete' | 'dupe' | null — the active timeline tool
let deckDupeSrc = null;         // { key, clipId } — the clip the dupe tool picked, awaiting a target click
let deckScrollLeft = 0;         // the timeline horizontal scroll offset, preserved across full re-renders
let deckRecordingSlotKeys = []; // the in-flight pass's destination slot keys (meter routing + finalize)
let deckRecordingGroup = null;  // the in-flight pass's group number
let deckRecordTimeline = false; // the in-flight pass is a TIMELINE record: place clips at the head, replace-region
let deckRecordHead = 0;         // the head bar the in-flight timeline clips land at
let deckRecordClipIds = {};     // { slotKey: clipId } for the in-flight timeline pass
let deckInputs = null;         // devices.probe() result: { inputs, preselectedId, warnMoreThanMax, isLikelyInterface, channels }
let deckSelectedInputId = null;
let deckSpaceWarning = false;
let deckCalibrating = false;   // an overdub-latency calibration is in flight (clicks playing)
let deckClickDraft = null;     // the editable metronome config for a NEW take (last-used default)
let deckDrumDraft = null;      // the editable drum config for a NEW take (last-used default)
let deckDrumBar = 0;           // which bar of a multi-bar drum pattern the grid is showing (UI-local)
let stemSettingsDebounce = null;
// ---- drum-loop sequencer (new-take authoring; frozen onto the take at record) ----
let deckDrumMode = 'single';   // 'single' (import/grid) | 'sequence' — the DRUMS panel mode for a new take
let deckSequenceDraft = null;  // the sequencer SPEC + parsed patterns for a new take (makeEmptySequenceDraft)
let deckLoopAuditionIndex = 0; // ←/→ audition cursor over [intro?, main loops…, outro?]
let builtinRulesets = [];      // loaded once from assets/rulesets/ at boot
let deckRulesets = [];         // normalized builtin+user rulesets (user overrides same id), for the dropdown + roll
let deckSequenceReject = null; // last folder-pick rejection { reason, offenders, expected }, to show the reminder
let loopPicker = null, introPicker = null, outroPicker = null; // lazily-created (they append hidden <input>s)

function makeEmptySequenceDraft() {
  return { folderName: null, loopFiles: [], loopPatterns: [], introName: null, introPattern: null, outroName: null, outroPattern: null, algorithmId: null, count: 8 };
}

function recompute() {
  const merged = mergeFeels(builtinFeels, userFeels);
  feelList = merged.list;
  feelsById = merged.byId;
  feelIds = feelList.map((f) => f.id);
}

// The song currently open in the Songs tab: the selected song (or null).
function activeSong() {
  if (currentSongId) return songs.find((s) => s.id === currentSongId) || null;
  return null;
}

// Drop every piece of tape-deck UI state tied to whichever song was active —
// called whenever the active song changes, so a stale manifest/take selection
// from song A can't leak into song B's deck view.
function resetTapeDeckUi() {
  deckOpenSeq++; // invalidate any in-flight onOpenTapeDeck for the song being left
  songSubView = 'sections';
  if (tapeDeck) tapeDeck.stopPlay();
  deckManifest = null;
  currentTake = null;
  deckStatus = null;
  deckBlocked = false;
  deckUnsupported = false;
  deckRecording = false;
  deckArming = false;
  deckBouncing = false;
  deckSaving = false;
  deckHasJsonHandle = false;
  deckHasFolderHandle = false;
  deckFolderNeedsGrant = false;
  deckOfferRecover = false;
  deckCalibrating = false;
  deckPendingNewTake = false;
  deckArmed = [];
  deckPanelOpen = null;
  deckLogOpen = false;
  deckTab = 'mix';
  deckHead = 0;
  deckTool = null;
  deckDupeSrc = null;
  deckScrollLeft = 0;
  deckRecordingSlotKeys = [];
  deckRecordingGroup = null;
  deckRecordTimeline = false;
  deckRecordHead = 0;
  deckRecordClipIds = {};
  deckInputs = null;
  deckSelectedInputId = null;
  deckClickDraft = null;
  deckDrumDraft = null;
  deckDrumBar = 0;
  deckDrumMode = 'single';
  deckSequenceDraft = null;
  deckLoopAuditionIndex = 0;
  deckSequenceReject = null;
  clearTimeout(stemSettingsDebounce);
}

// The tape-deck slice of the view-model — see js/tape/tapeView.js for the shape
// this feeds. Cheap to compute even when the deck isn't open (deckManifest is
// null until onOpenTapeDeck loads it, so `takes` is just []).
//
// Normalize the ARMED set [{slotKey, inputIndex}] against the take's actually-free
// slots and the interface's real input count: drop entries whose slot is no longer
// free, reassign an input index that's out of range or collides to the lowest free
// input, dedupe, and cap at maxCapture. Recomputed each render and cached back into
// deckArmed so onArmTrack/onCycleInput act off the same array the UI shows. NO
// autofill — arming is explicit (tap REC), unlike the old routing model.
function normalizeArmed(prev, freeKeys, channels, maxCapture) {
  const out = [];
  const usedInputs = new Set();
  for (const a of (prev || [])) {
    if (!a || !freeKeys.includes(a.slotKey)) continue;            // slot no longer free
    if (out.some((x) => x.slotKey === a.slotKey)) continue;       // dedupe slots
    if (out.length >= maxCapture) break;                          // capacity (min inputs/free/4)
    let idx = a.inputIndex;
    if (!(idx >= 0 && idx < channels) || usedInputs.has(idx)) {   // out of range or taken -> lowest free input
      idx = 0; while (idx < channels && usedInputs.has(idx)) idx++;
      if (idx >= channels) continue;                              // no free input left
    }
    usedInputs.add(idx);
    out.push({ slotKey: a.slotKey, inputIndex: idx });
  }
  return out;
}

function tapeDeckViewModel(active) {
  const takes = (deckManifest && deckManifest.takes) || [];
  const activeWithAudio = takes.filter((t) => t.status === 'active' && takeModel.takeHasAudio(t));
  const loadedTake = deckRecording
    ? (takes.find((t) => t.status === 'recording') || null)
    : (deckPendingNewTake ? null : (currentTake != null ? (takes.find((t) => t.take === currentTake && t.status === 'active') || null) : null));
  const pendingNewTake = deckPendingNewTake || (!deckRecording && !loadedTake && activeWithAudio.length === 0);

  // Free/filled tracks of the take being worked on (all 4 free for a pending new take).
  let filledSlotKeys, freeSlotKeys;
  if (pendingNewTake) { filledSlotKeys = []; freeSlotKeys = takeModel.STEM_KEYS.slice(); }
  else if (loadedTake) { filledSlotKeys = takeModel.filledSlotKeys(loadedTake); freeSlotKeys = takeModel.freeSlotKeys(loadedTake); }
  else { filledSlotKeys = []; freeSlotKeys = []; }

  const inputChannels = (deckInputs && deckInputs.channels) || 1;
  const freeSlots = freeSlotKeys.length;
  // Timeline recording can arm ANY lane (existing clips the head reaches get replaced); Mix arms
  // only free lanes (a filled Mix track must be bounced first).
  const armableKeys = deckTab === 'timeline' ? takeModel.STEM_KEYS.slice() : freeSlotKeys;
  const maxCapture = Math.min(inputChannels, armableKeys.length, takeModel.MAX_TRACKS);

  // Normalize + cache the armed set (drops un-armable slots, reassigns stale inputs).
  const armed = normalizeArmed(deckArmed, armableKeys, inputChannels, maxCapture);
  deckArmed = armed;
  const armedByKey = {};
  armed.forEach((a) => { armedByKey[a.slotKey] = a.inputIndex; });

  // Per-strip state for the four ALWAYS-present strips (precedence: recording > armed >
  // filled > empty). The view renders every strip; empty ones are grayed/disabled.
  const recordingSet = new Set(deckRecordingSlotKeys);
  const strips = {};
  takeModel.STEM_KEYS.forEach((key) => {
    const stem = (loadedTake && loadedTake.stems) ? loadedTake.stems[key] : null;
    const hasAudio = takeModel.slotHasAudio(stem);
    let state;
    if (recordingSet.has(key)) state = 'recording';
    else if (armedByKey[key] != null) state = 'armed';
    else if (hasAudio) state = 'filled';
    else state = 'empty';
    strips[key] = { state, inputIndex: armedByKey[key] != null ? armedByKey[key] : null, stem: hasAudio ? stem : null, clips: takeModel.laneClips(stem) };
  });

  // Metronome config: editable for a new take (the last-used draft), read-only once the
  // take has audio (its tempo is locked and every overdub reuses it).
  const clickLocked = !pendingNewTake && filledSlotKeys.length > 0;
  const clickConfig = clickLocked
    ? ((loadedTake && loadedTake.click) || defaultClickConfig())
    : (deckClickDraft || readClickDefault());
  // Drums stay EDITABLE after recording (they regenerate from config at playback). `drumOnTake`
  // just tells the panel it's editing a recorded take (edits persist to it) vs the new-take draft.
  const drumOnTake = clickLocked;
  const drumConfig = drumOnTake
    ? ((loadedTake && loadedTake.drums) || defaultDrumConfig())
    : (deckDrumDraft || readDrumDefault());

  // ---- drum-loop sequencer slice ----
  // A recorded take shows its FROZEN sequence read-only (drumOnTake); a new take shows the
  // editable draft. drumMode picks the panel face (single import/grid vs the sequencer).
  const recordedSeq = (drumOnTake && drumConfig.source && drumConfig.source.type === 'sequence') ? drumConfig.sequence : null;
  const drumMode = drumOnTake ? (recordedSeq ? 'sequence' : 'single') : deckDrumMode;
  const sd = deckSequenceDraft;
  const sequenceDraft = sd ? {
    folderName: sd.folderName,
    loopCount: sd.loopFiles.length,
    loopFiles: sd.loopFiles.slice(),
    loopBars: sd.loopPatterns.map((p) => p.bars),
    introName: sd.introName, introBars: sd.introPattern ? sd.introPattern.bars : 0,
    outroName: sd.outroName, outroBars: sd.outroPattern ? sd.outroPattern.bars : 0,
    algorithmId: sd.algorithmId,
    count: sd.count,
  } : null;

  // The number shown in the LED counter window.
  const counterTakeNo = loadedTake ? loadedTake.take : (pendingNewTake ? takeModel.nextTakeNumber(deckManifest) : (currentTake || null));

  // Uncalibrated: surface the live auto-estimate (from the AudioContext output latency) so the CAL
  // panel shows what compensation the next record will apply; measured/manual keep their stored ms.
  // Never persisted — recomputed each render from the live context (no context yet -> 0 -> "none").
  const rawLatency = readLatency(deckSelectedInputId);
  const monitorLatency = rawLatency.source === 'none'
    ? { ...rawLatency, estimateMs: Math.round(estimateMonitorLatencySec(tapeDeck ? tapeDeck.getContextLatency() : {}) * 1000) }
    : rawLatency;

  return {
    songId: active ? active.id : null,
    path: active ? takeModel.tapeDeckRef(active.id).path : '',
    currentTakeNo: loadedTake ? loadedTake.take : null,
    counterTakeNo,
    manifestTakes: takes,
    // Loadable take numbers, newest first — drives the header take pulldown.
    loadableTakes: activeWithAudio.map((t) => t.take).sort((x, y) => y - x),
    loadedTake,
    pendingNewTake,
    recording: deckRecording,
    bouncing: deckBouncing,
    overdub: deckRecording && filledSlotKeys.length > deckRecordingSlotKeys.length,
    blocked: deckBlocked,
    unsupported: deckUnsupported,
    noInterface: !!(deckInputs && deckInputs.channels < 2),
    warnMoreThanMax: !!(deckInputs && deckInputs.warnMoreThanMax),
    inputs: (deckInputs && deckInputs.inputs) || [],
    selectedInputId: deckSelectedInputId,
    inputChannels,
    status: deckStatus,
    spaceWarning: deckSpaceWarning,
    calibrating: deckCalibrating,
    monitorLatency, // { ms, source:'measured'|'manual'|'none', spreadMs, estimateMs? (when uncalibrated) }
    hasHistory: takes.length > 0,
    filledSlotKeys,
    freeSlotKeys,
    freeSlots,
    filledCount: filledSlotKeys.length,
    maxCapture,
    armed,
    strips,
    // Timeline tab state + the bar<->seconds scale for the ruler/clips.
    tab: deckTab,
    head: deckHead,
    tool: deckTool,
    dupeSrc: deckDupeSrc,
    scrollLeft: deckScrollLeft,
    barSec: takeModel.secPerBar({ click: clickConfig }),
    recordingSlotKeys: deckRecordingSlotKeys,
    lastGroupKeys: (loadedTake && !deckRecording) ? takeModel.lastGroupSlotKeys(loadedTake) : [],
    canBounceTracks: !deckRecording && !deckBouncing && filledSlotKeys.length >= 2,
    showLoadedActions: !deckRecording && !!loadedTake,
    clickConfig,
    clickLocked,
    drumConfig,
    drumOnTake,
    drumBar: deckDrumBar,
    drumMode,
    rulesets: deckRulesets.map((r) => ({ id: r.id, name: r.name, type: r.type })),
    sequenceDraft,
    recordedSequence: recordedSeq,
    sequenceReject: deckSequenceReject,
    loopAuditionIndex: deckLoopAuditionIndex,
    masterVol: readMasterVol(),
    panelOpen: deckPanelOpen,
    logOpen: deckLogOpen,
    canRecord: armed.length >= 1 && !deckBlocked && !deckUnsupported && !deckRecording && !deckBouncing && !deckSaving,
    // Folder persistence (Save/Export/Rename/Delete row): how many takes still have
    // OPFS-only audio to migrate, and whether a .json / folder handle already exists.
    takesPendingSave: takes.filter((t) => t.status !== 'discarded' && takeModel.takeHasAudio(t) && !takeModel.takeIsSaved(t)).length,
    saving: deckSaving,
    folderGranted: deckHasFolderHandle,
    folderNeedsGrant: deckFolderNeedsGrant,
    // An empty deck whose folder MAY hold saved takes (remembered handle, not granted this session):
    // the banner offers grant+recover rather than silently showing nothing. Distinct from
    // folderNeedsGrant (takes already listed, folder needed only to PLAY their audio).
    offerRecover: deckOfferRecover,
    jsonSaved: deckHasJsonHandle,
  };
}

function songViewModel() {
  const active = activeSong();
  return {
    view: currentView,
    genFlash,
    songs: songs.map((s) => ({ id: s.id, name: s.name })),
    activeSong: active,
    isPendingNew: !!pendingNew,
    hasCurrentSong: !!active,
    currentSongName: active ? active.name : '',
    selectedId: currentSongId || null,
    nextName: nextUntitledName(songs.map((s) => s.name)),
    linkedFile: active && active.file ? active.file.name : null,
    songFlash,
    currentSketchId,
    sketchFlash,
    songSubView,
    deck: tapeDeckViewModel(active),
    deckHasTapeDeck: !!(active && active.tapeDeck),
    deckTakeCountForDelete: (active && active.tapeDeck && deckManifest && active.id === deckManifest.slug)
      ? deckManifest.takes.filter((t) => t.status !== 'discarded').length
      : null,
  };
}

// Re-render both views from current state (no recompute, no persistence).
function render() {
  app.update(state, lastModel, feelList, songViewModel());
}

// Generator state changed: recompute the model, persist state + URL, re-render.
function commit() {
  save(state);
  reflectUrl(state);
  lastModel = deriveOutput(state, feelsById);
  render();
}

// Apply a pure transform to the active song and persist immediately (every edit autosaves
// to the localStorage working cache).
function updateActive(fn) {
  const now = nowISO();
  if (currentSongId) {
    songs = songs.map((s) => (s.id === currentSongId ? fn(s, now) : s));
    saveSongs(songs);
  }
}

// Build snapshots for the checked generator rows (indices into lastModel.sections).
function snapshotsFor(indices) {
  return indices
    .map((i) => lastModel.sections[i])
    .filter(Boolean)
    .map((section) => buildCapturedProgression(state, lastModel, section));
}

// Build a clean feels/<id>.json-shaped object for export.
function toFeelFile(f) {
  const out = { '$schema': './feel.schema.json', id: f.id, name: f.name };
  let schemaVersion = 1;
  if (Array.isArray(f.sections)) { out.sections = f.sections.map((s) => ({ label: s.label, progression: s.progression.slice() })); schemaVersion = 3; }
  else if (Array.isArray(f.progression)) { out.progression = f.progression.slice(); schemaVersion = 2; }
  else { out.degrees = f.degrees.slice(); }
  if (typeof f.description === 'string') out.description = f.description;
  if (Array.isArray(f.tags)) out.tags = f.tags.slice();
  if (typeof f.source === 'string') out.source = f.source;
  out.schemaVersion = schemaVersion;
  return out;
}

// The songs/<id>.json-shaped object (metadata only; audio bytes are added by toSongBundle)
// is built by the PURE `toSongFile` in songs.js — the single writer of the .json shape, so the
// durable tapeDeck.takes are embedded there and the node test proves it. (This impure module used
// to carry its own copy, whose tapeDeck block sat after an early return and never ran.)

// Read a Blob as base64 (no "data:...," prefix).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Decode base64 back into a Blob of the given mime type.
function base64ToBlob(b64, mimeType) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || '' });
}

// A self-contained bundle: the song file plus a base64 audio map keyed by sketch id.
// Keeping bytes in a separate `audio` map (not inside each sketch record) leaves the
// sketches[] metadata byte-identical to what's stored, so import validates it unchanged.
async function toSongBundle(song) {
  const base = toSongFile(song);
  const audio = {};
  for (const sk of (song.sketches || [])) {
    let blob;
    try { blob = await audioStore.getBlob(sk.id); } catch { blob = null; }
    if (!blob) continue;
    audio[sk.id] = { mimeType: sk.mimeType || blob.type || '', b64: await blobToBase64(blob) };
  }
  base.audio = audio;
  return base;
}

// Overwrite a song's on-disk .json in place from its current in-memory record (the durable
// single source of truth: it now carries tapeDeck.takes). Desktop File System Access only —
// silently no-ops (returns false) when we hold no writable handle for the song (iOS/Android,
// or a never-linked song), where localStorage remains the per-device durable copy. Returns
// true only on a verified write. Reused by Save and the legacy tapeDeck migration.
async function writeSongJsonById(id) {
  const song = songs.find((s) => s.id === id);
  if (!song) return false;
  const jsonHandle = await handleForSong(id);
  if (!jsonHandle || !(await ensureHandleWritable(jsonHandle))) return false;
  try { await writeJsonSink({ handle: jsonHandle }, await toSongBundle(song)); return true; }
  catch { return false; }
}

// Re-project the loaded deck's current takes into the song's durable record — localStorage (the
// permission-free per-device copy) AND the on-disk .json — WITHOUT migrating audio. Metadata-only,
// so it needs no folder grant. Used by a per-take Delete so the removal is durable immediately: an
// OPFS-evicted reopen hydrates from this .json and can't resurrect the deleted take (H5). Projects
// folder-saved takes only (an unsaved OPFS-only take was never in the .json); the freed folder WAV
// is GC'd on the next Save. (A ping-pong bounce is NOT persisted here — its new audio is OPFS-only
// until Save migrates it, so projecting would drop it from the .json; bounce durability is Save's job.)
async function persistDeckTakes(id) {
  if (!deckManifest) return;
  const td = takeModel.tapeDeckWithTakes(id, deckManifest);
  songs = songs.map((s) => (s.id === id ? { ...s, tapeDeck: td, updatedAt: nowISO() } : s));
  saveSongs(songs);
  await writeSongJsonById(id);
}

// Crash recovery of interrupted passes (§5.3): finalize any pass a prior session left mid-record
// (status 'recording', a slot with a file but no duration) BEFORE mostRecentKeptTake can see it — a
// nonzero on-disc byte count finalizes that slot, an empty one is freed, and a take left with zero
// real tracks is tombstoned. The `recoverPass` port of runDeckRestore. A json/folder hydrate has no
// 'recording' takes, so this is a no-op there.
async function recoverInterruptedPasses(manifest, id) {
  const dir = takeModel.tapeDeckRef(id).path;
  let m = manifest;
  for (const t of m.takes.slice()) {
    if (t.status !== 'recording') continue;
    const slotBytes = {};
    for (const key of takeModel.STEM_KEYS) {
      const lane = t.stems && t.stems[key];
      const clip = lane && lane.clips && lane.clips.find((c) => c.file && c.durationSec === null); // the pending recording clip
      if (!clip) continue;
      try { slotBytes[key] = await takeStore.finalizeExisting(dir + clip.file, SIZE_FIELDS); } catch { slotBytes[key] = 0; }
    }
    m = takeModel.finalizeRecoveredPass(m, t.take, slotBytes, t.sampleRate);
  }
  return m;
}

// Import one raw song/bundle object: validate, normalize, resolve id collisions, decode
// its audio under FRESH sketch ids (so re-import never clobbers existing blobs), and
// persist. Returns { ok, name } or { ok:false, error }. Sets currentSongId on success.
async function importOneSong(raw, mode = 'import') {
  const v = validateSong(raw);
  if (!v.ok) return { ok: false, error: v.errors[0] };
  let s = normalizeSong(raw);
  const now = nowISO();
  if (!s.createdAt) s = { ...s, createdAt: now };
  if (!s.updatedAt) s = { ...s, updatedAt: now };

  // Open (the user's OWN .json) vs Import (a foreign/shared bundle) differ on identity + takes:
  //  - Open + an existing record with the SAME id AND createdAt → genuine RE-OPEN: keep the id
  //    (its take WAVs are named <id>_*.wav) and REPLACE the record in place (never concat → no
  //    duplicate id), preserving tapeDeck.takes so the deck restores from it.
  //  - Open + an id not present here → first open on this device: keep the id + takes, concat.
  //  - A collision with a DIFFERENT song (createdAt differs), or any Import → reslug the id; the
  //    incoming take refs would then point at a dead takes/<newid>/ and the bundle has no audio,
  //    so strip tapeDeck. createdAt is the identity token: normalizeSong preserves it and edits
  //    only bump updatedAt, so it distinguishes a re-open from a same-named different song.
  const existing = mode === 'open' ? songs.find((x) => x.id === s.id) : null;
  const sameSong = !!(existing && existing.createdAt && existing.createdAt === s.createdAt);
  const reslug = songs.some((x) => x.id === s.id) && !sameSong;
  if (reslug) s = { ...s, id: slugifySongId(s.name, songs.map((x) => x.id)) };

  const audioMap = (raw && raw.audio) || {};
  const rekeyed = [];
  for (const sk of s.sketches) {
    const entry = audioMap[sk.id];
    if (!entry || typeof entry.b64 !== 'string') continue;  // no bytes → drop this sketch's metadata
    const newId = newSketchId();
    try { await audioStore.putBlob(newId, base64ToBlob(entry.b64, entry.mimeType || sk.mimeType || '')); rekeyed.push({ ...sk, id: newId }); }
    catch { /* write failed → drop this sketch */ }
  }
  s = { ...s, sketches: rekeyed };

  // Opening a .json must never destroy durable take records the file itself lacks. Keep the
  // incoming tapeDeck on a faithful own-open whose path matches this id (the .json is the source of
  // truth); else fall back to the EXISTING in-memory record's saved takes (a legacy pre-embed .json
  // — a later Save / grant-migration re-embeds them); else strip (import / reslug: audio absent,
  // refs dead). See songs.resolveOpenedTapeDeck.
  const keepTd = resolveOpenedTapeDeck(s, existing, mode, reslug);
  if (keepTd) s = { ...s, tapeDeck: keepTd };
  else if ('tapeDeck' in s) { const { tapeDeck: _drop, ...rest } = s; s = rest; }
  // The file link is local to whoever exported it; the opener re-links to the file it
  // actually opened (afterOpen), so never carry an incoming link in.
  if ('file' in s) { const { file: _dropFile, ...rest } = s; s = rest; }

  songs = sameSong ? songs.map((x) => (x.id === s.id ? s : x)) : songs.concat(s);
  saveSongs(songs);
  currentSongId = s.id;
  return { ok: true, name: s.name, id: s.id };
}

// Parse text (a single bundle object or an array of them) and import each. Returns
// { ok, ids, count, error } — ids are the resulting (possibly re-slugged) song ids.
async function importSongsFromText(text, mode = 'import') {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, ids: [], count: 0, error: 'not valid JSON' }; }
  const items = Array.isArray(obj) ? obj : [obj];
  const ids = [];
  let firstErr = null;
  for (const raw of items) {
    const r = await importOneSong(raw, mode);
    if (r.ok) ids.push(r.id); else if (!firstErr) firstErr = r.error;
  }
  return { ok: ids.length > 0, ids, count: ids.length, error: ids.length ? null : (firstErr || 'nothing to import') };
}

// Land an Open: select the imported song, and for the single-song case link it to the
// file it came from (name always; the writable handle when the platform gave us one).
function afterOpen(res, linkName) {
  pendingNew = null;
  currentSketchId = null;
  sketchFlash = null;
  songFlash = res.ok ? null : { ok: false, error: res.error };
  currentView = 'songs';
  resetTapeDeckUi();
  if (res.ok) {
    currentSongId = res.ids[res.ids.length - 1];
    if (res.count === 1 && linkName) {
      const sid = res.ids[0];
      songs = songs.map((s) => (s.id === sid ? { ...s, file: { name: linkName } } : s));
      saveSongs(songs);
    }
  }
  render();
}

// After load, drop any sketch metadata whose blob is missing (evicted / never written)
// and garbage-collect blobs no song references. Self-guarding: an IDB failure leaves the
// songs list untouched.
async function reconcileSketches(list) {
  let keys;
  try { keys = new Set(await audioStore.allKeys()); }
  catch { return list; }
  const referenced = new Set();
  let changed = false;
  const out = list.map((song) => {
    const sk = song.sketches || [];
    const kept = sk.filter((x) => keys.has(x.id));
    kept.forEach((x) => referenced.add(x.id));
    if (kept.length !== sk.length) { changed = true; return { ...song, sketches: kept }; }
    return song;
  });
  if (changed) saveSongs(out);
  const orphans = [...keys].filter((k) => !referenced.has(k));
  if (orphans.length) audioStore.deleteMany(orphans).catch(() => {});
  return out;
}

// Export sink: give the user a real "save as" experience where the platform supports it,
// and degrade gracefully where it doesn't. Three tiers, best-first:
//   1. File System Access API (desktop Chromium): a true OS save dialog — the user edits both
//      the file NAME and the FOLDER. Opened under the click gesture; the returned handle can be
//      written to after an async payload build, without needing the gesture again.
//   2. Web Share with files (iOS Safari / installed iPad PWA, where showSaveFilePicker is absent):
//      the share sheet's "Save to Files" lets the user pick a folder. Closest thing iOS offers.
//   3. Anchor download (Firefox, older Safari): drops the file in the browser Downloads folder.
//
// openJsonSink() is Phase 1 — call it SYNCHRONOUSLY at the top of the click handler, before
// building the (possibly async) payload, so the save dialog still has transient activation.
// It returns a handle sink, a deferred sink (share/download decided once we hold the bytes),
// or null if the user cancels the save dialog.
async function openJsonSink(suggestedName) {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Songwriter JSON', accept: { 'application/json': ['.json'] } }],
      });
      return { handle, name: suggestedName };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;   // user dismissed the save dialog
      // insecure context / blocked → fall through to the share-or-download path
    }
  }
  return { name: suggestedName };   // decide share vs. download once we hold the bytes
}

// Tiers 2+3 of the export sink (share sheet, else anchor download) — the part
// that doesn't need a synchronously-opened File System Access handle. Reused by
// writeJsonSink (tier 1 handled separately, JSON-export-only) and by the
// song/markdown export sinks (there is no "save file picker" step for those,
// only "share sheet or download").
// Returns true when the bytes reached a destination, false when the user dismissed
// the share sheet. The anchor-download tier has no cancel signal, so it returns true.
async function shareOrDownloadBlob(blob, name, mimeType) {
  const file = new File([blob], name, { type: mimeType });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return false; /* else fall through to a download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// Phase 2 — write `obj` (built by the caller, possibly after an await) to the sink.
// Returns true when the bytes were written/shared, false if the user cancelled (a null
// Phase-1 sink, or an iOS share-sheet dismiss). Callers that don't gate on the result
// may ignore it.
async function writeJsonSink(sink, obj) {
  if (!sink) return false;                                 // user cancelled in Phase 1
  const text = JSON.stringify(obj, null, 2) + '\n';
  const blob = new Blob([text], { type: 'application/json' });

  if (sink.handle) {                                       // tier 1: File System Access handle
    const writable = await sink.handle.createWritable();
    try { await writable.write(blob); } finally { await writable.close(); }
    return true;
  }

  return await shareOrDownloadBlob(blob, sink.name, 'application/json');   // tiers 2+3
}

// ---- markdown companion export (.md next to the song's .json) ----
// Mirrors openJsonSink/writeJsonSink but for text/markdown. `startInHandle` (the song's
// retained .json handle, when we hold one) opens the desktop save dialog IN THE SONG'S
// FOLDER, so the .md defaults right beside the .json. tiers 2+3 (share/download) are the
// iOS / Firefox path, exactly as for JSON.
async function openMdSink(suggestedName, startInHandle) {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const opts = { suggestedName, types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] };
      if (startInHandle) opts.startIn = startInHandle;
      const handle = await window.showSaveFilePicker(opts);
      return { handle, name: suggestedName };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;   // user dismissed the save dialog
      // insecure context / blocked → fall through to the share-or-download path
    }
  }
  return { name: suggestedName };
}

async function writeMdSink(sink, md) {
  if (!sink) return false;
  const blob = new Blob([md], { type: 'text/markdown' });
  if (sink.handle) {                                       // tier 1: File System Access handle
    const writable = await sink.handle.createWritable();
    try { await writable.write(blob); } finally { await writable.close(); }
    return true;
  }
  return await shareOrDownloadBlob(blob, sink.name, 'text/markdown');   // tiers 2+3
}

// ---- per-song save-in-place handles (File System Access API; desktop) ----

// Ask (once, under the click gesture) for readwrite permission on a retained handle.
// A browser permission grant, NOT an app "are you sure".
async function ensureHandleWritable(handle) {
  try {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
  } catch {}
  return false;
}

// A usable write handle for a song, if any: session cache first, then IndexedDB.
async function handleForSong(songId) {
  if (fileHandles.has(songId)) return fileHandles.get(songId);
  try { const h = await audioStore.getFileHandle(songId); if (h) { fileHandles.set(songId, h); return h; } } catch {}
  return null;
}

// Remember a handle for a song (session cache + IndexedDB, best-effort).
async function rememberHandle(songId, handle) {
  fileHandles.set(songId, handle);
  try { await audioStore.putFileHandle(songId, handle); } catch {}
}

// ---- per-song FOLDER (directory) handle: the real on-disk folder Save persists take
// audio + MIDI into, next to the song's .json. Stored in the SAME IndexedDB handle store
// under a '::dir' companion key (like '::md'), so no schema bump. Desktop-Chrome only. ----
const dirKey = (songId) => songId + '::dir';

// A permitted directory handle for a song, or null: session/IDB lookup (handleForSong),
// then ensure readwrite permission (a silent query when already granted; one prompt per
// session otherwise — must be on a user gesture). null on no-handle / decline / stale.
async function folderHandleForSong(songId) {
  const dir = await handleForSong(dirKey(songId));
  if (!dir) return null;
  return (await folderStore.ensurePermission(dir)) ? dir : null;
}

// Acquire (once) the song's folder via showDirectoryPicker, defaulting to the song's .json
// folder (startIn), and remember it. Returns the handle or null (cancel / unsupported).
// Must be called under a user gesture (Save).
async function ensureFolderGrant(songId) {
  const existing = await folderHandleForSong(songId);
  if (existing) return existing;
  if (typeof window === 'undefined' || !window.showDirectoryPicker) return null;
  try {
    const startIn = await handleForSong(songId); // the .json handle → picker opens in its folder
    const opts = { id: 'sn-song-folder', mode: 'readwrite' };
    if (startIn) opts.startIn = startIn;
    const dir = await window.showDirectoryPicker(opts);
    if (!(await folderStore.ensurePermission(dir))) return null;
    await rememberHandle(dirKey(songId), dir);
    return dir;
  } catch { return null; } // AbortError (cancel) or blocked
}

// Does a take reference any file that now lives in the folder (so a read/delete needs the
// dir handle)? Lets opfs-only takes stay frictionless (no handle fetch, no permission prompt).
function takeHasFolderFile(take) {
  const stems = (take && take.stems) || {};
  if (takeModel.STEM_KEYS.some((k) => takeModel.laneClips(stems[k]).some((c) => c.file && c.loc === 'folder'))) return true;
  return !!(take && take.bounce && take.bounce.file && take.bounce.loc === 'folder');
}

// Sanitize an imported MIDI filename to a safe basename (no dirs, no path chars) — the name
// stored in the drum config (source.midiFile) and used for the OPFS temp + folder copy.
function safeMidiName(name) {
  const base = String(name || 'import.mid').split(/[\\/]/).pop() || 'import.mid';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return clean && clean !== '.' && clean !== '..' ? clean : 'import.mid';
}

// Turn a failed folder/OPFS read into a clear, actionable deck status (never a silent miss).
function surfaceReadError(e) {
  const message = (e && e.code === 'FOLDER_UNAVAILABLE')
    ? 'Grant folder access to play saved takes (Save re-links if the folder moved).'
    : (e && e.name === 'NotFoundError')
      ? 'Saved audio not found — the song folder may have moved. Re-Save to relink.'
      : 'Could not read the take audio.';
  deckStatus = { type: 'error', message };
  render();
}

// Play/replay a take, resolving the folder handle first (a folder-located slot needs it) and
// surfacing a clear status if the audio can't be read rather than half-loading.
async function playTake(take, slug, isReplay) {
  const fh = takeHasFolderFile(take) ? await folderHandleForSong(slug) : null;
  const headBar = deckTab === 'timeline' ? deckHead : 0; // Timeline plays from the head; Mix from 0
  try {
    const deck = ensureTapeDeck();
    return await (isReplay ? deck.replay(take, slug, fh, headBar) : deck.play(take, slug, fh, headBar));
  } catch (e) { surfaceReadError(e); return false; }
}

// Recording requires the song to have a saved .json (a home for its folder). If it has no
// retained handle, run the Save flow (prompts) and re-check. Returns whether one now exists.
async function ensureSongJsonSaved() {
  const a = activeSong();
  if (!a || !a.id) return false;
  if (await handleForSong(a.id)) return true;
  await handlers.onSaveSongFile();
  return !!(await handleForSong(a.id));
}

// Convenience for a synchronously-built payload (feels): the object is already in hand, so
// opening the picker first keeps the click gesture intact.
async function download(filename, obj) {
  await writeJsonSink(await openJsonSink(filename), obj);
}

// ---- tape deck (§5.6/§5.7) ----

const manifestPath = (slug) => takeModel.tapeDeckRef(slug).path + 'manifest.json';

// Overdub round-trip latency (ms) — the delay the app plays a backing track (drums/overdub) out
// and captures the DI back in. Used to time-align the capture gate's offset. A per-device value
// MEASURED by the in-app loopback calibration (js/tape/audioEngine calibrateLatency), or typed in
// manually, is stored here (source 'measured'/'manual') and used verbatim. UNCALIBRATED (source
// 'none') no longer means 0/no-compensation — record() now AUTO-ESTIMATES the round-trip from the
// live AudioContext output latency + the input track's reported latency (resolveMonitorLatencySec),
// so a first take against the drums lands in the pocket without a manual calibration. The estimate
// is live/per-session and never stored (only measured/manual are persisted, per input device).
const LATENCY_KEY = 'sn_tape_latency';
const latencyKey = (deviceId) => LATENCY_KEY + '_' + (deviceId || 'default');
function readLatency(deviceId) {
  try {
    const raw = localStorage.getItem(latencyKey(deviceId));
    if (raw) { const o = JSON.parse(raw); if (o && typeof o.ms === 'number' && isFinite(o.ms)) return { ms: o.ms, source: o.source || 'manual', spreadMs: isFinite(o.spreadMs) ? o.spreadMs : null }; }
    const legacy = parseFloat(localStorage.getItem('sn_tape_latency_ms')); // pre-per-device global value
    if (isFinite(legacy)) return { ms: legacy, source: 'manual', spreadMs: null };
  } catch { /* ignore */ }
  return { ms: 0, source: 'none', spreadMs: null };
}
function writeLatency(deviceId, obj) {
  try { localStorage.setItem(latencyKey(deviceId), JSON.stringify(obj)); } catch { /* ignore */ }
}
function getMonitorLatencyMs() { return readLatency(deckSelectedInputId).ms; }
function getMonitorLatencySec() { return getMonitorLatencyMs() / 1000; }

// The last-used metronome config for a NEW take (a take carries its own tempo, so this is
// only a UI default, not a scoped value). Absent = "default ON": the click starts enabled
// the first time, but the schema default (defaultClickConfig) stays OFF so a legacy take
// never gains a click on read.
const CLICK_KEY = 'sn_tape_click';
function readClickDefault() {
  try {
    const raw = localStorage.getItem(CLICK_KEY);
    if (raw) return clampClickConfig(JSON.parse(raw));
  } catch { /* ignore */ }
  return clampClickConfig({ ...defaultClickConfig(), enabled: true });
}
function writeClickDefault(cfg) {
  try { localStorage.setItem(CLICK_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// The drum draft's last-used default, same pattern as the click. UI default is ENABLED (so the
// panel opens ready to program/import) with an EMPTY pattern (silent until you add hits); the
// schema default (defaultDrumConfig) stays disabled so a legacy take never gains drums on read.
const DRUMS_KEY = 'sn_tape_drums';
function readDrumDefault() {
  try { const raw = localStorage.getItem(DRUMS_KEY); if (raw) return clampDrumConfig(JSON.parse(raw)); } catch { /* ignore */ }
  return clampDrumConfig({ ...defaultDrumConfig(), enabled: true });
}
function writeDrumDefault(cfg) {
  try { localStorage.setItem(DRUMS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// Drum + count-in settings stay EDITABLE after recording: drums are regenerated from config at
// playback (never captured into a stem), so tweaking a recorded take's kit/pattern/mix/BPM is
// safe. An edit therefore targets the loaded, recorded take's manifest record when there is one,
// else the new-take DRAFT. `editingDeckTake()` returns that take (or null for a draft).
function editingDeckTake() {
  if (deckPendingNewTake || currentTake == null || !deckManifest) return null;
  const t = deckManifest.takes.find((x) => x.take === currentTake && x.status === 'active');
  return (t && takeModel.filledSlotKeys(t).length > 0) ? t : null;
}
function currentDrumBase() { const t = editingDeckTake(); return (t && t.drums) || deckDrumDraft || readDrumDefault(); }
function currentClickBase() { const t = editingDeckTake(); return (t && t.click) || deckClickDraft || readClickDefault(); }
function mergeDrums(base, patch) {
  return clampDrumConfig({
    ...base, ...patch,
    master: { ...base.master, ...(patch.master || {}), eq: { ...base.master.eq, ...((patch.master && patch.master.eq) || {}) } },
    voices: { ...base.voices, ...(patch.voices || {}) },
    pattern: { ...base.pattern, ...(patch.pattern || {}) },
  });
}
function persistDeckManifest() {
  const a = activeSong();
  if (a && deckManifest) takeStore.writeManifest(manifestPath(a.id), deckManifest).catch(() => { /* surfaced by onWriteError */ });
}

// ---- timeline clip editing (slice / trim / dupe / delete): the pure model op decides the geometry
// + new filenames; here we do the impure WAV byte surgery for the created clips, delete orphans,
// then persist + invalidate the cached playback graph. Clip ids are injected here (they land in
// filenames), keeping takeModel pure. ----
let deckClipSeq = 0;
function newClipId() { deckClipSeq += 1; return 'c' + Date.now().toString(36) + deckClipSeq.toString(36); }
async function readClipBytes(slug, clip) {
  const rel = takeModel.tapeDeckRef(slug).path + clip.file;
  if (clip.loc === 'folder') { const dir = await folderHandleForSong(slug); if (!dir) throw Object.assign(new Error('folder access needed'), { code: 'FOLDER_UNAVAILABLE' }); return await folderStore.readFile(dir, rel); }
  return await takeStore.readFile(rel);
}
function writeClipBytes(slug, file, bytes) {
  // takeStore.writeFile TRANSFERS the buffer to the worker, so it needs a transferable ArrayBuffer;
  // sliceWavBytes returns a Uint8Array. Hand over its exact backing buffer (copy if it's a subview).
  const buf = bytes instanceof Uint8Array
    ? (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer)
    : bytes;
  return takeStore.writeFile(takeModel.tapeDeckRef(slug).path + file, buf);
}
function barFramesOf(take) { return Math.round(takeModel.secPerBar(take) * (take.sampleRate || 48000)); }
// Run a clip edit: `build(take, slug)` returns { manifest, writes:[{file,bytes}], deletes:[file] }.
async function runClipEdit(build) {
  const a = activeSong();
  const take = (a && deckManifest && currentTake != null) ? deckManifest.takes.find((t) => t.take === currentTake) : null;
  if (!a || !take || deckRecording || deckBouncing || deckSaving) return;
  try {
    const plan = await build(take, a.id);
    if (!plan) return;
    for (const w of plan.writes || []) await writeClipBytes(a.id, w.file, w.bytes);
    deckManifest = plan.manifest;
    persistDeckManifest();
    for (const f of plan.deletes || []) takeStore.deleteSlotFiles(a.id, [f]).catch(() => {});
    if (tapeDeck) tapeDeck.invalidatePlayback();
  } catch (e) { surfaceReadError(e); return; }
  render();
}
const loadedLaneClips = (take, key) => takeModel.laneClips(take.stems[key]);
const clipOnLane = (manifest, key, id) => takeModel.laneClips(manifest.takes.find((t) => t.take === currentTake).stems[key]).find((c) => c.id === id);
// Commit an edited drum config to the loaded take (manifest + invalidate the cached playback graph
// so the next play rebuilds with the new config) or the new-take draft (localStorage). Same for click.
function commitDrums(next) {
  const t = editingDeckTake();
  if (t) {
    // Model-level lock: a recorded take's swing/pattern/source/sequence are immutable (they'd
    // drift the frozen drums against the cut audio); only sound-only fields apply. Not just a
    // disabled input — this is the real guard (also stops the legacy swing-post-record leak).
    const safe = lockDrumEdit(t.drums, next);
    deckManifest = { ...deckManifest, takes: deckManifest.takes.map((x) => (x.take === t.take ? { ...x, drums: safe } : x)) };
    persistDeckManifest();
    if (tapeDeck) tapeDeck.invalidatePlayback();
  } else { deckDrumDraft = next; writeDrumDefault(next); }
  render();
}
function commitClick(next) {
  const t = editingDeckTake();
  if (t) {
    const safe = lockClickEdit(t.click, next);   // bpm + timeSig locked once recorded
    deckManifest = { ...deckManifest, takes: deckManifest.takes.map((x) => (x.take === t.take ? { ...x, click: safe } : x)) };
    persistDeckManifest();
    if (tapeDeck) tapeDeck.invalidatePlayback();
  } else { deckClickDraft = next; writeClickDefault(next); }
  render();
}

// The master MONITOR volume (D35): an app-level monitor setting, NOT part of any take,
// never in the manifest, never in the bounce. Persisted like the click default. 0..1.5,
// default 1.0 (unity), clamped to match the per-track vol range.
const MASTER_KEY = 'sn_tape_master';
function clampMasterVol(v) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(1.5, n)) : 1.0; }
function readMasterVol() {
  try { const raw = localStorage.getItem(MASTER_KEY); if (raw != null) return clampMasterVol(JSON.parse(raw)); } catch { /* ignore */ }
  return 1.0;
}
function writeMasterVol(v) {
  try { localStorage.setItem(MASTER_KEY, JSON.stringify(clampMasterVol(v))); } catch { /* ignore */ }
}

// The audioEngine controller — created once, lazily (an AudioContext needs a
// user gesture), and never rebuilt. Its callbacks write into whatever DOM nodes
// `tapeLive` currently points at (refreshed every render by tapeView, exactly
// like makeSketchPlayer's single-slot setStatus) rather than through render().
function ensureTapeDeck() {
  if (tapeDeck) return tapeDeck;
  tapeDeck = makeTapeDeck({
    onLevels: applyLevels,
    onClock: applyClock,
    onStatus: handleDeckStatus,
    onWriteError: (message) => { deckStatus = { type: 'error', message: 'Storage error: ' + message }; render(); },
  });
  tapeDeck.setMasterVol(readMasterVol()); // apply the persisted monitor level (lands when the ctx opens)
  return tapeDeck;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---- meter merge layer: raw engine peaks (capture 10 Hz + playback/monitor ~12 Hz)
// -> smoothed, dB-spaced, clip-latched per-strip {lit, clip} the LED ladders consume,
// via meterModel (pure). Never goes through render(); writes only the live DOM refs. ----
let meterState = {};    // key ('stem1'..'stem4'|'master') -> { displayed, clip:{clipped,until} }
let meterLastMs = 0;
function meterKeyState(k) { return meterState[k] || (meterState[k] = { displayed: 0, clip: { clipped: false, until: 0 } }); }
function shapeKey(key, peak, nowMs, dtMs) {
  const st = meterKeyState(key);
  st.displayed = meterModel.decayPeak(st.displayed, peak, dtMs);
  st.clip = meterModel.clipState(st.clip, peak, nowMs);
  return { lit: meterModel.peakToLit(st.displayed, meterModel.METER_SEGMENTS), clip: st.clip.clipped };
}

function applyLevels(frame) {
  const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const dtMs = meterLastMs ? (nowMs - meterLastMs) : meterModel.CLIP_HOLD_MS;
  meterLastMs = nowMs;
  const recordingSet = new Set(deckRecordingSlotKeys);
  const perKey = {};
  const levels = frame.levels || {};
  for (const key of Object.keys(levels)) {
    // A strip being recorded takes ONLY its live input (capture); every other strip
    // takes playback/monitor. This keeps an armed input meter from flickering against
    // its own (silent) playback tap, and vice-versa.
    const isRec = recordingSet.has(key);
    if (isRec && frame.source !== 'capture') continue;
    if (!isRec && frame.source === 'capture') continue;
    perKey[key] = shapeKey(key, levels[key].peak, nowMs, dtMs);
  }
  let master = null;
  if (deckRecording) {
    // No summed node exists during record — approximate the master as the loudest of
    // this frame's strips (the capture frame carries the armed inputs).
    if (frame.source === 'capture') {
      let mp = 0; for (const key of Object.keys(levels)) mp = Math.max(mp, levels[key].peak);
      master = shapeKey('master', mp, nowMs, dtMs);
    }
  } else if (frame.master) {
    master = shapeKey('master', frame.master.peak, nowMs, dtMs);
  }
  if (tapeLive.setLevels) { tapeLive.setLevels(perKey, master); return; }   // new portastudio view
  // Transitional shim: the pre-overhaul view exposes per-slot .meterfill divs + timerEl.
  if (tapeLive.meterEls) {
    for (const key of Object.keys(perKey)) {
      const el = tapeLive.meterEls[key];
      if (el) { el.style.width = Math.round(perKey[key].lit * 100) + '%'; el.classList.toggle('clip', perKey[key].clip); }
    }
  }
}

function applyClock(clock) {
  if (tapeLive.setCounter) { tapeLive.setCounter(clock); return; }          // new portastudio view
  if (tapeLive.timerEl) tapeLive.timerEl.textContent = fmtClock(clock.elapsedSec); // transitional shim
}

// The controller's single onStatus slot (registered once, at ensureTapeDeck()).
// ASYNC and AWAITED by audioEngine.js's stop() before its own promise resolves
// — so a caller that does `await tapeDeck.stop()` (onStopTake) genuinely
// observes the finalized manifest + a completed render(), not a promise that
// settles before finalizeStoppedTake's own awaits have landed.
// 'ended' (playback finished) only touches the current render's inline status
// text; the various stop reasons are the ONE place a recording gets finalized
// into the manifest, whether Stop was tapped or the engine stopped itself
// (interruption, storage error).
async function handleDeckStatus(s) {
  if (s.type === 'ended') { if (tapeLive.setPlayStatus) tapeLive.setPlayStatus('Finished'); return; }
  if (s.type === 'blocked') { deckBlocked = true; render(); return; }
  if (s.type === 'no-free-slots') { deckStatus = { type: 'warn', message: 'No free tracks to record into — bounce a track or start a new take.' }; render(); return; }
  if (s.type === 'no-wake-lock') { deckStatus = { type: 'warn', message: 'Screen may lock during long takes (Wake Lock isn’t available on this browser).' }; render(); return; }
  if (s.type === 'stopped' || s.type === 'stopped-interrupted' || s.type === 'stopped-storage-error') {
    const message = s.type === 'stopped-interrupted' ? 'Recording stopped (interrupted).'
      : s.type === 'stopped-storage-error' ? 'Recording stopped (storage error).' : null;
    await finalizeStoppedTake(s, message);
  }
}

async function finalizeStoppedTake(s, message) {
  deckRecording = false;
  const passGroup = deckRecordingGroup;
  let emptied = false;
  if (deckManifest && deckManifest.slug === s.slug) {
    const captured = (s.durationSec || 0) > 0;
    if (deckRecordTimeline) {
      // Timeline pass: place each captured clip at the head, replacing whatever clips it reaches
      // (recordClip references the file record() already wrote by its injected id). An empty pass
      // just drops the pre-opened header-only files.
      const take0 = deckManifest.takes.find((t) => t.take === s.take);
      const spb = take0 ? takeModel.secPerBar(take0) : barSeconds(120, 2);
      const orphans = [];
      for (const k of (s.slotKeys || [])) {
        const id = deckRecordClipIds[k];
        const dur = (s.slotDurations && s.slotDurations[k]) || 0;
        if (!id || dur <= 0 || !captured) { if (id) takeStore.deleteSlotFiles(s.slug, [takeModel.clipFileName(s.slug, s.take, k, id)]).catch(() => {}); continue; }
        const bars = Math.max(1, Math.round(dur / spb));
        const r = takeModel.recordClip(deckManifest, s.take, k, { id, startBar: deckRecordHead, bars, durationSec: dur, group: passGroup });
        deckManifest = r.manifest;
        for (const f of r.removedFiles) orphans.push(f);
      }
      for (const f of orphans) takeStore.deleteSlotFiles(s.slug, [f]).catch(() => {});
      if (tapeDeck) tapeDeck.invalidatePlayback();
    } else if (!captured && passGroup != null) {
      // Nothing was committed this pass — e.g. Stop during the count-in, before the
      // capture gate opened. Free the just-armed slots instead of leaving 0-length
      // stems: discard this group, then either re-activate the take (earlier passes
      // survive) or tombstone it if that leaves no audio at all.
      deckManifest = takeModel.discardGroup(deckManifest, s.take, passGroup);
      const take = deckManifest.takes.find((t) => t.take === s.take);
      if (take && takeModel.takeHasAudio(take)) {
        deckManifest = takeModel.finalizePass(deckManifest, s.take, {}); // 'recording' -> 'active', keep earlier tracks
      } else {
        deckManifest = takeModel.discardTake(deckManifest, s.take);
        emptied = true;
      }
      takeStore.deleteSlotFiles(s.slug, (s.slotKeys || []).map((k) => takeModel.clipFileName(s.slug, s.take, k, 'g' + passGroup))).catch(() => {}); // best-effort: drop the empty header-only WAVs
    } else {
      // finalizePass sets this pass's per-slot durations, recomputes the take length,
      // and flips it active. Passes stay within one take now, so there's no take menu —
      // the just-finished take simply loads.
      deckManifest = takeModel.finalizePass(deckManifest, s.take, s.slotDurations || {});
    }
    await takeStore.writeManifest(manifestPath(s.slug), deckManifest);
  }
  if (emptied) {
    const kept = takeModel.mostRecentKeptTake(deckManifest);
    currentTake = kept ? kept.take : null;
    deckPendingNewTake = currentTake == null;
  } else {
    currentTake = s.take;
    deckPendingNewTake = false;
  }
  const wasTimeline = deckRecordTimeline;
  deckRecordingSlotKeys = [];
  deckRecordingGroup = null;
  deckRecordTimeline = false;
  deckRecordClipIds = {};
  // Mix: the just-recorded lanes are filled — clear the arm set. Timeline: keep the arm so you can
  // move the head and record the next clip without re-arming.
  if (!wasTimeline) deckArmed = [];
  deckStatus = message ? { type: 'warn', message } : null;
  await refreshSpaceWarning();
  render();
}

async function refreshSpaceWarning() {
  const est = await takeStore.estimateSpace();
  deckSpaceWarning = !!(est && est.available < 500 * 1024 * 1024); // §5.8: warn under ~500 MB
}

// Arm one recording PASS: either the first pass of a fresh "+ New take" container,
// or an overdub pass into the current take's free slots. The pass's slots are armed
// in the manifest and written BEFORE any OPFS stem file is opened (D22 crash-
// consistent ordering) — audioEngine.record()'s onPassOpen callback is where the
// capture channel count + sample rate are handed back the instant they're known.
//
// `deckArming` is a SYNCHRONOUS re-entrancy guard, set true before the first
// `await`. `deckRecording` alone isn't enough: it only flips true deep inside the
// async onPassOpen callback, well after getUserMedia/worklet-load have started,
// leaving a window for a fast double-tap to arm two passes off the same stale
// manifest snapshot.
// Roll the drum sequence ONCE and FREEZE it into a drum config for a new take (the algorithm's
// only impure roll — Math.random injected here so the pure model stays testable). Returns
// { ok, drumConfig, autoStopSec } or { ok:false, message } for a fail-fast BEFORE recording
// starts (so a bad ruleset can never strand the deck). realizeSequence is total, so it never
// throws; the guards here are for missing folder/algorithm and an over-long sequence.
function buildFrozenSequence(clickCfg) {
  const sd = deckSequenceDraft;
  if (!sd || !sd.loopFiles.length) return { ok: false, message: 'Pick a main-section loop folder first.' };
  if (!sd.algorithmId) return { ok: false, message: 'Choose a playback algorithm first.' };
  const ruleset = deckRulesets.find((r) => r.id === sd.algorithmId);
  if (!ruleset) return { ok: false, message: 'That algorithm is no longer available — pick another.' };
  const count = Math.max(1, sd.count | 0);
  const { order } = realizeSequence(sd.loopFiles.length, ruleset, count, Math.random);
  const loopMap = {};
  sd.loopPatterns.forEach((p, i) => { loopMap[i + 1] = p; });
  const flat = flattenRealizedSequence(order, { introPattern: sd.introPattern, loopPatterns: loopMap, outroPattern: sd.outroPattern });
  if (flat.bars > MAX_FLAT_BARS) return { ok: false, message: 'Sequence is too long (' + flat.bars + ' bars, max ' + MAX_FLAT_BARS + '). Lower the count.' };
  const bpm = (clickCfg && clickCfg.bpm) || 120;
  const tsi = (clickCfg && clickCfg.timeSigIndex != null) ? clickCfg.timeSigIndex : 2;
  const sequence = {
    folderName: sd.folderName || '', loopFiles: sd.loopFiles.slice(), algorithmId: sd.algorithmId,
    count, intro: sd.introName || null, outro: sd.outroName || null,
    timeSigIndex: tsi, realizedOrder: order, realizedBars: flat.bars,
  };
  const base = deckDrumDraft || readDrumDefault();
  const drumConfig = clampDrumConfig({ ...base, enabled: true, pattern: flat, source: { type: 'sequence' }, sequence });
  return { ok: true, drumConfig, autoStopSec: flat.bars * barSeconds(bpm, tsi) };
}

// Merge builtin + user rulesets (a user ruleset overrides a builtin of the same id), for the
// Algorithm dropdown and the record-time roll. Called at boot and after every import/delete.
function refreshRulesets() {
  const byId = new Map(builtinRulesets.map((r) => [r.id, r]));
  for (const u of loadUserRulesets()) byId.set(u.id, u);
  deckRulesets = [...byId.values()];
}

// Archive a picked intro/outro .mid to the song's OPFS loops temp + parse it (in the take's
// meter) into the draft. Parse BEFORE writeFile (writeFile transfers/detaches the buffer).
async function setSequenceIntroOutro(kind, name, getBytes) {
  const a = activeSong(); if (!a || !a.id) return;
  if (!deckSequenceDraft) deckSequenceDraft = makeEmptySequenceDraft();
  const tsi = currentClickBase().timeSigIndex != null ? currentClickBase().timeSigIndex : 2;
  const bytes = await getBytes();
  const pattern = smfToPattern(bytes, tsi).pattern;
  try { await takeStore.writeFile(takeModel.loopsRef(a.id) + name, bytes.buffer); } catch { /* temp write failed; pattern still loads */ }
  if (kind === 'intro') { deckSequenceDraft.introName = name; deckSequenceDraft.introPattern = pattern; }
  else { deckSequenceDraft.outroName = name; deckSequenceDraft.outroPattern = pattern; }
  render();
}

// The ←/→ audition list: [intro?, each main loop…, outro?].
function auditionListFor(sd) {
  const list = [];
  if (!sd) return list;
  if (sd.introPattern) list.push({ kind: 'intro', name: sd.introName, pattern: sd.introPattern });
  sd.loopPatterns.forEach((p, i) => list.push({ kind: 'loop', name: sd.loopFiles[i], pattern: p }));
  if (sd.outroPattern) list.push({ kind: 'outro', name: sd.outroName, pattern: sd.outroPattern });
  return list;
}
// Preview the currently-highlighted audition item once (no capture), via the throwaway machine.
function auditionPlayCurrent() {
  const list = auditionListFor(deckSequenceDraft);
  if (!list.length) return;
  const idx = Math.max(0, Math.min(list.length - 1, deckLoopAuditionIndex));
  const item = list[idx];
  const click = currentClickBase();
  const bpm = click.bpm || 120, tsi = click.timeSigIndex != null ? click.timeSigIndex : 2;
  const base = deckDrumDraft || readDrumDefault();
  const cfg = clampDrumConfig({ ...base, enabled: true, pattern: item.pattern, source: { type: 'grid' } });
  ensureTapeDeck().previewPattern({ config: cfg, bpm, timeSigIndex: tsi, durationSec: item.pattern.bars * barSeconds(bpm, tsi) });
}

async function armRecording() {
  if (deckArming || deckRecording || deckSaving) return;
  const a = activeSong();
  if (!a || !a.id || !deckManifest) return;
  deckArming = true;
  deckStatus = null;
  // A recording needs a saved .json to live beside (its folder is granted at Save). If the
  // song has no .json yet, prompt to save it first — then proceed (decision 5).
  if (!(await ensureSongJsonSaved())) {
    deckArming = false;
    deckStatus = { type: 'warn', message: 'Save the song first — a recording needs a saved .json to live beside.' };
    render();
    return;
  }
  const slug = a.id;
  const path = manifestPath(slug);
  const isTimeline = deckTab === 'timeline'; // Timeline record: clips land at the head, replace-region, arm any lane
  const headBar = isTimeline ? deckHead : 0;
  await refreshSpaceWarning(); // §5.8: "before each record", not just on deck open / after the last take

  // New take vs overdub into the current take. `baseTake` is the container being
  // filled (null for a fresh take); freeKeys are its recordable slots.
  const isNew = deckPendingNewTake || currentTake == null;
  const baseTake = isNew ? null : (deckManifest.takes.find((t) => t.take === currentTake) || null);
  // Timeline arms ANY lane (filled clips get replaced at the head); Mix/new-take arms free lanes only.
  const freeKeys = (isTimeline || isNew) ? takeModel.STEM_KEYS.slice() : (baseTake ? takeModel.freeSlotKeys(baseTake) : []);
  // Build the per-CHANNEL routing (indexed by interface input; null = that input isn't
  // armed to any track, captured only for its meter) from the armed set. Guard: nothing
  // armed -> nothing to record.
  const channels = (deckInputs && deckInputs.channels) || 1;
  const armedNow = normalizeArmed(deckArmed, freeKeys, channels, Math.min(channels, freeKeys.length, takeModel.MAX_TRACKS));
  if (!armedNow.length) { deckArming = false; return; }
  const maxIdx = Math.max.apply(null, armedNow.map((x) => x.inputIndex));
  const routing = new Array(maxIdx + 1).fill(null);
  armedNow.forEach((x) => { routing[x.inputIndex] = x.slotKey; });
  // The take's already-recorded tracks play as backing while overdubbing (empty for
  // a first pass); latency-aligned via the measured monitor round-trip.
  // Timeline v1 records without arrangement monitoring (no backing — the captured DI is what matters);
  // Mix overdub plays the take's filled tracks as backing.
  const existingTracks = isTimeline ? [] : (baseTake ? takeModel.filledSlotKeys(baseTake) : []).map((k) => ({ key: k, meta: baseTake.stems[k] }));
  // Overdub backing may include tracks already Saved to the folder — resolve (and require)
  // the folder handle when any backing track is folder-located, so it can be monitored.
  const needsFolder = existingTracks.some((t) => takeModel.slotLoc(t.meta) === 'folder');
  const folderHandle = needsFolder ? await folderHandleForSong(slug) : null;
  if (needsFolder && !folderHandle) {
    deckArming = false;
    deckStatus = { type: 'error', message: 'Grant folder access to overdub onto a saved take.' };
    render();
    return;
  }
  // The metronome config for this pass: the new-take draft for a first pass, else the
  // take's locked config (overdubs share the take's tempo). Drives the count-in + click
  // AND is stamped onto the take at creation.
  const clickCfg = (baseTake && baseTake.click) || (deckClickDraft || readClickDefault()); // take's locked tempo, else the draft
  // The drum backing for this pass: the new-take draft for a first pass, else the take's locked
  // drums (overdubs share the take's backing). Timeline v1 uses no drum backing. bpm/meter come
  // from the click config (shared tempo).
  let drumCfg = isTimeline ? null : (isNew ? (deckDrumDraft || readDrumDefault()) : (baseTake && baseTake.drums));
  // A new take in SEQUENCE mode rolls + flattens the sequence NOW (fail-fast before recording),
  // freezing it onto the take; autoStopSec makes the record auto-stop at the sequence end.
  let autoStopSec = null;
  if (isNew && !isTimeline && deckDrumMode === 'sequence') {
    const built = buildFrozenSequence(clickCfg);
    if (!built.ok) { deckArming = false; deckStatus = { type: 'warn', message: built.message }; render(); return; }
    drumCfg = built.drumConfig;
    autoStopSec = built.autoStopSec;
  }

  let started = false;
  try {
    const result = await ensureTapeDeck().record({
      slug,
      deviceId: deckSelectedInputId,
      routing,
      monitorLatencySec: getMonitorLatencySec(),
      monitorLatencySource: readLatency(deckSelectedInputId).source, // 'measured'|'manual'|'none' — 'none' -> record() auto-estimates
      existingTracks,
      clickConfig: clickCfg,
      drumConfig: drumCfg,
      autoStopSec,
      folderHandle,
      onPassOpen: async (capture, sampleRate) => {
        // Resolve this pass's destination slots from the routing (skip null/discard
        // channels, dedup, cap at the real captured channel count, only into free slots).
        const slotKeys = [];
        for (const k of routing) { if (k && freeKeys.includes(k) && !slotKeys.includes(k) && slotKeys.length < capture) slotKeys.push(k); }
        let takeNo, group;
        if (isNew) {
          takeNo = takeModel.nextTakeNumber(deckManifest);
          group = 1;
          deckManifest = takeModel.appendTake(deckManifest, takeModel.makeTake({ take: takeNo, sampleRate, click: clickCfg, drums: drumCfg }, nowISO()));
          if (isTimeline) deckManifest = takeModel.finalizePass(deckManifest, takeNo, {}); // a fresh timeline take starts active/empty; clips land at finalize
        } else {
          takeNo = currentTake;
          group = takeModel.nextGroup(baseTake);
        }
        const files = {};
        if (isTimeline) {
          // Timeline pass: allocate a fresh clip id + file per armed lane and open those files now;
          // the lane clips are NOT touched until finalize, where recordClip places the clip at the
          // head and replaces whatever it reaches (so the lane never holds an overlapping clip mid-record).
          deckRecordTimeline = true;
          deckRecordHead = headBar;
          deckRecordClipIds = {};
          for (const k of slotKeys) { const id = newClipId(); deckRecordClipIds[k] = id; files[k] = takeModel.clipFileName(slug, takeNo, k, id); }
        } else {
          deckRecordTimeline = false;
          deckManifest = takeModel.appendPassTracks(deckManifest, takeNo, slotKeys, group);
          // The clip filenames just armed — record() opens these (per-clip files, not stemFileName).
          const armedTake = deckManifest.takes.find((t) => t.take === takeNo);
          for (const k of slotKeys) { const c = armedTake && armedTake.stems[k] && armedTake.stems[k].clips[0]; if (c) files[k] = c.file; }
        }
        await takeStore.writeManifest(path, deckManifest);
        deckRecording = true;
        deckPendingNewTake = false;
        deckRecordingSlotKeys = slotKeys;
        deckRecordingGroup = group;
        currentTake = takeNo;
        render();
        return { take: takeNo, slotKeys, files };
      },
    });
    started = !!(result && result.ok);
    if (result && !result.ok && result.denied) deckBlocked = true;
  } catch {
    // A failure AFTER onPassOpen already flipped deckRecording=true (e.g.
    // AudioWorkletNode construction or openTakeFiles rejecting) would otherwise
    // strand the UI nav-locked forever.
    deckStatus = { type: 'error', message: 'Could not start recording (setup failed).' };
  } finally {
    deckArming = false;
    if (!started) { deckRecording = false; deckRecordingSlotKeys = []; deckRecordingGroup = null; } // only clobber on failure
    render();
  }
}

const handlers = {
  onChange: (patch) => { genFlash = null; state = validate({ ...state, ...patch }, feelIds); commit(); },
  onRandomize: () => { genFlash = null; state = validate({ ...state, ...randomize(Math.random, feelIds) }, feelIds); commit(); },

  // Import a pasted/uploaded feel JSON. Returns { ok, name } or { ok:false, error }.
  onImportText: (text) => {
    let obj;
    try { obj = JSON.parse(text); } catch { return { ok: false, error: 'not valid JSON' }; }
    const v = validateFeel(obj);
    if (!v.ok) return { ok: false, error: v.errors[0] };
    const feel = normalizeFeel(obj);
    if (builtinFeels.some((b) => b.id === feel.id)) return { ok: false, error: 'id "' + feel.id + '" is a built-in feel; rename it' };
    userFeels = userFeels.filter((u) => u.id !== feel.id).concat(feel); // replace same-id user feel
    saveUserFeels(userFeels);
    recompute();
    state = validate({ ...state, feel: feel.id }, feelIds);
    commit();
    return { ok: true, name: feel.name };
  },

  onDeleteFeel: (id) => {
    userFeels = userFeels.filter((u) => u.id !== id);
    saveUserFeels(userFeels);
    recompute();
    if (!feelIds.includes(state.feel)) state = validate({ ...state, feel: DEFAULT_FEEL }, feelIds);
    commit();
  },

  onExportCurrent: () => {
    const f = feelsById[state.feel];
    if (f) download(f.id + '.json', toFeelFile(f));
  },
  onExportAll: () => download('songwriter-feels.json', feelList.map(toFeelFile)),

  // ---- tabs ----
  onTab: (tab) => { if (deckRecording) return; genFlash = null; currentView = tab; render(); }, // AC-27: top tab strip inert while recording

  // ---- create a song / add to the open song from checked generator rows ----
  onCreateSong: (indices) => {
    const snaps = snapshotsFor(indices);
    if (!snaps.length) return;
    // Name up front: stash the captured snapshots and prompt for a name on the Songs tab.
    pendingNew = { snaps };
    currentSongId = null;
    currentSketchId = null;
    sketchFlash = null;
    songFlash = null;
    currentView = 'songs';
    genFlash = null;
    resetTapeDeckUi();
    render();
  },
  onAddToCurrent: (indices) => {
    if (!activeSong()) return;
    const snaps = snapshotsFor(indices);
    if (!snaps.length) return;
    updateActive((s, now) => appendProgressions(s, snaps, now));
    genFlash = '✓ Added to ' + activeSong().name;
    render();
  },

  // ---- the Songs tab ----
  songs: {
    onSelectSong: (target) => {
      genFlash = null;
      songFlash = null;
      pendingNew = null;
      currentSongId = target || null;
      currentSketchId = null;
      sketchFlash = null;
      resetTapeDeckUi();
      render();
    },
    onSetLabel: (i, lblValue) => { updateActive((s, now) => setProgressionLabel(s, i, lblValue, now)); render(); },
    onReorder: (i, dir) => { updateActive((s, now) => reorderProgression(s, i, dir, now)); render(); },
    onRemoveProgression: (i) => { updateActive((s, now) => removeProgression(s, i, now)); render(); },
    onCopyProgression: (i) => { updateActive((s, now) => copyProgression(s, i, now)); render(); },

    // ---- hand-editing: build a song by hand in the Songs tab ----
    // Name up front: prompt for a name, then onConfirmNewSong creates + persists + selects.
    onNewSong: () => {
      pendingNew = { snaps: null };   // null → seed one blank C-major row on confirm
      currentSongId = null;
      currentSketchId = null;
      sketchFlash = null;
      songFlash = null;
      currentView = 'songs';
      genFlash = null;
      resetTapeDeckUi();
      render();
    },
    // Confirm the name for a pending new song: build it (from captured snapshots or a seeded
    // blank row), assign a unique id, then choose a save location and write its .json — the
    // same openJsonSink/writeJsonSink path as Save. A song is committed to sn_songs, linked,
    // and opened ONLY after the write succeeds, so a created song always has a written .json;
    // cancelling the location dialog (or the iOS share sheet) or a write failure creates
    // nothing. This is the one create path (the New button and Progressions' Create song).
    onConfirmNewSong: async (name) => {
      if (!pendingNew) return;
      const now = nowISO();
      const finalName = (name && String(name).trim()) ? String(name).trim() : nextUntitledName(songs.map((s) => s.name));
      const base = pendingNew.snaps
        ? appendProgressions(createSong(now), pendingNew.snaps, now)
        : appendRow(createSong(now), cMajor(), now);
      const finalized = finalizeDraft(base, finalName, songs.map((s) => s.id), now);

      // Open the save location FIRST (no await precedes it, so the File System Access dialog
      // keeps its transient activation from the Create click).
      const sink = await openJsonSink(finalized.id + '.json');
      if (!sink) return;   // desktop picker dismissed → no song, name card stays
      try {
        const bundle = await toSongBundle(finalized);              // fresh song → empty audio map
        if (!(await writeJsonSink(sink, bundle))) return;          // iOS share sheet dismissed → no song
        const savedName = (sink.handle && sink.handle.name) || sink.name || (finalized.id + '.json');
        if (sink.handle) await rememberHandle(finalized.id, sink.handle);
        songs = songs.concat({ ...finalized, file: { name: savedName } });
        saveSongs(songs);
        currentSongId = finalized.id;
        pendingNew = null;
        songFlash = { ok: true, name: savedName };
        render();
      } catch {
        songFlash = { ok: false, error: 'could not save the song file' };
        render();   // pendingNew stays set → name card + error shown, user can retry
      }
    },
    onCancelNewSong: () => { pendingNew = null; render(); },
    onNewRow: () => { updateActive((s, now) => appendRow(s, cMajor(), now)); render(); },
    onAddChord: (i) => { updateActive((s, now) => addChord(s, i, cMajor(), now)); render(); },
    onSetChord: (i, j, chord) => { updateActive((s, now) => setChord(s, i, j, chord, now)); render(); },
    onRemoveChord: (i, j) => { updateActive((s, now) => removeChord(s, i, j, now)); render(); },

    // Capture lyrics without re-rendering (keeps the textarea caret); autosaves a saved song.
    onLyricsChange: (text) => { updateActive((s, now) => setLyrics(s, text, now)); },

    // ---- sketches (audio attachments) ----
    // Add an .m4a: write the BYTES to IndexedDB first, then (if the same song is still
    // active) the metadata to localStorage — so a mid-op failure never leaves metadata
    // pointing at a missing blob. The audio never touches localStorage.
    onAddSketch: async (file) => {
      sketchFlash = null;
      const check = isAcceptedAudio(file.name, file.type);
      if (!check.ok) { sketchFlash = { ok: false, error: check.error }; render(); return; }
      if (file.size > 25 * 1024 * 1024) { sketchFlash = { ok: false, error: 'That file is too large (25 MB max).' }; render(); return; }
      if (!activeSong()) return;
      const beforeId = currentSongId;
      const id = newSketchId();
      try { await ensurePersist(); await audioStore.putBlob(id, file); }
      catch { sketchFlash = { ok: false, error: 'Could not store audio (storage full or unavailable).' }; render(); return; }
      // Only commit metadata if the intended song is still the active one.
      const stillSame = currentSongId === beforeId && songs.some((s) => s.id === beforeId);
      if (!stillSame) { audioStore.deleteBlob(id).catch(() => {}); return; }
      updateActive((s, now) => addSketchMeta(s, makeSketchMeta({ id, filename: file.name, mimeType: file.type, size: file.size }, now), now));
      currentSketchId = id;
      sketchFlash = { ok: true, name: file.name };
      render();
    },

    onSelectSketch: (id) => { currentSketchId = id; render(); },

    // Delete: drop the METADATA first (removes the reference), then best-effort delete the
    // blob. An orphaned blob is garbage-collected by reconcileSketches on next load.
    onDeleteSketch: (id) => {
      updateActive((s, now) => removeSketchMeta(s, id, now));
      if (currentSketchId === id) currentSketchId = null;
      sketchFlash = null;
      render();
      audioStore.deleteBlob(id).catch(() => {});
    },

    // Capture sketch notes without re-rendering (keeps the caret) — the lyrics pattern.
    onSketchNotesChange: (id, text) => { updateActive((s, now) => setSketchNotes(s, id, text, now)); },

    // Load a sketch's audio blob for the inline player (impure; IndexedDB).
    onLoadSketchBlob: (id) => audioStore.getBlob(id),

    onRenameSong: (name) => {
      const nm = name && String(name).trim();
      if (!nm || !currentSongId) { render(); return; }
      songs = songs.map((s) => (s.id === currentSongId ? renameSong(s, nm, nowISO()) : s));
      saveSongs(songs);
      render();
    },
    onDeleteSong: (id) => {
      const gone = songs.find((s) => s.id === id);
      songs = songs.filter((s) => s.id !== id);
      saveSongs(songs);
      if (currentSongId === id) { currentSongId = null; currentSketchId = null; sketchFlash = null; songFlash = null; resetTapeDeckUi(); }
      render();
      // Best-effort: drop the deleted song's save-in-place handles (session + IndexedDB):
      // the .json handle (keyed by id) and the .md companion handle (id + '::md').
      fileHandles.delete(id);
      audioStore.deleteFileHandle(id).catch(() => {});
      fileHandles.delete(id + '::md');
      audioStore.deleteFileHandle(id + '::md').catch(() => {});
      // Best-effort: drop the deleted song's audio blobs (reconcile also GCs them later).
      if (gone && gone.sketches && gone.sketches.length) audioStore.deleteMany(gone.sketches.map((sk) => sk.id)).catch(() => {});
      // §5.7: also GC its OPFS take directory (no boot-time GC, D30 — deletion is
      // the one place a song's takes get removed, immediately, with confirm).
      if (gone && gone.tapeDeck) { takeStore.deleteSongTakes(gone.id).catch(() => {}); takeStore.deleteSongMidi(gone.id).catch(() => {}); takeStore.deleteSongLoops(gone.id).catch(() => {}); }
    },

    // Duplicate the open song into a directory the user picks, then switch to the copy. Writes a
    // self-contained folder <newId>/ inside the chosen parent — <newId>.json plus takes/midi/loops
    // — with every id-bearing reference rewritten to the new slug, so it re-opens independently.
    // Recordings come from the SOURCE song's on-disk folder (the durable Saved snapshot; the song
    // record alone may carry no tapeDeck.takes), projected via projectTakesForJson so only active,
    // folder-saved takes travel (unsaved OPFS takes / discarded tombstones don't). Desktop-Chrome
    // only (File System Access). Runs under the ✓-click gesture (showDirectoryPicker + permission).
    onDupeSong: async (rawName) => {
      const a = activeSong();
      if (!a || !a.id) return;
      const name = String(rawName || '').trim();
      if (!name) { songFlash = { ok: false, msg: 'Give the duplicate a name.' }; render(); return; }
      if (typeof window === 'undefined' || !window.showDirectoryPicker) {
        songFlash = { ok: false, msg: 'Duplicate needs desktop Chrome (folder access).' }; render(); return;
      }
      const newId = slugifySongId(name, songs.map((s) => s.id));

      // 1. Pick the PARENT directory, then create the song's own <newId>/ folder inside it (so the
      //    copy lands as a subfolder of the chosen dir, not loose files in it).
      let parent, newDir;
      try {
        const startIn = await handleForSong(a.id);
        const opts = { id: 'sn-song-folder', mode: 'readwrite' };
        if (startIn) opts.startIn = startIn;
        parent = await window.showDirectoryPicker(opts);
        if (!(await folderStore.ensurePermission(parent))) { songFlash = { ok: false, msg: 'Folder access was declined.' }; render(); return; }
        newDir = await parent.getDirectoryHandle(newId, { create: true });
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // cancelled the picker → no-op
        songFlash = { ok: false, msg: 'Could not open the destination folder (' + ((e && e.message) || 'error') + ').' }; render(); return;
      }

      try {
        if (await folderStore.fileExists(newDir, newId + '.json')) {
          songFlash = { ok: false, msg: 'A song folder named “' + newId + '” already exists there — pick another name.' }; render(); return;
        }

        // 2. Decide WHICH takes travel BEFORE writing anything durable. planDupeTakes sources them from
        //    the source's embedded tapeDeck.takes ELSE its (recovered) folder manifest ELSE a folder scan
        //    — so a LEGACY source whose takes live only in the folder is not silently lost (H1). Copying
        //    the WAVs needs the source folder granted; under this ✓ gesture we can prompt for it.
        const srcHandle = await handleForSong(dirKey(a.id));   // the source's persisted folder handle
        const srcDir = srcHandle && (await folderStore.ensurePermission(srcHandle)) ? srcHandle : null;
        let folderManifest = null; let folderFiles = null;
        if (srcDir) {
          try { const bytes = await folderStore.readFile(srcDir, manifestPath(a.id)); folderManifest = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))); } catch { /* no legacy manifest */ }
          if (!folderManifest) { try { folderFiles = await folderStore.listDir(srcDir, takeModel.tapeDeckRef(a.id).path); } catch { /* unlistable */ } }
        }
        const plan = planDupeTakes({ embeddedTakes: (a.tapeDeck && a.tapeDeck.takes) || [], folderManifest, folderFiles, srcId: a.id, newId });

        // The source HAS takes but we can't read its folder to copy them: REFUSE rather than mint a
        // half-copy whose .json swears takes exist while the folder is empty (H2). Remove the empty
        // <newId>/ we just created so a same-name retry isn't wedged (H9), then tell the user.
        if (plan.needsSourceGrant && !srcDir) {
          try { await parent.removeEntry(newId, { recursive: true }); } catch { /* best effort */ }
          songFlash = { ok: false, msg: 'Grant “' + a.id + '”’s folder so its takes can be copied, then Dupe again.' };
          render();
          return;
        }

        // 3. Copy each sketch's audio blob under a FRESH id, so the copy owns private bytes
        //    (mirrors importOneSong; a sketch whose blob is missing is dropped).
        const sketchIdMap = {};
        for (const sk of (a.sketches || [])) {
          let blob;
          try { blob = await audioStore.getBlob(sk.id); } catch { blob = null; }
          if (!blob) continue;
          const nid = newSketchId();
          try { await audioStore.putBlob(nid, blob); sketchIdMap[sk.id] = nid; } catch { /* write failed → drop this sketch */ }
        }

        // 4. Copy the take WAVs (+ provenance MIDI/loops) resiliently: a missing/partial source WAV
        //    skips just that slot (H3), never aborting the whole Dupe. Then prune the copy's tapeDeck to
        //    ONLY the files that actually landed (H2), so the embedded .json never refs a missing WAV.
        let recFlash = '';
        let tapeDeck = null;
        if (srcDir && plan.copies.length) {
          const copied = new Set();
          for (const c of plan.copies) {
            try { await folderStore.writeFile(newDir, c.dst, await folderStore.readFile(srcDir, c.src)); copied.add(c.dstFile); }
            catch { /* missing/partial source WAV — skip; pruneTapeDeckToCopied flags the take recovered */ }
          }
          for (const c of plan.midiCopies) { try { await folderStore.writeFile(newDir, c.dst, await folderStore.readFile(srcDir, c.src)); } catch { /* provenance only */ } }
          for (const c of plan.loopCopies) { try { await folderStore.writeFile(newDir, c.dst, await folderStore.readFile(srcDir, c.src)); } catch { /* provenance only */ } }
          const pruned = pruneTapeDeckToCopied(plan.tapeDeck, copied);
          if (pruned.takes.length) { tapeDeck = pruned; recFlash = ' + ' + pruned.takes.length + ' take' + (pruned.takes.length === 1 ? '' : 's'); }
          else recFlash = ' (recordings could not be copied)';
        }

        // 5. Build the duplicate record with the copied tapeDeck embedded (SSOT), and write its .json
        //    (which carries the freshly-copied sketch audio + tapeDeck.takes). No folder manifest is written.
        const dup = duplicateSong(a, { id: newId, name, now: nowISO(), sketchIdMap, tapeDeck });
        await folderStore.writeFile(newDir, newId + '.json', JSON.stringify(await toSongBundle(dup), null, 2));

        // 6. Link handles + switch to the copy (commit to app state only after every write).
        try { await rememberHandle(newId, await newDir.getFileHandle(newId + '.json')); } catch { /* handle persist is best-effort */ }
        await rememberHandle(dirKey(newId), newDir);
        songs = songs.concat(dup);
        saveSongs(songs);
        currentSongId = newId;
        currentSketchId = null;
        sketchFlash = null;
        resetTapeDeckUi();
        songFlash = { ok: true, msg: 'Duplicated to “' + newId + '/”' + recFlash + '.' };
        render();
      } catch (e) {
        songFlash = { ok: false, msg: 'Duplicate failed (' + ((e && e.message) || 'write error') + '). Delete the partial “' + newId + '/” folder and retry.' };
        render();
      }
    },

    // Save the current song's .json. Linked + File System Access → overwrite in place,
    // silently. Otherwise open the platform save flow (desktop picker, else Save to Files /
    // share / download) and link the song to the file it lands in.
    onSaveSongFile: async () => {
      const a = activeSong();
      if (!a || !a.id) return;
      const bundle = await toSongBundle(a);

      // 1. Silent overwrite when we hold a usable handle (desktop, already linked).
      const existing = await handleForSong(a.id);
      if (existing && await ensureHandleWritable(existing)) {
        try {
          await writeJsonSink({ handle: existing }, bundle);
          songFlash = { ok: true, name: (a.file && a.file.name) || (a.id + '.json') };
          render();
          return;
        } catch { /* handle went stale (file moved/deleted) → fall through to re-pick */ }
      }

      // 2. First save (or no usable handle): choose name + destination.
      const suggested = (a.file && a.file.name) || (a.id + '.json');
      const sink = await openJsonSink(suggested);
      if (!sink) return;   // cancelled the save dialog
      await writeJsonSink(sink, bundle);
      const savedName = (sink.handle && sink.handle.name) || sink.name || suggested;
      if (sink.handle) await rememberHandle(a.id, sink.handle);
      songs = songs.map((s) => (s.id === a.id ? { ...s, file: { name: savedName } } : s));
      saveSongs(songs);
      songFlash = { ok: true, name: savedName };
      render();
    },

    // Export the current song as a cleanly formatted .md companion, next to its .json.
    // Mirrors onSaveSongFile: silent in-place overwrite once a .md location is chosen
    // (desktop), else the platform save/share flow (iOS "Save to Files" / download). The
    // .md handle is retained under a DISTINCT key (a.id + '::md') so it never collides with
    // the song's .json handle (keyed by a.id).
    onExportMd: async () => {
      const a = activeSong();
      if (!a || !a.id) return;
      const md = toMarkdown(a);
      const mdName = a.id + '.md';
      const mdKey = a.id + '::md';

      // 1. Silent overwrite when we already hold a usable .md handle (desktop).
      const existing = await handleForSong(mdKey);
      if (existing && await ensureHandleWritable(existing)) {
        try {
          await writeMdSink({ handle: existing }, md);
          songFlash = { ok: true, name: existing.name || mdName };
          render();
          return;
        } catch { /* handle went stale (file moved/deleted) → fall through to re-pick */ }
      }

      // 2. First export (or no usable handle): pick a location, defaulting to the song's
      //    own folder (startIn = the retained .json handle where we have one).
      const jsonHandle = await handleForSong(a.id);
      const sink = await openMdSink(mdName, jsonHandle);
      if (!sink) return;   // cancelled the save dialog
      await writeMdSink(sink, md);
      if (sink.handle) await rememberHandle(mdKey, sink.handle);
      songFlash = { ok: true, name: (sink.handle && sink.handle.name) || sink.name || mdName };
      render();
    },

    // Open a song from a .json. Desktop path: showOpenFilePicker gives a handle we retain
    // (so Save overwrites it in place). Called by the view only where the API exists.
    onOpenSongPicker: async () => {
      if (typeof window === 'undefined' || !window.showOpenFilePicker) return;
      let handles;
      try {
        handles = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'Songwriter JSON', accept: { 'application/json': ['.json'] } }],
        });
      } catch { return; }   // AbortError (cancelled) or unsupported
      const handle = handles && handles[0];
      if (!handle) return;
      let text;
      try { const f = await handle.getFile(); text = await f.text(); }
      catch { songFlash = { ok: false, error: 'could not read that file' }; render(); return; }
      const res = await importSongsFromText(text, 'open'); // Open of one's own .json: keep id + tapeDeck.takes
      if (res.ok && res.count === 1) await rememberHandle(res.ids[0], handle);
      afterOpen(res, handle.name);
    },

    // Open a song from text read via a hidden <input type=file> (iOS / Chrome Android /
    // any no-File-System-Access platform). No handle, so the link is name-only.
    onOpenSongText: async (text, filename) => {
      const res = await importSongsFromText(text, 'open'); // Open of one's own .json: keep id + tapeDeck.takes
      afterOpen(res, filename || null);
    },

    // ---- tape deck (§5.6/§5.7) ----

    onOpenTapeDeck: async () => {
      const a = activeSong();
      if (!a || !a.id) return;                          // no song selected -> no OPFS path (§5.8)
      // A generation token: onSelectSong/onNewSong/onDeleteSong/onOpenSong* (all
      // synchronous) bump deckOpenSeq via resetTapeDeckUi, and a second, later
      // onOpenTapeDeck call bumps it again here — either invalidates this call.
      // Without this, a song switch mid-await lets this continuation's stale
      // `a`/`manifest` clobber the NEW song's shared deck state (deckManifest,
      // currentTake) and — worse — stamp the wrong tapeDeck.path onto whichever
      // song happens to be active when the late `updateActive` call lands.
      const mySeq = ++deckOpenSeq;
      const stale = () => deckOpenSeq !== mySeq;

      songSubView = 'tapedeck';
      deckStatus = null;
      deckPendingNewTake = false;
      deckArmed = [];
      deckPanelOpen = null;
      deckLogOpen = false;
      deckRecordingSlotKeys = [];
      deckRecordingGroup = null;
      render();

      if (!(await takeStore.isSupported())) { if (!stale()) { deckUnsupported = true; render(); } return; }
      if (stale()) return;
      deckUnsupported = false;

      await ensurePersist();
      if (stale()) return;
      const path = manifestPath(a.id);
      const savedTakes = (a.tapeDeck && Array.isArray(a.tapeDeck.takes)) ? a.tapeDeck.takes : [];
      const folderDirHandle = await handleForSong(dirKey(a.id)); // remembered handle (may be null); permission checked below
      if (stale()) return;
      const folderGrantedNow = await folderStore.queryOnly(folderDirHandle); // query only — NEVER prompt off this passive open
      if (stale()) return;

      // The multi-store reconciliation is a pure decision (deckRestore.resolveDeckRestore) driven by
      // a dependency-injected orchestrator (runDeckRestore), so the exact precedence, the reboot-hole
      // recover offer, the legacy folder read-then-DELETE-on-contact, and the crash-safe write order all
      // run in the node engine test (§14b). main.js supplies only the I/O ports + the stale-guarded UI.
      // The take AUDIO stays in the folder; every write here is by-id, so a song switch mid-await writes
      // the correct song and the shared deck-state assignment below is stale-guarded.
      const ports = {
        readOpfsManifest: (p) => takeStore.readManifest(p),               // throws when evicted (vs. readable-but-empty)
        readFolderManifest: async () => {
          try { const bytes = await folderStore.readFile(folderDirHandle, manifestPath(a.id)); return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))); }
          catch { return null; }                                         // the ONE legacy folder-manifest read
        },
        recoverPass: (m) => recoverInterruptedPasses(m, a.id),
        stampTapeDeck: (id, td) => updateActive((s, now) => (s.id === id ? { ...s, tapeDeck: td, updatedAt: now } : s)),
        stampTapeDeckRef: (id) => updateActive((s, now) => (s.id === id ? { ...s, tapeDeck: takeModel.tapeDeckRef(id), updatedAt: now } : s)),
        writeSongJson: (id) => writeSongJsonById(id),                    // returns true only on a VERIFIED write (gates the delete)
        deleteFolderManifest: async () => { try { await folderStore.deleteFile(folderDirHandle, manifestPath(a.id)); } catch { /* best effort */ } },
        writeOpfsManifest: (p, m) => takeStore.writeManifest(p, m),
      };
      const res = await runDeckRestore(
        { slug: a.id, path, savedTakes, folderGranted: folderGrantedNow, hasFolderHandle: !!folderDirHandle, hasTapeDeckRef: !!a.tapeDeck },
        ports,
      );
      if (stale()) return;

      deckManifest = res.manifest;
      deckClickDraft = readClickDefault();
      deckDrumDraft = readDrumDefault();
      deckDrumBar = 0;
      const kept = takeModel.mostRecentKeptTake(res.manifest);
      currentTake = kept ? kept.take : null;

      deckHasJsonHandle = !!(await handleForSong(a.id));
      if (stale()) return;
      deckHasFolderHandle = !!folderDirHandle;
      // The take LIST always renders. The folder is needed only to PLAY saved audio (needsGrant) or to
      // RECOVER an empty deck whose folder MAY hold takes (offerRecover, the reboot-hole path). One
      // banner covers both; onGrantFolder re-runs this open, which then reads + folds the folder copy.
      deckFolderNeedsGrant = res.needsGrant || res.offerRecover;
      deckOfferRecover = res.offerRecover;
      if (res.offerRecover) {
        deckStatus = { type: 'info', message: 'This song may have saved takes in its folder — grant folder access to recover them.' };
      } else if (res.source === 'json' || res.source === 'folder') {
        const n = res.manifest.takes.filter((t) => t.status === 'active' && takeModel.takeHasAudio(t)).length;
        deckStatus = res.needsGrant
          ? { type: 'info', message: 'Restored ' + n + ' saved take' + (n === 1 ? '' : 's') + ' from the song — grant folder access to play their audio.' }
          : { type: 'warn', message: 'Restored ' + n + ' saved take' + (n === 1 ? '' : 's') + '; any unsaved takes could not be recovered.' };
      }

      await refreshSpaceWarning();
      if (stale()) return;

      const probeResult = await ensureTapeDeck().probe(deckSelectedInputId);
      if (stale()) return;
      if (!probeResult.ok) { deckBlocked = true; render(); return; }
      deckBlocked = false;
      deckInputs = probeResult;
      if (!deckSelectedInputId) deckSelectedInputId = probeResult.preselectedId;
      render();
    },

    // Re-grant the song's folder (once per session) so restored takes can PLAY their audio. Runs off
    // a fresh user gesture (the Grant button), so requestPermission keeps transient activation — the
    // reason the deck-open path only queries, never prompts. On success we re-run the deck open, which
    // now finds the folder granted → restores from the folder copy and re-seeds OPFS; on failure we
    // surface a classified, actionable status (the take list stays put — only playback was blocked).
    onGrantFolder: async () => {
      const a = activeSong();
      if (!a || !a.id) return;
      const dir = await handleForSong(dirKey(a.id));
      const { state } = await folderStore.probePermission(dir);
      if (state === 'granted') { await handlers.onOpenTapeDeck(); return; }
      deckStatus = {
        type: 'error',
        message: state === 'stale' ? 'The song folder moved or was removed — re-Save to relink it.'
          : state === 'unsupported' ? 'Saved-take playback needs desktop Chrome.'
          : state === 'nohandle' ? 'No folder is linked yet — Save the takes to pick the song’s folder.'
          : 'Folder access denied — saved takes stay listed but can’t play until you grant access.',
      };
      render();
    },

    onCloseTapeDeck: () => {
      if (deckRecording) return; // AC-27
      songSubView = 'sections';
      if (tapeDeck) tapeDeck.stopPlay();
      deckPendingNewTake = false;
      deckPanelOpen = null;
      render();
    },

    // Start a fresh empty 4-track container (materialized at the first Record).
    onNewTake: () => {
      if (deckRecording) return;
      if (tapeDeck) tapeDeck.stopPlay();
      deckPendingNewTake = true;
      currentTake = null;
      deckArmed = [];          // nothing armed until the user taps a strip's REC
      deckClickDraft = readClickDefault();
      deckDrumDraft = readDrumDefault();
      deckDrumBar = 0;
      deckStatus = null;
      deckPanelOpen = null;
      render();
    },

    onArmRecordPass: () => armRecording(),

    // Toggle a strip's record-arm. Arming assigns the lowest interface input not
    // already claimed by another armed strip; the next render's normalizeArmed enforces
    // capacity/uniqueness. Only free strips are armable (the view gates the button).
    onArmTrack: (slotKey) => {
      if (deckRecording || deckBouncing) return;
      if (deckArmed.some((a) => a.slotKey === slotKey)) {
        deckArmed = deckArmed.filter((a) => a.slotKey !== slotKey); // toggle off
      } else {
        const channels = (deckInputs && deckInputs.channels) || 1;
        const used = new Set(deckArmed.map((a) => a.inputIndex));
        let inputIndex = 0; while (inputIndex < channels && used.has(inputIndex)) inputIndex++;
        if (inputIndex >= channels) return; // every interface input already assigned
        deckArmed = deckArmed.concat({ slotKey, inputIndex });
      }
      render();
    },

    // Cycle an armed strip's interface input to the next one, swapping with whichever
    // strip currently holds that input (keeps inputs unique across armed strips).
    onCycleInput: (slotKey) => {
      if (deckRecording || deckBouncing) return;
      const channels = (deckInputs && deckInputs.channels) || 1;
      if (channels < 2) return; // only one input — nothing to cycle
      const me = deckArmed.find((a) => a.slotKey === slotKey);
      if (!me) return;
      const next = (me.inputIndex + 1) % channels;
      const other = deckArmed.find((a) => a.slotKey !== slotKey && a.inputIndex === next);
      deckArmed = deckArmed.map((a) => {
        if (a.slotKey === slotKey) return { ...a, inputIndex: next };
        if (other && a.slotKey === other.slotKey) return { ...a, inputIndex: me.inputIndex }; // swap
        return a;
      });
      render();
    },

    // Flip-open panels (CLICK / CAL / SHARE) — one open at a time; tapping the open one
    // closes it. UI-local state, so it must live in the view-model (onSetClick renders).
    onTogglePanel: (name) => { deckPanelOpen = (deckPanelOpen === name) ? null : name; render(); },

    // ---- Tape deck tabs (Mix mixer <-> Timeline clips) ----
    // The whole deck re-renders; only the body node swaps. head/tool are Timeline-only + persist.
    onTapeTab: (tab) => { deckTab = (tab === 'timeline') ? 'timeline' : 'mix'; if (deckTab === 'mix') deckTool = null; render(); },
    // Move the timeline head to a bar (floor-snapped by the caller). Record/Play begin here.
    onTimelineSeek: (bar) => { deckHead = Math.max(0, bar | 0); render(); },
    // Activate/toggle a timeline tool (mutually exclusive); clears any pending dupe pick.
    onTimelineTool: (tool) => { deckTool = (deckTool === tool) ? null : tool; deckDupeSrc = null; render(); },
    // Preserve the timeline horizontal scroll across full re-renders (DOM-local, no render).
    onTimelineScroll: (px) => { deckScrollLeft = Math.max(0, px | 0); },
    // Set an armed Timeline lane's interface input to a specific channel (pulldown), swapping with
    // whichever lane currently holds it so inputs stay unique.
    onTimelineSetInput: (key, idx) => {
      if (deckRecording || deckBouncing) return;
      const channels = (deckInputs && deckInputs.channels) || 1;
      if (!(idx >= 0 && idx < channels)) return;
      const me = deckArmed.find((a) => a.slotKey === key);
      if (!me) return;
      const other = deckArmed.find((a) => a.slotKey !== key && a.inputIndex === idx);
      deckArmed = deckArmed.map((a) => {
        if (a.slotKey === key) return { ...a, inputIndex: idx };
        if (other && a.slotKey === other.slotKey) return { ...a, inputIndex: me.inputIndex };
        return a;
      });
      render();
    },

    // ---- timeline clip tools ----
    // SLICE: split a clip at the END of the clicked bar into two self-contained WAVs.
    onTimelineSlice: (key, clipId, bar) => runClipEdit(async (take, slug) => {
      const src = loadedLaneClips(take, key).find((c) => c.id === clipId);
      if (!src) return null;
      const ids = { leftId: newClipId(), rightId: newClipId() };
      const r = takeModel.sliceClip(deckManifest, currentTake, key, clipId, bar, ids);
      const left = clipOnLane(r.manifest, key, ids.leftId), right = clipOnLane(r.manifest, key, ids.rightId);
      if (!left || !right) return null;
      const bytes = await readClipBytes(slug, src);
      const split = left.bars * barFramesOf(take), total = wavSampleCount(bytes);
      return { manifest: r.manifest, writes: [{ file: left.file, bytes: sliceWavBytes(bytes, 0, split) }, { file: right.file, bytes: sliceWavBytes(bytes, split, total) }], deletes: [src.file] };
    }),
    // TRIM: click a clip's first/last bar to drop that bar (middle bar = no-op).
    onTimelineTrim: (key, clipId, bar) => runClipEdit(async (take, slug) => {
      const src = loadedLaneClips(take, key).find((c) => c.id === clipId);
      if (!src) return null;
      const clickBar = Math.max(src.startBar, Math.min(src.startBar + src.bars - 1, bar));
      const isFirst = clickBar === src.startBar, isLast = clickBar === src.startBar + src.bars - 1;
      if (!isFirst && !isLast) return null; // a middle bar does nothing
      const edge = isFirst ? 'first' : 'last';
      const newId = newClipId();
      const r = takeModel.trimClip(deckManifest, currentTake, key, clipId, edge, { newId });
      const nw = clipOnLane(r.manifest, key, newId);
      if (!nw) return { manifest: r.manifest, writes: [], deletes: [src.file] }; // trimmed a 1-bar clip away
      const bytes = await readClipBytes(slug, src), bf = barFramesOf(take), total = wavSampleCount(bytes);
      const out = edge === 'first' ? sliceWavBytes(bytes, bf, total) : sliceWavBytes(bytes, 0, total - bf);
      return { manifest: r.manifest, writes: [{ file: nw.file, bytes: out }], deletes: [src.file] };
    }),
    // DELETE: remove a clip + its WAV.
    onTimelineDelete: (key, clipId) => runClipEdit(async () => {
      const r = takeModel.deleteClipFromLane(deckManifest, currentTake, key, clipId);
      return { manifest: r.manifest, writes: [], deletes: r.removedFiles };
    }),
    // DUPE: pick a clip, then click a spot in its lane to place a snapped, non-overlapping copy.
    onTimelineDupePick: (key, clipId) => { deckDupeSrc = { key, clipId }; render(); },
    onTimelineDupePlace: (key, targetBar) => runClipEdit(async (take, slug) => {
      if (!deckDupeSrc) return null;
      const src = loadedLaneClips(take, deckDupeSrc.key).find((c) => c.id === deckDupeSrc.clipId);
      if (!src) { deckDupeSrc = null; return null; }
      const newId = newClipId();
      const r = takeModel.dupeClipInLane(deckManifest, currentTake, deckDupeSrc.key, deckDupeSrc.clipId, targetBar, { newId });
      const nw = clipOnLane(r.manifest, deckDupeSrc.key, newId);
      const bytes = await readClipBytes(slug, src);
      deckDupeSrc = null;
      return { manifest: r.manifest, writes: nw ? [{ file: nw.file, bytes }] : [], deletes: [] };
    }),

    // TAPE LOG <details> open state. The <details> element reflects `open` in the DOM
    // itself, so this only records the flag for the next rebuild — no render (which would
    // fight the native toggle).
    onToggleTakeLog: (open) => { deckLogOpen = !!open; },

    // Edit the new-take metronome draft (BPM/meter/subdivision/accent/on-off), persisted
    // as the last-used default. A patch that changes the time signature re-clamps the
    // accent index to the new meter's option list (clampClickConfig).
    // BPM / count-in edits — commit to the loaded take or the new-take draft (see commitClick).
    onSetClick: (patch) => commitClick(clampClickConfig({ ...currentClickBase(), ...patch })),

    // Drum edits (enable/kit/effect/mix/swing/master/per-voice) — deep-merged so a single-field
    // patch doesn't wipe siblings, then committed to the loaded take or the draft.
    onSetDrums: (patch) => commitDrums(mergeDrums(currentDrumBase(), patch)),
    // Toggle one grid cell on/off (immutable transform).
    onToggleDrumCell: (voiceId, globalStep) => commitDrums(toggleCell(currentDrumBase(), voiceId, globalStep)),
    // Scroll the grid to another bar of a multi-bar pattern (UI-local).
    onSetDrumBar: (n) => { deckDrumBar = Math.max(0, n | 0); render(); },
    // Grow/shrink the pattern's bar count (preserves existing cells).
    onSetDrumBars: (n) => {
      const next = setBars(currentDrumBase(), n);
      if (deckDrumBar >= next.pattern.bars) deckDrumBar = next.pattern.bars - 1;
      commitDrums(next);
    },
    // Import a Standard MIDI File -> quantize to the grid -> load as the pattern (loaded take or
    // draft). Unmapped notes are discarded; the count is surfaced in the status strip.
    onImportDrumMidi: async (file) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const r = smfToPattern(bytes);
        deckDrumBar = 0;
        deckStatus = { type: 'info', message: r.mappedCount + ' notes mapped to ' + r.pattern.bars + ' bar' + (r.pattern.bars === 1 ? '' : 's') + ', ' + r.discarded.length + ' unmapped (no matching voice).' };
        // Keep the raw .mid so it travels with the song (decision 4): stash it in an OPFS temp
        // now (survives reload) and record its name on the drum config; Save copies it into the
        // folder's midi/<id>/. The derived pattern still drives playback — the .mid is never re-read.
        const a = activeSong();
        const name = safeMidiName(file.name);
        if (a && a.id) { try { await takeStore.writeFile(takeModel.midiRef(a.id) + name, bytes.buffer); } catch { /* temp write failed; the pattern still loads */ } }
        commitDrums(mergeDrums(currentDrumBase(), { enabled: true, pattern: r.pattern, source: { type: 'midi', midiFile: name } }));
      } catch {
        deckStatus = { type: 'error', message: 'Could not read that MIDI file — is it a Standard MIDI File?' };
        render();
      }
    },

    // ---- drum-loop sequencer (new-take authoring) ----
    onSetDrumMode: (mode) => {
      deckDrumMode = mode === 'sequence' ? 'sequence' : 'single';
      if (deckDrumMode === 'sequence' && !deckSequenceDraft) deckSequenceDraft = makeEmptySequenceDraft();
      render();
    },
    onPickLoopFolder: () => {
      const a = activeSong(); if (!a || !a.id) return;
      if (!loopPicker) loopPicker = makeLoopPicker({
        onFolder: async ({ folderName, files }) => {
          const song = activeSong(); if (!song || !song.id) return;
          const tsi = currentClickBase().timeSigIndex != null ? currentClickBase().timeSigIndex : 2;
          const loopFiles = [], loopPatterns = [];
          for (const f of files) {
            const bytes = await f.getBytes();
            const pattern = smfToPattern(bytes, tsi).pattern;   // parse BEFORE writeFile (buffer transfer)
            try { await takeStore.writeFile(takeModel.loopsRef(song.id) + folderName + '/' + f.name, bytes.buffer); } catch { /* temp write failed; pattern still loads */ }
            loopFiles.push(f.name); loopPatterns.push(pattern);
          }
          if (!deckSequenceDraft) deckSequenceDraft = makeEmptySequenceDraft();
          deckSequenceDraft.folderName = folderName;
          deckSequenceDraft.loopFiles = loopFiles;
          deckSequenceDraft.loopPatterns = loopPatterns;
          deckSequenceReject = null;
          deckLoopAuditionIndex = 0;
          deckDrumMode = 'sequence';
          deckStatus = { type: 'info', message: loopFiles.length + ' loop' + (loopFiles.length === 1 ? '' : 's') + ' loaded from “' + folderName + '”.' };
          render();
        },
        onReject: ({ reason, offenders, expected }) => {
          deckSequenceReject = { reason, offenders, expected };
          deckStatus = { type: 'warn', message:
            reason === 'empty' ? 'No .mid files in that folder.'
              : reason === 'gaps' ? ('Loops must be a gapless set ' + expected + '.mid.')
              : ('Loops must be named 001.mid, 002.mid… (offenders: ' + (offenders || []).slice(0, 3).join(', ') + ').') };
          render();
        },
      });
      loopPicker.open();
    },
    onPickIntro: () => { if (!introPicker) introPicker = makeSingleMidiPicker({ onFile: ({ name, getBytes }) => setSequenceIntroOutro('intro', name, getBytes) }); introPicker.open(); },
    onPickOutro: () => { if (!outroPicker) outroPicker = makeSingleMidiPicker({ onFile: ({ name, getBytes }) => setSequenceIntroOutro('outro', name, getBytes) }); outroPicker.open(); },
    onClearIntro: () => { if (deckSequenceDraft) { deckSequenceDraft.introName = null; deckSequenceDraft.introPattern = null; deckLoopAuditionIndex = 0; render(); } },
    onClearOutro: () => { if (deckSequenceDraft) { deckSequenceDraft.outroName = null; deckSequenceDraft.outroPattern = null; deckLoopAuditionIndex = 0; render(); } },
    onAuditionStep: (delta) => {
      const n = auditionListFor(deckSequenceDraft).length;
      if (!n) return;
      deckLoopAuditionIndex = (((deckLoopAuditionIndex + delta) % n) + n) % n;
      render();
      auditionPlayCurrent();
    },
    onAuditionPlay: () => auditionPlayCurrent(),
    onSetAlgorithm: (id) => { if (!deckSequenceDraft) deckSequenceDraft = makeEmptySequenceDraft(); deckSequenceDraft.algorithmId = id || null; render(); },
    onSetSequenceCount: (n) => { if (!deckSequenceDraft) deckSequenceDraft = makeEmptySequenceDraft(); deckSequenceDraft.count = Math.max(1, Math.min(MAX_FLAT_BARS, n | 0)); render(); },
    onPreviewSequence: () => {
      const click = currentClickBase();
      const built = buildFrozenSequence(click);   // a FRESH roll each time (never persisted — record freezes its own)
      if (!built.ok) { deckStatus = { type: 'warn', message: built.message }; render(); return; }
      const bpm = click.bpm || 120, tsi = click.timeSigIndex != null ? click.timeSigIndex : 2;
      ensureTapeDeck().previewPattern({ config: built.drumConfig, bpm, timeSigIndex: tsi, durationSec: built.drumConfig.pattern.bars * barSeconds(bpm, tsi) });
      const seq = built.drumConfig.sequence;
      deckStatus = { type: 'info', message: 'Preview: ' + seq.realizedBars + ' bars — ' + seq.realizedOrder.join('→') };
      render();
    },
    onImportRuleset: (text) => {
      let obj; try { obj = JSON.parse(text); } catch { deckStatus = { type: 'error', message: 'That is not valid JSON.' }; render(); return; }
      const v = validateRuleset(obj);
      if (!v.ok) { deckStatus = { type: 'error', message: 'Invalid ruleset: ' + v.errors[0] }; render(); return; }
      const r = normalizeRuleset(obj);
      saveUserRulesets(loadUserRulesets().filter((u) => u.id !== r.id).concat(r));
      refreshRulesets();
      if (deckSequenceDraft && !deckSequenceDraft.algorithmId) deckSequenceDraft.algorithmId = r.id;
      deckStatus = { type: 'info', message: 'Ruleset “' + r.name + '” imported.' };
      render();
    },
    onDeleteRuleset: (id) => { saveUserRulesets(loadUserRulesets().filter((u) => u.id !== id)); refreshRulesets(); render(); },

    onStopTake: async () => {
      if (!tapeDeck || !deckRecording) return;
      // stop() resolves after onStatus('stopped',...) has already finalized the manifest
      // and cleared deckRecording. The finally is a last-ditch guarantee: if stop() ever
      // rejects, still clear the flag and re-render so the deck can't strand nav-locked
      // (every control is gated on deckRecording — the whole reason a stuck stop reads as
      // "the app crashed, hard-refresh to recover").
      // Bar-atomic Stop: completes the current bar before finalizing (both Mix + Timeline), so a
      // clip is always a whole number of bars. requestStopAtBar arms the endFrame gate and resolves
      // once the worklet's {op:'ended'} runs the real stop()+finalize.
      try { await tapeDeck.requestStopAtBar(); }
      finally { if (deckRecording) { deckRecording = false; deckRecordingSlotKeys = []; deckRecordingGroup = null; render(); } }
    },

    // Retake (rescoped): re-record ONLY the last recorded group — free its slots,
    // delete their audio, then re-arm a pass into exactly those slots (with the
    // take's earlier groups playing as backing).
    onDiscardLastGroup: async () => {
      const a = activeSong();
      if (!a || !deckManifest || currentTake == null || deckRecording || deckSaving) return;
      const take = deckManifest.takes.find((t) => t.take === currentTake);
      if (!take) return;
      const keys = takeModel.lastGroupSlotKeys(take);
      if (!keys.length) return;
      const group = takeModel.nextGroup(take) - 1; // the last recorded group
      const groupFiles = keys.flatMap((k) => takeModel.laneClips(take.stems[k]).filter((c) => c.file && c.group === group).map((c) => c.file));
      deckManifest = takeModel.discardGroup(deckManifest, currentTake, group);
      await takeStore.writeManifest(manifestPath(a.id), deckManifest);
      takeStore.deleteSlotFiles(a.id, groupFiles).catch(() => {}); // metadata first, best-effort delete second
      if (tapeDeck) tapeDeck.stopPlay();
      deckArmed = keys.map((k, i) => ({ slotKey: k, inputIndex: i })); // re-arm exactly the freed slots
      render();
      await armRecording();
    },

    // AC-22: per-take Delete — the storage relief valve, available for any take, any time.
    onDeleteTake: async (takeNo) => {
      const a = activeSong();
      // A bounce mid-flight for this same take would otherwise write an
      // orphaned _mix.wav after the delete tombstones it (markBounced's
      // takeNo would no longer match anything). Simplest safe rule: no
      // deletes while any bounce is in flight (tapeView also disables the
      // buttons — this is the defense-in-depth backstop).
      if (!a || !deckManifest || deckBouncing || deckSaving) return;
      const takeRec = deckManifest.takes.find((t) => t.take === takeNo); // capture clip files before the tombstone empties it
      deckManifest = takeModel.discardTake(deckManifest, takeNo);
      await takeStore.writeManifest(manifestPath(a.id), deckManifest);
      takeStore.deleteTakeAudio(a.id, takeNo, takeRec).catch(() => {});
      // Make the delete DURABLE (H5): re-embed the surviving takes into the song .json + localStorage
      // so an OPFS-evicted reopen hydrates the reduced set and can't resurrect this take.
      await persistDeckTakes(a.id);
      if (currentTake === takeNo) {
        if (tapeDeck) tapeDeck.invalidatePlayback(); // drop the deleted take's decoded buffers + graph, not just stop its sources
        const kept = takeModel.mostRecentKeptTake(deckManifest);
        currentTake = kept ? kept.take : null;
      }
      await refreshSpaceWarning();
      render();
    },

    // A plain "Load" from take history.
    onSelectTake: (takeNo) => {
      if (tapeDeck) tapeDeck.stopPlay();
      currentTake = takeNo;
      deckPendingNewTake = false;
      deckArmed = [];       // a freshly-loaded take starts with nothing armed
      deckPanelOpen = null;
      render();
    },

    // Manual overdub-latency override for the current input (dial-in / nudge).
    onSetMonitorLatency: (ms) => {
      writeLatency(deckSelectedInputId, { ms: Number(ms) || 0, source: 'manual', spreadMs: null });
      render();
    },

    // Measure the overdub round-trip through a loopback (cable EVO out->in, or mic to
    // headphones). Plays a series of clicks; stores the median per input device.
    onCalibrateLatency: async () => {
      if (!tapeDeck || deckRecording || deckBouncing || deckCalibrating) return;
      if (tapeDeck) tapeDeck.stopPlay();
      deckCalibrating = true;
      deckStatus = { type: 'warn', message: 'Calibrating… loop the EVO output to input 1 (or hold the mic to your headphones). You’ll hear a few clicks.' };
      render();
      let res;
      try { res = await ensureTapeDeck().calibrateLatency({ deviceId: deckSelectedInputId }); }
      catch { res = { ok: false, reason: 'Calibration failed to run.' }; }
      deckCalibrating = false;
      if (res.ok) {
        const ms = Math.round(res.rttSec * 1000);
        const spreadMs = res.spreadMs != null ? Math.round(res.spreadMs) : null;
        writeLatency(deckSelectedInputId, { ms, source: 'measured', spreadMs });
        deckStatus = { type: 'warn', message: 'Measured round-trip ' + ms + ' ms' + (spreadMs != null ? ' (±' + spreadMs + ' ms across trials)' : '') + ' — applied to overdubs.' };
      } else {
        deckStatus = { type: 'error', message: res.reason || 'Calibration failed.' };
      }
      render();
    },

    // AC-25 input picker — re-probes the newly picked device.
    onSelectInput: async (deviceId) => {
      deckSelectedInputId = deviceId;
      const probeResult = await ensureTapeDeck().probe(deviceId);
      if (probeResult.ok) { deckInputs = probeResult; deckBlocked = false; } else { deckBlocked = true; }
      render();
    },

    // D32: capture-only on `input` — applies live for preview, no persistence, no render.
    onPreviewStemSetting: (stemKey, patch) => {
      if (!tapeDeck || !deckManifest || currentTake == null) return;
      const take = deckManifest.takes.find((t) => t.take === currentTake);
      const current = take && take.stems[stemKey];
      if (!current) return;
      const merged = takeModel.clampStemSettings({ ...current, ...patch, eq: { ...current.eq, ...(patch.eq || {}) } });
      tapeDeck.applySettings(stemKey, merged);
    },
    // D32: on `change` (pointer-up) — persist to the manifest, debounced ~300ms, and render.
    onSetStemSetting: (stemKey, patch) => {
      if (!deckManifest || currentTake == null) return;
      deckManifest = takeModel.setStemSettings(deckManifest, currentTake, stemKey, patch);
      const a = activeSong();
      clearTimeout(stemSettingsDebounce);
      stemSettingsDebounce = setTimeout(() => { if (a) takeStore.writeManifest(manifestPath(a.id), deckManifest).catch(() => {}); }, 300);
      render();
    },

    // Master MONITOR fader (D35/D32 twin): preview on drag applies live gain, no persist,
    // no render; commit on release persists to localStorage and renders. Never touches the
    // take/manifest and never affects the bounce.
    onPreviewMasterVol: (v) => { if (tapeDeck) tapeDeck.setMasterVol(v); },
    onSetMasterVol: (v) => { writeMasterVol(v); if (tapeDeck) tapeDeck.setMasterVol(v); render(); },

    // Ping-pong bounce: sum one track into another (both effected, mono, baked),
    // freeing the source slot for more recording. Shares the deckBouncing guard with
    // the master bounce + delete so no two operations touch the same take's files.
    onBounceStemToTrack: async (srcKey, dstKey) => {
      const a = activeSong();
      if (!a || !deckManifest || currentTake == null || !tapeDeck || deckBouncing || deckRecording || deckSaving || srcKey === dstKey) return;
      const take = deckManifest.takes.find((t) => t.take === currentTake);
      const src = take && take.stems[srcKey];
      const dst = take && take.stems[dstKey];
      if (!takeModel.slotHasAudio(src) || !takeModel.slotHasAudio(dst)) return;
      const srcFiles = takeModel.laneClips(src).filter((c) => c.file).map((c) => c.file); // freed by the bounce
      const takeNo = take.take;
      tapeDeck.stopPlay();
      deckBouncing = true;
      render();
      let result;
      try {
        const fh = takeHasFolderFile(take) ? await folderHandleForSong(a.id) : null; // saved src/dst read from the folder
        result = await tapeDeck.bounceTracks(take, srcKey, dstKey, a.id, fh);
      } catch (e) { deckBouncing = false; surfaceReadError(e); return; }
      deckBouncing = false;
      if (!result.ok) { deckStatus = { type: 'error', message: 'Bounce failed: ' + result.error }; render(); return; }
      // Don't touch a take that got deleted mid-bounce (the delete guard blocks this,
      // but stay correct if it's ever bypassed).
      const stillActive = deckManifest.takes.find((t) => t.take === takeNo && t.status === 'active');
      if (!stillActive) { render(); return; }
      deckManifest = takeModel.bounceTrackToTrack(deckManifest, takeNo, srcKey, dstKey, result.durationSec);
      await takeStore.writeManifest(manifestPath(a.id), deckManifest);
      takeStore.deleteSlotFiles(a.id, srcFiles).catch(() => {}); // metadata first, best-effort file delete second
      await refreshSpaceWarning();
      render();
    },

    // Ephemeral playback — no persisted state, so these go straight to the
    // controller rather than through a manifest-mutating handler (sketches
    // precedent: compare onLoadSketchBlob / makeSketchPlayer).
    onPlayTake: (take, slug) => playTake(take, slug, false),
    onReplayTake: (take, slug) => playTake(take, slug, true),
    onStopPlayTake: () => { if (tapeDeck) tapeDeck.stopPlay(); },

    // ---- song-management row (Save / Export / Rename / Delete), available in the deck ----

    // The consolidated Save: migrate this song's OPFS take audio + imported MIDI into the
    // song's on-disk folder (beside its .json), then reconcile the folder to match. One
    // gesture — grants the folder the first time (picker opens at the .json), silent after.
    // Crash-safe order (folder writes+verify → folder manifest → OPFS manifest → delete OPFS
    // temps) so an interruption leaves duplicates, never a hole (the take stays OPFS-safe).
    onSaveDeck: async () => {
      const a = activeSong();
      if (!a || !a.id || !deckManifest || deckRecording || deckBouncing || deckSaving) return;
      deckSaving = true;
      deckStatus = null;
      render();
      try {
        if (!(await ensureSongJsonSaved())) { deckStatus = { type: 'warn', message: 'Save the song’s .json first, then Save takes.' }; return; }
        const dir = await ensureFolderGrant(a.id);
        if (!dir) { deckStatus = { type: 'warn', message: 'Pick the song’s folder to save its takes into it.' }; return; }
        deckHasJsonHandle = true;
        deckHasFolderHandle = true;
        const slug = a.id;
        const dp = takeModel.tapeDeckRef(slug).path; // 'takes/<slug>/'
        let next = deckManifest;
        let migrated = 0;

        // 1. Migrate every non-discarded take's OPFS-only slots (+ its OPFS bounce), verifying each.
        for (const take of deckManifest.takes) {
          if (take.status === 'discarded') continue;
          const pending = takeModel.pendingOpfsSlotKeys(take);
          let wrote = 0;
          for (const key of pending) {
            for (const c of takeModel.laneClips(take.stems[key])) { // each opfs clip of the lane migrates
              if (!c.file || c.loc === 'folder') continue;
              const rel = dp + c.file;
              const bytes = await takeStore.readFile(rel);
              await folderStore.writeFile(dir, rel, bytes);
              if ((await folderStore.fileSize(dir, rel)) !== bytes.byteLength) throw new Error('verify failed: ' + c.file);
              wrote++;
            }
          }
          const bouncePending = !!(take.bounce && take.bounce.file && take.bounce.loc !== 'folder');
          if (bouncePending) {
            const rel = dp + take.bounce.file;
            const bytes = await takeStore.readFile(rel);
            await folderStore.writeFile(dir, rel, bytes);
            if ((await folderStore.fileSize(dir, rel)) !== bytes.byteLength) throw new Error('verify failed: ' + take.bounce.file);
          }
          if (pending.length || bouncePending) { next = takeModel.migrateTakeSlots(next, take.take, pending, { bounce: bouncePending }); migrated += wrote + (bouncePending ? 1 : 0); }
        }

        // 2. Copy each referenced imported MIDI from its OPFS temp into the folder, then drop the temp.
        for (const name of takeModel.referencedMidiFiles(next)) {
          const rel = takeModel.midiRef(slug) + name;
          let bytes;
          try { bytes = await takeStore.readFile(rel); } catch { continue; } // temp already copied on a prior Save
          await folderStore.writeFile(dir, rel, bytes);
          takeStore.deletePath(rel).catch(() => {});
        }

        // 2b. Same for each sequencer loop file (loops/<slug>/<folder>/NNN.mid + intro/outro). These
        //     are provenance only (playback runs the frozen flattened pattern), but they travel so a
        //     re-opened song can start a new take from the same folder.
        for (const rel0 of takeModel.referencedLoopFiles(next)) {
          const rel = takeModel.loopsRef(slug) + rel0;
          let bytes;
          try { bytes = await takeStore.readFile(rel); } catch { continue; }
          await folderStore.writeFile(dir, rel, bytes);
          takeStore.deletePath(rel).catch(() => {});
        }

        // 3. Update the OPFS working index (live-session scratch only). The durable record is the
        //    song .json written next — the folder no longer carries a manifest.json (deprecated: the
        //    .json is the single source of truth; step 5's GC removes any legacy copy still present).
        await takeStore.writeManifest(manifestPath(slug), next);
        deckManifest = next;

        // 3b. Write the DURABLE record — the single source of truth. Mirror the just-saved takes into
        //     the song record (localStorage: the permission-free per-device cache) AND overwrite the
        //     on-disk .json (cross-session / cross-device), which now carries tapeDeck.takes. Opening
        //     the song restores these with NO folder prompt; audio still lazy-loads from the folder on
        //     Play. tapeDeckWithTakes is a complete tapeDeck object (path + schemaVersion + projected
        //     takes). Stamp BY ID so a long Save stamps THIS song even if the user navigated away. The
        //     .json write is the commit marker — it lands BEFORE the OPFS temps are deleted (step 4),
        //     so if it fails the temps remain as the recovery source and the user is warned to re-Save.
        const td = takeModel.tapeDeckWithTakes(slug, next);
        songs = songs.map((s) => (s.id === a.id ? { ...s, tapeDeck: td, updatedAt: nowISO() } : s));
        saveSongs(songs);
        const jsonWritten = await writeSongJsonById(a.id);

        // 4. Delete OPFS temps for every take now fully in the folder — but ONLY once the durable
        //    .json commit succeeded. If it failed, the temps + the OPFS working manifest remain as the
        //    recovery source (a re-open reads them; a re-Save retries the .json), honoring step 3b.
        if (jsonWritten) {
          for (const take of deckManifest.takes) {
            if (take.status === 'discarded' || !takeModel.takeIsSaved(take)) continue;
            takeStore.deleteTakeAudio(slug, take.take, take).catch(() => {});
          }
        }

        // 5. GC folder orphans: any WAV under takes/<slug>/ the just-written manifest no longer
        //    references (a deleted take, a freed/ping-ponged slot, an old bounce) — keeps the
        //    folder a consistent snapshot of exactly what Save wrote.
        try {
          // manifest.json is deprecated: once the .json commit succeeds it is redundant, so it is NOT
          // referenced and the GC removes any legacy copy. But if the .json write FAILED, KEEP a legacy
          // manifest.json — it is the only non-evictable on-disk record of the takes until a successful
          // Save embeds them into the .json (deleting it here would risk irrecoverable metadata loss).
          const referenced = new Set();
          if (!jsonWritten) referenced.add('manifest.json');
          for (const t of next.takes) {
            for (const k of takeModel.STEM_KEYS) for (const c of takeModel.laneClips(t.stems[k])) { if (c.file) referenced.add(c.file); }
            if (t.bounce && t.bounce.file) referenced.add(t.bounce.file);
          }
          for (const name of await folderStore.listDir(dir, dp)) { if (!referenced.has(name)) folderStore.deleteFile(dir, dp + name).catch(() => {}); }
        } catch { /* listing unsupported — orphans are inert, cleaned on song delete */ }

        deckStatus = !jsonWritten
          ? { type: 'warn', message: 'Saved take audio to the folder, but could not update the song .json — re-Save the song file so its takes stay portable.' }
          : { type: 'info', message: migrated ? ('Saved ' + migrated + ' file' + (migrated === 1 ? '' : 's') + ' to the song folder.') : 'Everything is already saved to the folder.' };
        await refreshSpaceWarning();
      } catch (e) {
        deckStatus = { type: 'error', message: 'Save failed (' + ((e && e.message) || 'folder write error') + '). Your takes are still safe on this device — try Save again.' };
      } finally {
        deckSaving = false;
        render();
      }
    },

    // Export (consolidates the old MIX / SHARE / EXPORT) = write the CURRENT take's mixdown +
    // its clean stems into a <slug>-<take>/ subfolder of the song's on-disk folder:
    //   (a) <slug>_<take>_mix.wav  — the summed mixdown WITH each track's channel-strip
    //       settings (renderMaster: vol/EQ/comp per track, then LUFS-target + limiter master).
    //   (b) <slug>_<take>_stemN.wav — the raw captured stems, UNPROCESSED (the strip is
    //       non-destructive, so the on-disk stem files carry none of it — copied verbatim).
    // The subfolder is a sibling of takes/ inside the granted folder and is a user-facing
    // export, NOT part of Save's managed store (Save's GC / song-delete leave it alone).
    // Desktop-Chrome only (needs the File System Access folder, like Save).
    onExportDeck: async (opts) => {
      const a = activeSong();
      if (!a || !a.id || !deckManifest || currentTake == null || !tapeDeck || deckBouncing || deckRecording || deckSaving) return;
      const take = deckManifest.takes.find((t) => t.take === currentTake);
      if (!take || !takeModel.takeHasAudio(take)) { deckStatus = { type: 'warn', message: 'Load a take with audio to export.' }; render(); return; }
      const dir = await ensureFolderGrant(a.id);
      if (!dir) { deckStatus = { type: 'warn', message: 'Pick the song’s folder to export into it (desktop Chrome only).' }; render(); return; }
      deckHasFolderHandle = true;
      deckBouncing = true;
      deckStatus = { type: 'info', message: 'Exporting…' };
      render();
      try {
        const slug = a.id;
        const sub = slug + '-' + take.take + '/';    // e.g. my-song-3/ — sibling of takes/, midi/
        const dp = takeModel.tapeDeckRef(slug).path;  // 'takes/<slug>/'

        // (a) Mixdown with channel strips + master.
        const r = await tapeDeck.renderMaster(take, slug, { includeDrums: !!(opts && opts.includeDrums) }, dir);
        if (!r.ok) { deckStatus = { type: 'error', message: 'Export failed: ' + r.error }; return; }
        await folderStore.writeFile(dir, sub + takeModel.mixFileName(slug, take.take), r.bytes);

        // (b) Clean stems — each lane's clips flattened (at their bar offsets) into one mono stem
        //     WAV. renderStem reads folder-located clips from the folder and opfs clips from OPFS.
        const keys = takeModel.filledSlotKeys(take);
        for (const key of keys) {
          const bytes = await tapeDeck.renderStem(take, key, slug, dir);
          if (bytes) await folderStore.writeFile(dir, sub + takeModel.stemFileName(slug, take.take, key), bytes);
        }

        deckStatus = { type: 'info', message: 'Exported mix + ' + keys.length + ' stem' + (keys.length === 1 ? '' : 's') + ' to ' + slug + '-' + take.take + '/' };
      } catch (e) {
        deckStatus = { type: 'error', message: 'Export failed (' + ((e && e.message) || 'folder write error') + ').' };
      } finally {
        deckBouncing = false;
        render();
      }
    },

    // Rename the whole song from inside the deck — display name only; on-disk artifacts stay
    // id-named (matching the existing rename-keeps-id behavior). Delegates to onRenameSong.
    onRenameSongDeck: (name) => handlers.onRenameSong(name),

    // Delete the whole song from the deck: remove ONLY this song's id-scoped on-disk artifacts
    // (its <id>.json, takes/<id>/, midi/<id>/) plus OPFS temp, then the song itself. Never
    // touches other files in a shared folder. Inline-confirmed by the view.
    onDeleteDeck: async () => {
      const a = activeSong();
      if (!a || !a.id || deckRecording || deckBouncing || deckSaving) return;
      const songId = a.id;
      const jsonHandle = await handleForSong(songId);
      const dir = await folderHandleForSong(songId);
      if (dir) {
        try { await folderStore.deleteSongArtifacts(dir, songId); } catch { /* best-effort */ }
        if (jsonHandle && jsonHandle.name) folderStore.deleteFile(dir, jsonHandle.name).catch(() => {}); // the actual .json (its picked name)
      }
      fileHandles.delete(dirKey(songId));
      audioStore.deleteFileHandle(dirKey(songId)).catch(() => {});
      handlers.onDeleteSong(songId); // drops the song + .json/.md handles + OPFS takes/midi + resets the deck UI
    },

    // tapeView calls this once per render with the freshly-built timer/meter/
    // play-status DOM refs (the makeSketchPlayer.setStatus idiom, generalized —
    // see tapeLive's declaration up top). Pure state, no render() of its own.
    onDeckLiveRefs: (live) => { tapeLive = live; },
  },
};

(async () => {
  const builtin = await loadBuiltinFeels();
  builtinFeels = builtin.feels;
  builtinIds = builtin.ids;
  userFeels = loadUserFeels();
  recompute();
  try { builtinRulesets = (await loadBuiltinRulesets()).rulesets; } catch { builtinRulesets = []; }
  refreshRulesets();

  if (!feelList.length) {
    rootEl.textContent = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'max-width:520px;margin:60px auto;text-align:center;color:var(--muted);font:600 15px/1.6 -apple-system,sans-serif';
    msg.textContent = 'Could not load feels. Check your connection and reload.';
    rootEl.appendChild(msg);
    return;
  }

  state = load(feelIds, builtinIds);
  songs = loadSongs();
  songs = await reconcileSketches(songs);   // drop dangling sketch metadata, GC orphan blobs
  app = mountApp(rootEl, handlers);
  // Surface a failed localStorage persist (quota / private mode) instead of swallowing it: the
  // song's durable copies (.json on disk, folder manifest.json for takes) are unaffected, but the
  // fast per-device cache is stale, so tell the user rather than let it fail silently.
  onSaveError(() => {
    songFlash = { ok: false, error: 'This device’s storage is full — your song is still safe in its .json file (and takes in the song folder), but the in-app copy could not update. Free some space and Save again.' };
    render();
  });
  commit();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
