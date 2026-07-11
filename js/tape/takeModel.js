// js/tape/takeModel.js — PURE take & manifest model: validation/normalization,
// immutable manifest transforms, naming helpers, and the effect-settings + DSP
// mapping constants. Mirrors js/songs.js and js/sketches.js: no DOM, no OPFS, no
// Date, no crypto — take numbers, timestamps and ids are INJECTED by the impure
// shell (js/tape/audioEngine.js / js/main.js), so this stays node-importable and
// engine.test.js loads it directly.
//
// A per-song MANIFEST (OPFS takes/<slug>/manifest.json) holds an ordered list of
// TAKE records. A take enters the manifest at record START with status
// "recording" (D22) — before any audio byte exists — so a crash mid-take is
// recoverable rather than orphaned. Discard/delete never removes the take
// record, only its audio (tombstone, D10/D23): this is what keeps take numbers
// monotonic and legible.

const str = (x) => (typeof x === 'string' ? x : '');
const isNum = (x) => typeof x === 'number' && isFinite(x);

export const STEM_KEYS = ['stem1', 'stem2'];
export const TAKE_STATUS = ['recording', 'active', 'discarded'];

// ---- effect-settings model (D17 neutral compressor, D25 clamped bounce gain) ----

export const LUFS_TARGET = -14;
export const LUFS_FLOOR = -50;
export const BOUNCE_GAIN_DB_MIN = -12;
export const BOUNCE_GAIN_DB_MAX = 20;
export const LIMITER_CEILING_DB = -1;

// 3-band EQ: lowshelf/peaking/highshelf, each ±12 dB, detent 0 = flat.
export const EQ_BANDS = [
  { key: 'bass', type: 'lowshelf', freq: 100 },
  { key: 'mid', type: 'peaking', freq: 1000, Q: 0.9 },
  { key: 'treble', type: 'highshelf', freq: 3500 },
];
export const EQ_GAIN_DB = { min: -12, max: 12 };

const clampNum = (v, lo, hi, dflt) => (isNum(v) ? Math.max(lo, Math.min(hi, v)) : dflt);

// Clamp/shape a partial stem-settings patch into the full persisted shape.
// vol 0–1.5 (default 1.0), each eq band −12…+12 dB (default 0), comp 0–1 (default 0).
export function clampStemSettings(s) {
  const src = s || {};
  const eq = src.eq || {};
  return {
    vol: clampNum(src.vol, 0, 1.5, 1.0),
    eq: {
      bass: clampNum(eq.bass, EQ_GAIN_DB.min, EQ_GAIN_DB.max, 0),
      mid: clampNum(eq.mid, EQ_GAIN_DB.min, EQ_GAIN_DB.max, 0),
      treble: clampNum(eq.treble, EQ_GAIN_DB.min, EQ_GAIN_DB.max, 0),
    },
    comp: clampNum(src.comp, 0, 1, 0),
  };
}

export function defaultStemSettings() {
  return clampStemSettings({});
}

// One-knob compressor c∈[0,1] -> DynamicsCompressorNode params. D17: the node is
// ALWAYS in circuit (never bypass-routed), so c=0 must yield an exact unity/neutral
// curve — threshold 0, ratio 1, knee 0 — rather than whatever the general formula
// would naively evaluate to at c=0 (threshold −6, ratio 1.5, knee 30).
export function compressorParams(c) {
  const cc = clampNum(c, 0, 1, 0);
  if (cc === 0) return { threshold: 0, ratio: 1, knee: 0, attack: 0.020, release: 0.400, makeupDb: 0 };
  const threshold = -6 - 30 * cc;
  const ratio = 1.5 + 6.5 * cc;
  const knee = 30 - 24 * cc;
  const attack = 0.020 - 0.017 * cc;
  const release = 0.400 - 0.250 * cc;
  const makeupDb = 0.5 * (-threshold) * (1 - 1 / ratio);
  return { threshold, ratio, knee, attack, release, makeupDb };
}

// The bounce normalization-gain rule (D25): clamp toward the LUFS target, but
// never boost a near-silent/silent take. Pure so it is testable independent of
// the live audio graph; js/tape/audioEngine.js's bounce pipeline calls this
// directly with the value lufs.js measured.
export function bounceGainDb(measuredLufs) {
  if (measuredLufs === -Infinity || !isNum(measuredLufs) || measuredLufs < LUFS_FLOOR) return 0;
  const raw = LUFS_TARGET - measuredLufs;
  return Math.max(BOUNCE_GAIN_DB_MIN, Math.min(BOUNCE_GAIN_DB_MAX, raw));
}

// ---- naming helpers (D9) ----

