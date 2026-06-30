// js/songs.js — PURE song model: validation, normalization, the captured-progression
// snapshot builder, and immutable transforms. Mirrors js/feels.js. No DOM, no fetch,
// no storage, and no Date (time is injected as `now`) — node-importable, so the engine
// test can load it.
//
// A SONG is an ordered list of CAPTURED PROGRESSIONS plus lyrics. Each captured
// progression is a FIXED SNAPSHOT — the chord name+notes are frozen at capture time
// and never re-derived — together with provenance (which feel/key it came from) and a
// presets-only section label (Verse, Chorus, …).

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Presets-only labels for a captured progression ('' = unlabeled).
export const SECTION_LABELS = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Solo', 'Outro'];
const LABEL_SET = new Set(['', ...SECTION_LABELS]);

const isStr = (x) => typeof x === 'string';
const str = (x) => (typeof x === 'string' ? x : '');
const PROV_STR_KEYS = ['feelId', 'feelName', 'root', 'accidental', 'mode', 'keyLabel', 'role'];

// Validate a song object. Returns { ok, errors }. Strict on the known structural
// fields (id slug, name, progressions, chord shape, label preset, provenance types)
// but DELIBERATELY tolerant of unknown TOP-LEVEL and PROGRESSION-LEVEL keys, so future
// per-song metadata (tempo, time signature, tags) is additive without breaking old
// records. The chord object stays strict (the snapshot shape is contractual).
export function validateSong(s) {
  if (s == null || typeof s !== 'object' || Array.isArray(s)) return { ok: false, errors: ['song must be an object'] };
  const errors = [];
  if (typeof s.id !== 'string' || !SLUG.test(s.id)) errors.push('id must be a slug matching ^[a-z0-9][a-z0-9-]*$');
  if (typeof s.name !== 'string' || s.name.length < 1) errors.push('name must be a non-empty string');
  if ('schemaVersion' in s && s.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if ('lyrics' in s && typeof s.lyrics !== 'string') errors.push('lyrics must be a string');
  if ('createdAt' in s && typeof s.createdAt !== 'string') errors.push('createdAt must be a string');
  if ('updatedAt' in s && typeof s.updatedAt !== 'string') errors.push('updatedAt must be a string');

  if (!Array.isArray(s.progressions) || s.progressions.length < 1) errors.push('progressions must be a non-empty array');
  else s.progressions.forEach((p, i) => validateProgression(p, i, errors));

  return { ok: errors.length === 0, errors };
}

function validateProgression(p, i, errors) {
  const at = 'progression ' + i;
  if (p == null || typeof p !== 'object' || Array.isArray(p)) { errors.push(at + ' must be an object'); return; }
  if ('label' in p && !LABEL_SET.has(p.label)) errors.push(at + ' label must be one of "", ' + SECTION_LABELS.join(', '));
  if ('title' in p && typeof p.title !== 'string') errors.push(at + ' title must be a string');

  if (!Array.isArray(p.chords) || p.chords.length < 1) errors.push(at + ' must have a non-empty chords array');
  else p.chords.forEach((c, j) => {
    const cAt = at + ' chord ' + j;
    if (c == null || typeof c !== 'object' || Array.isArray(c)) { errors.push(cAt + ' must be an object'); return; }
    if (typeof c.name !== 'string' || c.name.length < 1) errors.push(cAt + ' name must be a non-empty string');
    if (!Array.isArray(c.notes) || c.notes.length < 1 || !c.notes.every(isStr)) errors.push(cAt + ' notes must be a non-empty array of strings');
    for (const k of Object.keys(c)) if (k !== 'name' && k !== 'notes') errors.push(cAt + ' has unknown property: ' + k);
  });

  if ('provenance' in p) {
    const pv = p.provenance;
    if (pv == null || typeof pv !== 'object' || Array.isArray(pv)) errors.push(at + ' provenance must be an object');
    else {
      if ('chromatic' in pv && typeof pv.chromatic !== 'boolean') errors.push(at + ' provenance.chromatic must be a boolean');
      for (const k of PROV_STR_KEYS) if (k in pv && typeof pv[k] !== 'string') errors.push(at + ' provenance.' + k + ' must be a string');
    }
  }
}

// Reduce a validated song to the fields the app persists (drops unknown/$schema keys,
// fills missing optionals). Pure.
export function normalizeSong(s) {
  return {
    schemaVersion: 1,
    id: s.id,
    name: s.name,
    createdAt: str(s.createdAt),
    updatedAt: str(s.updatedAt),
    lyrics: str(s.lyrics),
    progressions: (s.progressions || []).map(normalizeProgression),
  };
}

function normalizeProgression(p) {
  const out = {
    label: LABEL_SET.has(p.label) ? p.label : '',
    title: str(p.title),
    chords: (p.chords || []).map((c) => ({ name: c.name, notes: c.notes.slice() })),
  };
  if (p.provenance && typeof p.provenance === 'object' && !Array.isArray(p.provenance)) {
    const pv = p.provenance;
    out.provenance = {
      feelId: str(pv.feelId), feelName: str(pv.feelName),
      root: str(pv.root), accidental: str(pv.accidental), mode: str(pv.mode),
      chromatic: !!pv.chromatic, keyLabel: str(pv.keyLabel), role: str(pv.role),
    };
  }
  return out;
}

// The next free "untitledNNN" name (3-digit, lowest unused number), given the names
// already in use. [] -> untitled000; ['untitled000','untitled002'] -> untitled001.
export function nextUntitledName(existingNames) {
  const used = new Set();
  for (const n of existingNames || []) {
    const m = /^untitled(\d{3})$/.exec(n);
    if (m) used.add(Number(m[1]));
  }
  let n = 0;
  while (used.has(n)) n++;
  return 'untitled' + String(n).padStart(3, '0');
}

// Derive a unique song id slug from a name, suffixing -2, -3, … to avoid colliding
// with takenIds. Songs are content, so we never clobber an existing id.
export function slugifySongId(name, takenIds) {
  let base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = 'song';
  const taken = new Set(takenIds || []);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(base + '-' + n)) n++;
  return base + '-' + n;
}

