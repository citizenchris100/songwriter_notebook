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
import { loadSongs, saveSongs } from './songStore.js';
import {
  validateSong, normalizeSong, nextUntitledName, slugifySongId, buildCapturedProgression,
  createSong, appendProgressions, reorderProgression, removeProgression, copyProgression,
  setProgressionLabel, setLyrics, renameSong, finalizeDraft,
  appendRow, addChord, setChord, removeChord,
} from './songs.js';
import { isAcceptedAudio, makeSketchMeta, addSketchMeta, removeSketchMeta, setSketchNotes } from './sketches.js';
import * as audioStore from './audioStore.js';
import { chordFromRootAndQuality } from './theory/roman.js';
import * as takeModel from './tape/takeModel.js';
import * as takeStore from './tape/takeStore.js';
import { SIZE_FIELDS } from './tape/wav.js';
import { makeTapeDeck } from './tape/audioEngine.js';
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
let deckOpenSeq = 0;           // bumped on every onOpenTapeDeck call; a stale in-flight open detects itself via this
let deckIsRetake = false;      // the in-flight recording was armed via Retake (gates the AC-8 take menu on stop)
let deckTakeMenuOpen = false;  // AC-8
let deckTakeMenuTakes = [];
let deckInputs = null;         // devices.probe() result: { inputs, preselectedId, warnMoreThanTwo, isLikelyInterface, channels }
let deckSelectedInputId = null;
let deckSpaceWarning = false;
let stemSettingsDebounce = null;

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
  deckIsRetake = false;
  deckTakeMenuOpen = false;
  deckTakeMenuTakes = [];
  deckInputs = null;
  deckSelectedInputId = null;
  clearTimeout(stemSettingsDebounce);
}