export function stemFileName(slug, take, stemKey) {
  return slug + '_' + take + '_' + stemKey + '.wav';
}
export function mixFileName(slug, take) {
  return slug + '_' + take + '_mix.wav';
}
// The song record's small reference to its OPFS take directory (AC-19).
export function tapeDeckRef(slug) {
  return { path: 'takes/' + slug + '/' };
}

// ---- take records ----

// Build the stems sub-object for a fresh take: one entry per captured channel
// (single-stem takes, D24, have stems.stem2 = null).
function buildStems(slug, take, channels) {
  const mk = (stemKey) => ({ file: stemFileName(slug, take, stemKey), ...defaultStemSettings() });
  return { stem1: mk('stem1'), stem2: channels === 2 ? mk('stem2') : null };
}

// The take record entered into the manifest at record START (D22), before any
// audio byte exists. `fields`: { slug, take, sampleRate, channels, capturedWithoutInterface }.
export function makeTake(fields, now) {
  return {
    take: fields.take,
    status: 'recording',
    recovered: false,
    createdAt: now,
    durationSec: null,
    sampleRate: fields.sampleRate,
    channels: fields.channels,
    capturedWithoutInterface: !!fields.capturedWithoutInterface,
    stems: buildStems(fields.slug, fields.take, fields.channels),
    bounce: null,
  };
}

// Monotonic next take number: scans ALL takes (active, discarded, AND
// "recording") so a number is never reused, including a take that died mid-record.
export function nextTakeNumber(manifest) {
  const takes = (manifest && manifest.takes) || [];
  return takes.reduce((max, t) => Math.max(max, isNum(t.take) ? t.take : 0), 0) + 1;
}

// Append a freshly-made take (status "recording") to the manifest.
export function appendTake(manifest, take) {
  return { ...manifest, takes: manifest.takes.concat([take]) };
}

function mapTake(manifest, takeNo, fn) {
  return { ...manifest, takes: manifest.takes.map((t) => (t.take === takeNo ? fn(t) : t)) };
}

// Clean stop: "recording" -> "active" with a measured duration.
export function finalizeTake(manifest, takeNo, durationSec) {
  return mapTake(manifest, takeNo, (t) => ({ ...t, status: 'active', durationSec }));
}

// Nulls every stem/bounce FILE field (audio is gone) but keeps the take record —
// the tombstone. Shared by Retake→Discard and per-take Delete (D23); any active
// take, any time.
export function discardTake(manifest, takeNo) {
  const nullFile = (stem) => (stem ? { ...stem, file: null } : null);
  return mapTake(manifest, takeNo, (t) => ({
    ...t,
    status: 'discarded',
    stems: { stem1: nullFile(t.stems && t.stems.stem1), stem2: nullFile(t.stems && t.stems.stem2) },
    bounce: t.bounce ? { ...t.bounce, file: null } : null,
  }));
}

// Crash recovery (on deck open, before a take with status "recording" is otherwise
// usable): dataBytes is the primary stem's measured on-disc byte count (0 when
// missing/empty). A nonzero count finalizes the take as active+recovered with a
// duration computed from the byte count (2 bytes/sample, mono per stem); an empty
// or missing stem tombstones it instead — reuses discardTake for that branch so
// the tombstone shape stays identical everywhere.
export function finalizeRecoveredTake(manifest, takeNo, dataBytes, rate) {
  if (!dataBytes) return discardTake(manifest, takeNo);
  const durationSec = dataBytes / (2 * rate);
  return mapTake(manifest, takeNo, (t) => ({ ...t, status: 'active', recovered: true, durationSec }));
}

// Record a completed bounce (AC-13/15: re-bounce overwrites, so this just replaces
// the single `bounce` field).
export function markBounced(manifest, takeNo, bounce) {
  return mapTake(manifest, takeNo, (t) => ({ ...t, bounce }));
}

// Merge + clamp a settings patch into one stem (vol/EQ/comp are saved, non-destructive).
// No-ops on a single-stem take's absent stem (D24: stems.stem2 stays null) —
// otherwise this would resurrect it as a schema-inconsistent {file:undefined,
// ...} object, the one thing that must never happen to a null stem slot.
export function setStemSettings(manifest, takeNo, stemKey, patch) {
  return mapTake(manifest, takeNo, (t) => {
    const current = t.stems && t.stems[stemKey];
    if (!current) return t;
    const merged = clampStemSettings({ ...current, ...patch, eq: { ...current.eq, ...(patch && patch.eq) } });
    return { ...t, stems: { ...t.stems, [stemKey]: { file: current.file, ...merged } } };
  });
}

// The take that loads when a deck opens (AC-11): the highest-numbered ACTIVE take.
export function mostRecentKeptTake(manifest) {
  const takes = ((manifest && manifest.takes) || []).filter((t) => t.status === 'active');
  if (!takes.length) return null;
  return takes.reduce((best, t) => (t.take > best.take ? t : best), takes[0]);
}

