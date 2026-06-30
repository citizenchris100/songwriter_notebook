// main.js — composition root. Loads feels (from JSON + localStorage) and songs (from
// localStorage), wires controls/import/export -> state -> derive -> ui across both the
// Progressions and Songs tabs, and registers the service worker. The only stateful,
// side-effectful module.
//
// Tab/song state (currentView, draftSong, currentSongId) is intentionally in-memory
// only: it is not part of the deep-linkable generator state (persistence.js), and on
// reload the app opens on Progressions with the Songs tab blank. Songs themselves are
// persisted to localStorage (sn_songs). A single explicit Save is the persistence point
// for a new draft; edits to an already-saved song autosave.
import { deriveOutput } from './derive.js';
import { validate, randomize, DEFAULT_FEEL } from './session.js';
import { load, save, reflectUrl } from './persistence.js';
import { loadBuiltinFeels, loadUserFeels, saveUserFeels } from './feelStore.js';
import { validateFeel, normalizeFeel, mergeFeels } from './feels.js';
import { loadSongs, saveSongs } from './songStore.js';
import {
  validateSong, normalizeSong, nextUntitledName, slugifySongId, buildCapturedProgression,
  createSong, appendProgressions, reorderProgression, removeProgression,
  setProgressionLabel, setLyrics, renameSong, finalizeDraft,
} from './songs.js';
import { mountApp } from './ui.js';

const rootEl = document.getElementById('app');
const nowISO = () => new Date().toISOString();

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
let currentSongId = null;   // id of the selected saved song (null when none/draft)
let draftSong = null;       // an unsaved new song (from "Create song"); no id yet
let genFlash = null;        // transient note on the generator (e.g. "Added to …")

function recompute() {
  const merged = mergeFeels(builtinFeels, userFeels);
  feelList = merged.list;
  feelsById = merged.byId;
  feelIds = feelList.map((f) => f.id);
}

// The song currently open in the Songs tab: the unsaved draft, else the selected saved song.
function activeSong() {
  if (draftSong) return draftSong;
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
    isDraft: !!draftSong,
    hasCurrentSong: !!active,
    currentSongName: active ? (draftSong ? '(unsaved draft)' : active.name) : '',
    selectedId: draftSong ? '__draft__' : (currentSongId || null),
    nextName: nextUntitledName(songs.map((s) => s.name)),
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

// Apply a pure transform to the active song. For a saved song this also persists
// immediately (edits autosave); a draft only mutates in memory until first Save.
function updateActive(fn) {
  const now = nowISO();
  if (draftSong) { draftSong = fn(draftSong, now); return; }
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

// Build a clean songs/<id>.json-shaped object for export.
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
  };
}

function download(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    const now = nowISO();
    draftSong = appendProgressions(createSong(now), snaps, now);
    currentSongId = null;
    currentView = 'songs';
    genFlash = null;
    render();
  },
  onAddToCurrent: (indices) => {
    if (!activeSong()) return;
    const snaps = snapshotsFor(indices);
    if (!snaps.length) return;
    updateActive((s, now) => appendProgressions(s, snaps, now));
    const a = activeSong();
    genFlash = '✓ Added to ' + (draftSong ? 'the new song' : a.name);
    render();
  },

  // ---- the Songs tab ----
  songs: {
    onSelectSong: (target) => {
      genFlash = null;
      if (target === '__draft__') return; // already the active draft
      draftSong = null;
      currentSongId = target || null;
      render();
    },
    onSetLabel: (i, lblValue) => { updateActive((s, now) => setProgressionLabel(s, i, lblValue, now)); render(); },
    onReorder: (i, dir) => { updateActive((s, now) => reorderProgression(s, i, dir, now)); render(); },
    onRemoveProgression: (i) => { updateActive((s, now) => removeProgression(s, i, now)); render(); },

    // Capture lyrics without re-rendering (keeps the textarea caret); autosaves a saved song.
    onLyricsChange: (text) => { updateActive((s, now) => setLyrics(s, text, now)); },

    onSaveSong: (name) => {
      if (draftSong) {
        const finalName = (name && String(name).trim()) ? String(name).trim() : nextUntitledName(songs.map((s) => s.name));
        const finalized = finalizeDraft(draftSong, finalName, songs.map((s) => s.id), nowISO());
        songs = songs.concat(finalized);
        saveSongs(songs);
        currentSongId = finalized.id;
        draftSong = null;
      } else if (currentSongId) {
        saveSongs(songs); // already current; persist for reassurance
      }
      render();
    },
    onRenameSong: (name) => {
      const nm = name && String(name).trim();
      if (!nm || draftSong || !currentSongId) { render(); return; }
      songs = songs.map((s) => (s.id === currentSongId ? renameSong(s, nm, nowISO()) : s));
      saveSongs(songs);
      render();
    },
    onDeleteSong: (id) => {
      songs = songs.filter((s) => s.id !== id);
      saveSongs(songs);
      if (currentSongId === id) currentSongId = null;
      render();
    },

    // Import a pasted/uploaded song JSON. Returns { ok, name } or { ok:false, error }.
    onImportSong: (text) => {
      let obj;
      try { obj = JSON.parse(text); } catch { return { ok: false, error: 'not valid JSON' }; }
      const v = validateSong(obj);
      if (!v.ok) return { ok: false, error: v.errors[0] };
      let s = normalizeSong(obj);
      const now = nowISO();
      if (!s.createdAt) s = { ...s, createdAt: now };
      if (!s.updatedAt) s = { ...s, updatedAt: now };
      if (songs.some((x) => x.id === s.id)) s = { ...s, id: slugifySongId(s.name, songs.map((x) => x.id)) };
      songs = songs.concat(s);
      saveSongs(songs);
      draftSong = null;
      currentSongId = s.id;
      currentView = 'songs';
      render();
      return { ok: true, name: s.name };
    },
    onExportCurrent: () => {
      const a = activeSong();
      if (a && a.id) download(a.id + '.json', toSongFile(a)); // a draft has no id yet; save it first
    },
    onExportAllSongs: () => { if (songs.length) download('songwriter-songs.json', songs.map(toSongFile)); },
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
  app = mountApp(rootEl, handlers);
  commit();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