// The tape-deck slice of the view-model — see js/tape/tapeView.js for the shape
// this feeds. Cheap to compute even when the deck isn't open (deckManifest is
// null until onOpenTapeDeck loads it, so `takes` is just []).
function tapeDeckViewModel(active) {
  const takes = (deckManifest && deckManifest.takes) || [];
  const loadedTake = deckRecording
    ? (takes.find((t) => t.status === 'recording') || null)
    : (currentTake != null ? (takes.find((t) => t.take === currentTake && t.status === 'active') || null) : null);
  return {
    songId: active ? active.id : null,
    path: active ? takeModel.tapeDeckRef(active.id).path : '',
    currentTakeNo: loadedTake ? loadedTake.take : null,
    manifestTakes: takes,
    loadedTake,
    recording: deckRecording,
    bouncing: deckBouncing,
    blocked: deckBlocked,
    unsupported: deckUnsupported,
    noInterface: !!(deckInputs && deckInputs.channels !== 2),
    warnMoreThanTwo: !!(deckInputs && deckInputs.warnMoreThanTwo),
    inputs: (deckInputs && deckInputs.inputs) || [],
    selectedInputId: deckSelectedInputId,
    status: deckStatus,
    spaceWarning: deckSpaceWarning,
    takeMenuOpen: deckTakeMenuOpen,
    takeMenuTakes: deckTakeMenuTakes,
    hasHistory: takes.length > 0,
    showStrips: deckRecording || !!loadedTake,
    showLoadedActions: !deckRecording && !!loadedTake,
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

// Build a clean songs/<id>.json-shaped object for export (metadata only; audio bytes
// are added by toSongBundle).
function toSongFile(s) {
  return {
    '$schema': './song.schema.json',
    schemaVersion: 1,
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lyrics: s.lyrics,
    progressions: s.progressions.map((p) => {
      const out = { label: p.label, title: p.title, chords: p.chords.map((c) => ({ name: c.name, notes: c.notes.slice() })) };
      if (p.provenance) out.provenance = { ...p.provenance };
      return out;
    }),
    sketches: (s.sketches || []).map((sk) => ({
      id: sk.id, filename: sk.filename, mimeType: sk.mimeType, format: sk.format, size: sk.size, addedAt: sk.addedAt, notes: sk.notes,
    })),
  };
}

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

// Import one raw song/bundle object: validate, normalize, resolve id collisions, decode
// its audio under FRESH sketch ids (so re-import never clobbers existing blobs), and
// persist. Returns { ok, name } or { ok:false, error }. Sets currentSongId on success.
async function importOneSong(raw) {
  const v = validateSong(raw);
  if (!v.ok) return { ok: false, error: v.errors[0] };
  let s = normalizeSong(raw);
  const now = nowISO();
  if (!s.createdAt) s = { ...s, createdAt: now };
  if (!s.updatedAt) s = { ...s, updatedAt: now };
  if (songs.some((x) => x.id === s.id)) s = { ...s, id: slugifySongId(s.name, songs.map((x) => x.id)) };

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

  // A bundle carries no take audio, and the id may just have been re-slugged —
  // drop any tapeDeck ref (export already omits it; this is defense in depth
  // against a hand-edited bundle). Reopening the deck recreates the manifest.
  if ('tapeDeck' in s) { const { tapeDeck: _drop, ...rest } = s; s = rest; }
  // The file link is local to whoever exported it; the opener re-links to the file it
  // actually opened (afterOpen), so never carry an incoming link in.
  if ('file' in s) { const { file: _dropFile, ...rest } = s; s = rest; }

  songs = songs.concat(s);
  saveSongs(songs);
  currentSongId = s.id;
  return { ok: true, name: s.name, id: s.id };
}

// Parse text (a single bundle object or an array of them) and import each. Returns
// { ok, ids, count, error } — ids are the resulting (possibly re-slugged) song ids.
async function importSongsFromText(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, ids: [], count: 0, error: 'not valid JSON' }; }
  const items = Array.isArray(obj) ? obj : [obj];
  const ids = [];
  let firstErr = null;
  for (const raw of items) {
    const r = await importOneSong(raw);
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
// writeJsonSink (tier 1 handled separately, JSON-export-only) and by
// onShareTake (a take's stems/bounce are real .wav files, AC-20; there is no
// "save file picker" step for those, only "share sheet or download").
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

// Convenience for a synchronously-built payload (feels): the object is already in hand, so
// opening the picker first keeps the click gesture intact.
async function download(filename, obj) {
  await writeJsonSink(await openJsonSink(filename), obj);
}

// ---- tape deck (§5.6/§5.7) ----

const manifestPath = (slug) => takeModel.tapeDeckRef(slug).path + 'manifest.json';

// The audioEngine controller — created once, lazily (an AudioContext needs a
// user gesture), and never rebuilt. Its callbacks write into whatever DOM nodes
// `tapeLive` currently points at (refreshed every render by tapeView, exactly
// like makeSketchPlayer's single-slot setStatus) rather than through render().
function ensureTapeDeck() {
  if (tapeDeck) return tapeDeck;
  tapeDeck = makeTapeDeck({
    onMeter: (m) => {
      if (tapeLive.timerEl) tapeLive.timerEl.textContent = fmtElapsed(m.frames, m.sampleRate);
      updateMeterEls(m);
    },
    onStatus: handleDeckStatus,
    onWriteError: (message) => { deckStatus = { type: 'error', message: 'Storage error: ' + message }; render(); },
  });
  return tapeDeck;
}

function fmtElapsed(frames, sampleRate) {
  const s = Math.floor(frames / (sampleRate || 48000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function updateMeterEls(m) {
  if (!tapeLive.meterEls || !m.peaks) return;
  takeModel.STEM_KEYS.forEach((key, i) => {
    const el = tapeLive.meterEls[key];
    if (!el) return;
    const peak = m.peaks[i] || 0;
    el.style.width = Math.min(100, Math.round(peak * 100)) + '%';
    el.classList.toggle('clip', peak > 0.98);
  });
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
  if (s.type === 'no-wake-lock') { deckStatus = { type: 'warn', message: 'Screen may lock during long takes (Wake Lock isn’t available on this browser).' }; render(); return; }
  if (s.type === 'stopped' || s.type === 'stopped-interrupted' || s.type === 'stopped-storage-error') {
    const message = s.type === 'stopped-interrupted' ? 'Recording stopped (interrupted).'
      : s.type === 'stopped-storage-error' ? 'Recording stopped (storage error).' : null;
    await finalizeStoppedTake(s, message);
  }
}

async function finalizeStoppedTake(s, message) {
  deckRecording = false;
  if (deckManifest && deckManifest.slug === s.slug) {
    deckManifest = takeModel.finalizeTake(deckManifest, s.take, s.durationSec);
    await takeStore.writeManifest(manifestPath(s.slug), deckManifest);
  }
  if (deckIsRetake) {
    deckTakeMenuOpen = true;
    deckTakeMenuTakes = deckManifest.takes.filter((t) => t.status !== 'recording').slice().sort((a, b) => b.take - a.take);
    deckIsRetake = false;
  } else {
    currentTake = s.take;
  }
  deckStatus = message ? { type: 'warn', message } : null;
  await refreshSpaceWarning();
  render();
}

async function refreshSpaceWarning() {
  const est = await takeStore.estimateSpace();
  deckSpaceWarning = !!(est && est.available < 500 * 1024 * 1024); // §5.8: warn under ~500 MB
}

// Shared by onRecordTake and both Retake outcomes (Keep/Discard "arm a new
// take"): appends the take to the manifest at status "recording" and writes it
// BEFORE any OPFS stem file is opened (D22 crash-consistent ordering) — the
// onChannelsKnown callback is where audioEngine.record() hands back the
// channel count + sample rate the instant they're known.
//
// `deckArming` is a SYNCHRONOUS re-entrancy guard, set true before the first
// `await`. `deckRecording` alone isn't enough: it only flips true deep inside
// the async onChannelsKnown callback, well after getUserMedia/worklet-load have
// already started, leaving a real window for a fast double-tap to arm two
// takes off the same stale manifest snapshot (duplicate take numbers, one
// recording's stem files truncated by the other's openTakeFiles).
async function armRecording() {
  if (deckArming || deckRecording) return;
  const a = activeSong();
  if (!a || !a.id || !deckManifest) return;
  deckArming = true;
  deckStatus = null;
  const slug = a.id;
  const path = manifestPath(slug);
  await refreshSpaceWarning(); // §5.8: "before each record", not just on deck open / after the last take
  let started = false;
  try {
    const result = await ensureTapeDeck().record({
      slug,
      deviceId: deckSelectedInputId,
      onChannelsKnown: async (channels, sampleRate) => {
        const takeNo = takeModel.nextTakeNumber(deckManifest);
        const take = takeModel.makeTake({ slug, take: takeNo, sampleRate, channels, capturedWithoutInterface: channels !== 2 }, nowISO());
        deckManifest = takeModel.appendTake(deckManifest, take);
        await takeStore.writeManifest(path, deckManifest);
        deckRecording = true;
        currentTake = null;
        render();
        return takeNo;
      },
    });
    started = !!result.ok;
    if (!result.ok && result.denied) deckBlocked = true;
  } catch {
    // A failure AFTER onChannelsKnown already flipped deckRecording=true (e.g.
    // AudioWorkletNode construction or openTakeFiles rejecting) would otherwise
    // strand the UI nav-locked forever (audioEngine's own `recording` flag never
    // got set, so a later Stop short-circuits and never fires onStatus).
    deckStatus = { type: 'error', message: 'Could not start recording (setup failed).' };
  } finally {
    deckArming = false;
    if (!started) deckRecording = false; // only clobber on failure — success already set it true above
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
      // Best-effort: drop the deleted song's save-in-place handle (session + IndexedDB).
      fileHandles.delete(id);
      audioStore.deleteFileHandle(id).catch(() => {});
      // Best-effort: drop the deleted song's audio blobs (reconcile also GCs them later).
      if (gone && gone.sketches && gone.sketches.length) audioStore.deleteMany(gone.sketches.map((sk) => sk.id)).catch(() => {});
      // §5.7: also GC its OPFS take directory (no boot-time GC, D30 — deletion is
      // the one place a song's takes get removed, immediately, with confirm).
      if (gone && gone.tapeDeck) takeStore.deleteSongTakes(gone.id).catch(() => {});
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
      const res = await importSongsFromText(text);
      if (res.ok && res.count === 1) await rememberHandle(res.ids[0], handle);
      afterOpen(res, handle.name);
    },

    // Open a song from text read via a hidden <input type=file> (iOS / Chrome Android /
    // any no-File-System-Access platform). No handle, so the link is name-only.
    onOpenSongText: async (text, filename) => {
      const res = await importSongsFromText(text);
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
      deckTakeMenuOpen = false;
      deckIsRetake = false;
      render();

      if (!(await takeStore.isSupported())) { if (!stale()) { deckUnsupported = true; render(); } return; }
      if (stale()) return;
      deckUnsupported = false;

      await ensurePersist();
      if (stale()) return;
      const path = manifestPath(a.id);
      let manifest;
      try {
        const raw = await takeStore.readManifest(path);
        const v = takeModel.validateManifest(raw);
        if (!v.ok) { manifest = takeModel.createManifest(a.id); if (!stale()) { deckStatus = { type: 'error', message: 'This song’s take history looked corrupted and could not be loaded.' }; } }
        else manifest = takeModel.normalizeManifest(raw);
      } catch { manifest = takeModel.createManifest(a.id); }
      if (stale()) return;

      // Crash recovery (§5.3): finalize any take a prior session left mid-record
      // BEFORE mostRecentKeptTake can see it. Prefer stem1's byte count for
      // duration (both stems share one sampleRate/duration by construction) but
      // fall back to stem2's — an asymmetric partial-write failure (empty
      // stem1, real audio in stem2) must not tombstone-and-orphan real audio.
      const dir = takeModel.tapeDeckRef(a.id).path;
      for (const t of manifest.takes.slice()) {
        if (t.status !== 'recording') continue;
        const stem1 = t.stems && t.stems.stem1;
        const stem2 = t.stems && t.stems.stem2;
        let stem1Bytes = 0, stem2Bytes = 0;
        if (stem1 && stem1.file) { try { stem1Bytes = await takeStore.finalizeExisting(dir + stem1.file, SIZE_FIELDS); } catch { stem1Bytes = 0; } }
        if (stem2 && stem2.file) { try { stem2Bytes = await takeStore.finalizeExisting(dir + stem2.file, SIZE_FIELDS); } catch { stem2Bytes = 0; } }
        manifest = takeModel.finalizeRecoveredTake(manifest, t.take, stem1Bytes || stem2Bytes, t.sampleRate);
      }
      if (stale()) return;

      // Stamp the song's small OPFS reference on first open only (AC-19),
      // BEFORE writing the manifest: if the app dies between these two writes,
      // a dangling tapeDeck ref with no manifest.json yet self-heals on next
      // open (load-or-create, D30) — the reverse order could instead leave a
      // real OPFS directory with no song record pointing at it.
      if (!a.tapeDeck) updateActive((s, now) => (s.id === a.id ? { ...s, tapeDeck: takeModel.tapeDeckRef(a.id), updatedAt: now } : s));
      if (stale()) return;
      await takeStore.writeManifest(path, manifest);
      if (stale()) return;

      deckManifest = manifest;
      const kept = takeModel.mostRecentKeptTake(manifest);
      currentTake = kept ? kept.take : null;

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

    onCloseTapeDeck: () => {
      if (deckRecording) return; // AC-27
      // AC-8: Back is also a valid way to "dismiss" an open take menu, and
      // dismissing must load the newest take (tapeView's explicit "Use newest"
      // button covers the direct case; this covers backing out via the header).
      if (deckTakeMenuOpen && deckManifest) {
        const kept = takeModel.mostRecentKeptTake(deckManifest);
        currentTake = kept ? kept.take : null;
      }
      songSubView = 'sections';
      if (tapeDeck) tapeDeck.stopPlay();
      deckTakeMenuOpen = false;
      render();
    },

    onRecordTake: () => armRecording(),

    onStopTake: async () => {
      if (!tapeDeck || !deckRecording) return;
      await tapeDeck.stop(); // resolves after onStatus('stopped',...) has already finalized the manifest
    },

    // AC-7: Keep/Discard both arm a fresh recording; only Discard also tombstones.
    onKeepTake: () => { deckIsRetake = true; armRecording(); },
    onDiscardLastTake: async () => {
      const a = activeSong();
      if (!a || !deckManifest || !deckManifest.takes.length) return;
      const last = deckManifest.takes[deckManifest.takes.length - 1];
      deckManifest = takeModel.discardTake(deckManifest, last.take);
      await takeStore.writeManifest(manifestPath(a.id), deckManifest);
      takeStore.deleteTakeAudio(a.id, last.take).catch(() => {}); // metadata first, best-effort file delete second
      if (currentTake === last.take) { const kept = takeModel.mostRecentKeptTake(deckManifest); currentTake = kept ? kept.take : null; }
      deckIsRetake = true;
      render();
      await armRecording();
    },
    onCancelRetake: () => { deckStatus = null; render(); },

    // AC-22: per-take Delete — the storage relief valve, available for any take, any time.
    onDeleteTake: async (takeNo) => {
      const a = activeSong();
      // A bounce mid-flight for this same take would otherwise write an
      // orphaned _mix.wav after the delete tombstones it (markBounced's
      // takeNo would no longer match anything). Simplest safe rule: no
      // deletes while any bounce is in flight (tapeView also disables the
      // buttons — this is the defense-in-depth backstop).
      if (!a || !deckManifest || deckBouncing) return;
      deckManifest = takeModel.discardTake(deckManifest, takeNo);
      await takeStore.writeManifest(manifestPath(a.id), deckManifest);
      takeStore.deleteTakeAudio(a.id, takeNo).catch(() => {});
      if (currentTake === takeNo) {
        if (tapeDeck) tapeDeck.stopPlay();
        const kept = takeModel.mostRecentKeptTake(deckManifest);
        currentTake = kept ? kept.take : null;
      }
      await refreshSpaceWarning();
      render();
    },

    // AC-8 take-menu selection, or a plain "Load" from take history.
    onSelectTake: (takeNo) => {
      if (tapeDeck) tapeDeck.stopPlay();
      currentTake = takeNo;
      deckTakeMenuOpen = false;
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

    onBounceTake: async () => {
      const a = activeSong();
      if (!a || !deckManifest || currentTake == null || !tapeDeck || deckBouncing) return;
      const take = deckManifest.takes.find((t) => t.take === currentTake);
      if (!take) return;
      const takeNo = take.take;              // snapshot — `currentTake` can change while this await is in flight
      deckBouncing = true;
      render();
      const result = await tapeDeck.bounce(take, a.id);
      deckBouncing = false;
      if (!result.ok) { deckStatus = { type: 'error', message: 'Bounce failed: ' + result.error }; render(); return; }
      // The take may have been discarded/deleted while the bounce was running
      // (onDeleteTake also guards on deckBouncing, but this stays correct even
      // if that guard is ever bypassed): don't resurrect a tombstoned take's
      // bounce record, and don't leave an orphaned _mix.wav unexplained.
      const stillActive = deckManifest.takes.find((t) => t.take === takeNo && t.status === 'active');
      if (!stillActive) { takeStore.deleteTakeAudio(a.id, takeNo).catch(() => {}); render(); return; }
      deckManifest = takeModel.markBounced(deckManifest, takeNo, { file: result.file, bouncedAt: nowISO(), lufs: result.lufs });
      await takeStore.writeManifest(manifestPath(a.id), deckManifest);
      await refreshSpaceWarning();
      render();
    },

    // AC-20: the only way take audio leaves the app. `which` is 'stem1'|'stem2'|'bounce'.
    // `takeNo` defaults to the loaded take (loadedActions' per-stem/mix buttons);
    // AC-10 also needs Share reachable straight from a take-history row without
    // first Loading it, so historyRow passes its own take's number explicitly.
    onShareTake: async (which, takeNo) => {
      const a = activeSong();
      const tn = takeNo != null ? takeNo : currentTake;
      if (!a || !deckManifest || tn == null) return;
      const take = deckManifest.takes.find((t) => t.take === tn);
      if (!take) return;
      const fileRef = which === 'bounce' ? (take.bounce && take.bounce.file) : (take.stems[which] && take.stems[which].file);
      if (!fileRef) return;
      let bytes;
      try { bytes = await takeStore.readFile(takeModel.tapeDeckRef(a.id).path + fileRef); }
      catch { deckStatus = { type: 'error', message: 'Could not read that file.' }; render(); return; }
      await shareOrDownloadBlob(new Blob([bytes], { type: 'audio/wav' }), fileRef, 'audio/wav');
    },

    // Ephemeral playback — no persisted state, so these go straight to the
    // controller rather than through a manifest-mutating handler (sketches
    // precedent: compare onLoadSketchBlob / makeSketchPlayer).
    onPlayTake: (take, slug) => ensureTapeDeck().play(take, slug),
    onReplayTake: (take, slug) => ensureTapeDeck().replay(take, slug),
    onStopPlayTake: () => { if (tapeDeck) tapeDeck.stopPlay(); },

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

  if (!feelList.length) {
    rootEl.textContent = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'max-width:520px;margin:60px auto;text-align:center;color:#8b93a3;font:600 15px/1.6 -apple-system,sans-serif';
    msg.textContent = 'Could not load feels. Check your connection and reload.';
    rootEl.appendChild(msg);
    return;
  }

  state = load(feelIds, builtinIds);
  songs = loadSongs();
  songs = await reconcileSketches(songs);   // drop dangling sketch metadata, GC orphan blobs
  app = mountApp(rootEl, handlers);
  commit();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