// Snapshot a derive Section into a captured progression: freeze name+notes and record
// provenance. Pure — given the state + model the UI already holds.
export function buildCapturedProgression(state, model, section) {
  return {
    label: '',
    title: section.title,
    chords: section.chords.map((c) => ({ name: c.name, notes: c.notes.slice() })),
    provenance: {
      feelId: state.feel,
      feelName: model.feelName,
      root: state.root,
      accidental: state.accidental,
      mode: state.mode,
      chromatic: model.chromatic,
      keyLabel: section.keyLabel,
      role: section.role,
    },
  };
}

// ---- immutable transforms (return a new song; `now` is injected) ----

// A fresh, unsaved draft: no id yet (assigned at first save via finalizeDraft).
export function createSong(now) {
  return { schemaVersion: 1, id: '', name: '', createdAt: now, updatedAt: now, lyrics: '', progressions: [] };
}

export function appendProgressions(song, snaps, now) {
  return { ...song, progressions: song.progressions.concat(snaps), updatedAt: now };
}

export function reorderProgression(song, index, dir, now) {
  const j = index + dir;
  if (index < 0 || index >= song.progressions.length || j < 0 || j >= song.progressions.length) return song;
  const ps = song.progressions.slice();
  const [moved] = ps.splice(index, 1);
  ps.splice(j, 0, moved);
  return { ...song, progressions: ps, updatedAt: now };
}

export function removeProgression(song, index, now) {
  if (index < 0 || index >= song.progressions.length) return song;
  const ps = song.progressions.slice();
  ps.splice(index, 1);
  return { ...song, progressions: ps, updatedAt: now };
}

export function setProgressionLabel(song, index, label, now) {
  if (index < 0 || index >= song.progressions.length) return song;
  const lbl = LABEL_SET.has(label) ? label : '';
  const ps = song.progressions.map((p, i) => (i === index ? { ...p, label: lbl } : p));
  return { ...song, progressions: ps, updatedAt: now };
}

export function setLyrics(song, lyrics, now) {
  return { ...song, lyrics: String(lyrics), updatedAt: now };
}

export function renameSong(song, name, now) {
  return { ...song, name: String(name), updatedAt: now };
}

// Turn a draft into a saved song: assign a unique id from the (final) name. Keeps the
// draft's createdAt; bumps updatedAt.
export function finalizeDraft(draft, name, takenIds, now) {
  return { ...draft, id: slugifySongId(name, takenIds), name: String(name), updatedAt: now };
}
