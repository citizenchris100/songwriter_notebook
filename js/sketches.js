// js/sketches.js — PURE sketch model: audio-format acceptance, the metadata factory +
// validation/normalization, and immutable transforms on a song's sketches[]. Mirrors
// js/songs.js. No DOM, no Blob, no IndexedDB, no Date, no crypto — the sketch id and
// `now` are INJECTED by the impure shell (main.js), exactly as `now` is threaded through
// the song transforms. That keeps this file node-importable, so engine.test.js loads it.
//
// A SKETCH is an audio idea (a phone recording) attached to a song. Only the METADATA
// lives here (and, persisted, in the song object under sketches[]); the audio BYTES live
// in IndexedDB (js/audioStore.js), keyed by the sketch id. Base64 audio exists only
// transiently inside an exported bundle — never in this model or in localStorage.

const str = (x) => (typeof x === 'string' ? x : '');

// Only .m4a is accepted (the format the user's phone produces; it decodes reliably in an
// iOS <audio> element). The file extension is authoritative; mimeType is advisory only,
// because phones/OSes set it inconsistently.
export const ACCEPTED_FORMATS = ['m4a'];

export function isAcceptedAudio(filename /* , mimeType */) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'm4a') return { ok: true, format: 'm4a' };
  return { ok: false, error: 'Only .m4a audio files are supported.' };
}

// The metadata record persisted inside a song's sketches[]. Pure factory; the globally
// unique `id` and the `now` timestamp are injected by the caller.
export function makeSketchMeta(fields, now) {
  return {
    id: String(fields.id),
    filename: str(fields.filename),
    mimeType: str(fields.mimeType),
    format: 'm4a',
    size: Number.isFinite(fields.size) ? fields.size : 0,
    addedAt: now,
    notes: '',
  };
}

// Validate one sketch metadata record. Returns { ok, errors }. Strict on id/filename/
// format; tolerant of unknown keys (additive-friendly, like validateSong).
export function validateSketchMeta(m) {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['sketch must be an object'] };
  const errors = [];
  if (typeof m.id !== 'string' || m.id.length < 1) errors.push('sketch id must be a non-empty string');
  if (typeof m.filename !== 'string' || m.filename.length < 1) errors.push('sketch filename must be a non-empty string');
  if (m.format !== 'm4a') errors.push('sketch format must be "m4a"');
  if ('mimeType' in m && typeof m.mimeType !== 'string') errors.push('sketch mimeType must be a string');
  if ('size' in m && typeof m.size !== 'number') errors.push('sketch size must be a number');
  if ('addedAt' in m && typeof m.addedAt !== 'string') errors.push('sketch addedAt must be a string');
  if ('notes' in m && typeof m.notes !== 'string') errors.push('sketch notes must be a string');
  return { ok: errors.length === 0, errors };
}

// Reduce a raw sketch to the persisted shape (drops unknown keys, fills optionals). Pure.
export function normalizeSketch(m) {
  return {
    id: str(m.id),
    filename: str(m.filename),
    mimeType: str(m.mimeType),
    format: 'm4a',
    size: typeof m.size === 'number' ? m.size : 0,
    addedAt: str(m.addedAt),
    notes: str(m.notes),
  };
}

// ---- immutable transforms on a song's sketches[] (return a new song; `now` injected) ----

export function addSketchMeta(song, meta, now) {
  return { ...song, sketches: (song.sketches || []).concat([meta]), updatedAt: now };
}

export function removeSketchMeta(song, sketchId, now) {
  const prev = song.sketches || [];
  const sketches = prev.filter((s) => s.id !== sketchId);
  if (sketches.length === prev.length) return song; // not found — no-op (don't bump updatedAt)
  return { ...song, sketches, updatedAt: now };
}

export function setSketchNotes(song, sketchId, notes, now) {
  const prev = song.sketches || [];
  let hit = false;
  const sketches = prev.map((s) => (s.id === sketchId ? (hit = true, { ...s, notes: String(notes) }) : s));
  if (!hit) return song;
  return { ...song, sketches, updatedAt: now };
}