// ---- validation / normalization (defensive: reading a manifest this app wrote) ----

function validateStem(s, at, errors) {
  if (s === null) return;
  if (s == null || typeof s !== 'object' || Array.isArray(s)) { errors.push(at + ' stem must be an object or null'); return; }
  if ('file' in s && s.file !== null && typeof s.file !== 'string') errors.push(at + ' stem file must be a string or null');
  if (!isNum(s.vol)) errors.push(at + ' stem vol must be a number');
  if (!s.eq || typeof s.eq !== 'object') errors.push(at + ' stem eq must be an object');
  else for (const b of ['bass', 'mid', 'treble']) if (!isNum(s.eq[b])) errors.push(at + ' stem eq.' + b + ' must be a number');
  if (!isNum(s.comp)) errors.push(at + ' stem comp must be a number');
}

export function validateTake(t) {
  if (t == null || typeof t !== 'object' || Array.isArray(t)) return { ok: false, errors: ['take must be an object'] };
  const errors = [];
  if (!isNum(t.take)) errors.push('take number must be a number');
  if (!TAKE_STATUS.includes(t.status)) errors.push('take status must be one of ' + TAKE_STATUS.join(', '));
  if ('recovered' in t && typeof t.recovered !== 'boolean') errors.push('take recovered must be a boolean');
  if (typeof t.createdAt !== 'string') errors.push('take createdAt must be a string');
  if (t.durationSec !== null && !isNum(t.durationSec)) errors.push('take durationSec must be a number or null');
  if (!isNum(t.sampleRate)) errors.push('take sampleRate must be a number');
  if (t.channels !== 1 && t.channels !== 2) errors.push('take channels must be 1 or 2');
  if (!t.stems || typeof t.stems !== 'object') errors.push('take stems must be an object');
  else { validateStem(t.stems.stem1, 'stems.stem1', errors); validateStem(t.stems.stem2, 'stems.stem2', errors); }
  if (t.bounce !== null) {
    if (typeof t.bounce !== 'object' || Array.isArray(t.bounce)) errors.push('take bounce must be an object or null');
    else {
      if (typeof t.bounce.file !== 'string' && t.bounce.file !== null) errors.push('bounce file must be a string or null');
      if ('bouncedAt' in t.bounce && typeof t.bounce.bouncedAt !== 'string') errors.push('bounce bouncedAt must be a string');
      if ('lufs' in t.bounce && !isNum(t.bounce.lufs)) errors.push('bounce lufs must be a number');
    }
  }
  return { ok: errors.length === 0, errors };
}

function normalizeStem(s) {
  if (s === null || s === undefined) return null;
  const clamped = clampStemSettings(s);
  return { file: typeof s.file === 'string' ? s.file : null, ...clamped };
}

export function normalizeTake(t) {
  return {
    take: t.take,
    status: TAKE_STATUS.includes(t.status) ? t.status : 'discarded',
    recovered: !!t.recovered,
    createdAt: str(t.createdAt),
    durationSec: isNum(t.durationSec) ? t.durationSec : null,
    sampleRate: isNum(t.sampleRate) ? t.sampleRate : 48000,
    channels: t.channels === 1 ? 1 : 2,
    capturedWithoutInterface: !!t.capturedWithoutInterface,
    stems: { stem1: normalizeStem(t.stems && t.stems.stem1), stem2: normalizeStem(t.stems && t.stems.stem2) },
    bounce: (t.bounce && typeof t.bounce === 'object')
      ? { file: typeof t.bounce.file === 'string' ? t.bounce.file : null, bouncedAt: str(t.bounce.bouncedAt), lufs: isNum(t.bounce.lufs) ? t.bounce.lufs : null }
      : null,
  };
}

export function validateManifest(m) {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest must be an object'] };
  const errors = [];
  if ('schemaVersion' in m && m.schemaVersion !== 1) errors.push('manifest schemaVersion must be 1');
  if (typeof m.slug !== 'string' || m.slug.length < 1) errors.push('manifest slug must be a non-empty string');
  if (!Array.isArray(m.takes)) errors.push('manifest takes must be an array');
  else m.takes.forEach((t, i) => { const v = validateTake(t); if (!v.ok) errors.push('take ' + i + ': ' + v.errors[0]); });
  return { ok: errors.length === 0, errors };
}

export function normalizeManifest(m) {
  return { schemaVersion: 1, slug: str(m.slug), takes: (m.takes || []).map(normalizeTake) };
}

// A fresh, empty manifest for a song that has never opened its deck.
export function createManifest(slug) {
  return { schemaVersion: 1, slug, takes: [] };
}
