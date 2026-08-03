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
  toSongFile,
} from './songs.js';
import { isAcceptedAudio, makeSketchMeta, addSketchMeta, removeSketchMeta, setSketchNotes } from './sketches.js';
import * as audioStore from './audioStore.js';
import { chordFromRootAndQuality } from './theory/roman.js';
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
// is built by the PURE `toSongFile` in songs.js — the single writer of the .json shape.

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
async function importOneSong(raw, mode = 'import') {
  const v = validateSong(raw);
  if (!v.ok) return { ok: false, error: v.errors[0] };
  let s = normalizeSong(raw);
  const now = nowISO();
  if (!s.createdAt) s = { ...s, createdAt: now };
  if (!s.updatedAt) s = { ...s, updatedAt: now };

  // Open (the user's OWN .json) vs Import (a foreign/shared bundle) differ on identity:
  //  - Open + an existing record with the SAME id AND createdAt → genuine RE-OPEN: keep the id
  //    and REPLACE the record in place (never concat → no duplicate id).
  //  - Open + an id not present here → first open on this device: keep the id, concat.
  //  - A collision with a DIFFERENT song (createdAt differs), or any Import → reslug the id.
  //    createdAt is the identity token: normalizeSong preserves it and edits only bump updatedAt,
  //    so it distinguishes a re-open from a same-named different song.
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

// Convenience for a synchronously-built payload (feels): the object is already in hand, so
// opening the picker first keeps the click gesture intact.
async function download(filename, obj) {
  await writeJsonSink(await openJsonSink(filename), obj);
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
  onTab: (tab) => { genFlash = null; currentView = tab; render(); },

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
      if (currentSongId === id) { currentSongId = null; currentSketchId = null; sketchFlash = null; songFlash = null; }
      render();
      // Best-effort: drop the deleted song's save-in-place handles (session + IndexedDB):
      // the .json handle (keyed by id) and the .md companion handle (id + '::md').
      fileHandles.delete(id);
      audioStore.deleteFileHandle(id).catch(() => {});
      fileHandles.delete(id + '::md');
      audioStore.deleteFileHandle(id + '::md').catch(() => {});
      // Best-effort: drop the deleted song's audio blobs (reconcile also GCs them later).
      if (gone && gone.sketches && gone.sketches.length) audioStore.deleteMany(gone.sketches.map((sk) => sk.id)).catch(() => {});
    },

    // Duplicate the open song under a new name: clone its progressions/lyrics/sketches (each
    // sketch's audio copied under a FRESH id so the copy owns private bytes), then choose a save
    // location and write the copy's self-contained .json — the same openJsonSink/writeJsonSink
    // flow as New/Save. Then switch to the copy.
    onDupeSong: async (rawName) => {
      const a = activeSong();
      if (!a || !a.id) return;
      const name = String(rawName || '').trim();
      if (!name) { songFlash = { ok: false, error: 'give the duplicate a name' }; render(); return; }
      const newId = slugifySongId(name, songs.map((s) => s.id));

      // Copy each sketch's audio blob under a fresh id (mirrors importOneSong; a missing blob is dropped).
      const sketchIdMap = {};
      for (const sk of (a.sketches || [])) {
        let blob;
        try { blob = await audioStore.getBlob(sk.id); } catch { blob = null; }
        if (!blob) continue;
        const nid = newSketchId();
        try { await audioStore.putBlob(nid, blob); sketchIdMap[sk.id] = nid; } catch { /* write failed → drop this sketch */ }
      }
      const dup = duplicateSong(a, { id: newId, name, now: nowISO(), sketchIdMap });

      // Choose a save location + write the copy's .json (self-contained: base64 sketch audio inline).
      const sink = await openJsonSink(newId + '.json');
      if (!sink) return;   // cancelled the save dialog → nothing created (orphan blobs GC on next reconcile)
      try {
        if (!(await writeJsonSink(sink, await toSongBundle(dup)))) return;   // iOS share sheet dismissed
        const savedName = (sink.handle && sink.handle.name) || sink.name || (newId + '.json');
        if (sink.handle) await rememberHandle(newId, sink.handle);
        songs = songs.concat({ ...dup, file: { name: savedName } });
        saveSongs(songs);
        currentSongId = newId;
        currentSketchId = null;
        sketchFlash = null;
        songFlash = { ok: true, name: savedName };
        render();
      } catch {
        songFlash = { ok: false, error: 'could not save the duplicate' };
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
      const res = await importSongsFromText(text, 'open'); // Open of one's own .json: keep its id
      if (res.ok && res.count === 1) await rememberHandle(res.ids[0], handle);
      afterOpen(res, handle.name);
    },

    // Open a song from text read via a hidden <input type=file> (iOS / Chrome Android /
    // any no-File-System-Access platform). No handle, so the link is name-only.
    onOpenSongText: async (text, filename) => {
      const res = await importSongsFromText(text, 'open'); // Open of one's own .json: keep its id
      afterOpen(res, filename || null);
    },

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
  // song's durable copy (the .json on disk) is unaffected, but the fast per-device cache is stale,
  // so tell the user rather than let it fail silently.
  onSaveError(() => {
    songFlash = { ok: false, error: 'This device’s storage is full — your song is still safe in its .json file, but the in-app copy could not update. Free some space and Save again.' };
    render();
  });
  commit();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
