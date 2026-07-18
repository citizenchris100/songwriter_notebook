// js/tape/takeModel.js — PURE take & manifest model: validation/normalization,
// immutable manifest transforms, naming helpers, and the effect-settings + DSP
// mapping constants. Mirrors js/songs.js and js/sketches.js: no DOM, no OPFS, no
// Date, no crypto — take numbers, timestamps and ids are INJECTED by the impure
// shell (js/tape/audioEngine.js / js/main.js), so this stays node-importable and
// engine.test.js loads it directly.
//
// A per-song MANIFEST (OPFS takes/<slug>/manifest.json) holds an ordered list of
// TAKE records. A take is a 4-TRACK CONTAINER (slots stem1..stem4) filled over
// MULTIPLE recording PASSES — not one simultaneous capture. Each pass writes one
// or more currently-free slots and stamps every slot it writes with a monotonic
// `group` number; "the last recorded group" is the filled slots whose group is the
// maximum present, derived from the slots themselves (so a ping-pong bounce that
// frees a slot can't corrupt it). A take enters the manifest at record START with
// status "recording" (D22) — before any audio byte exists — so a crash mid-pass is
// recoverable rather than orphaned. Discard/delete/free never removes the take
// record, only audio (tombstone, D10/D23): this keeps take numbers monotonic.
//
// Mono forever: every track file is a single mono channel and the master bounce
// sums to one mono channel. There is no stereo/panning concept anywhere.

const str = (x) => (typeof x === 'string' ? x : '');
const isNum = (x) => typeof x === 'number' && isFinite(x);

export const MAX_TRACKS = 4;
export const STEM_KEYS = ['stem1', 'stem2', 'stem3', 'stem4'];
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

// ---- slot helpers (a track slot is null | { file, group, durationSec, ...settings }) ----

// A slot holds audio iff it is non-null with a non-null file. (An armed slot has a
// file with durationSec null while its pass records; a tombstoned/freed slot is null
// or has file:null.)
export function slotHasAudio(slot) {
  return !!(slot && slot.file);
}

// A freshly-armed slot for a pass: file named for its key, stamped with the pass's
// group, duration unknown (null) until the pass finalizes, neutral settings.
function makeSlot(slug, take, stemKey, group) {
  return { file: stemFileName(slug, take, stemKey), group, durationSec: null, ...defaultStemSettings() };
}

export function filledSlotKeys(take) {
  const stems = (take && take.stems) || {};
  return STEM_KEYS.filter((k) => slotHasAudio(stems[k]));
}
export function freeSlotKeys(take) {
  const stems = (take && take.stems) || {};
  return STEM_KEYS.filter((k) => !slotHasAudio(stems[k]));
}
export function takeHasAudio(take) {
  return filledSlotKeys(take).length > 0;
}

// The take's playback/bounce length: the longest filled track (passes differ in
// length; all tracks start at t=0, a shorter one simply ends earlier).
export function maxSlotDuration(take) {
  const stems = (take && take.stems) || {};
  const durs = STEM_KEYS.map((k) => stems[k]).filter(slotHasAudio).map((s) => (isNum(s.durationSec) ? s.durationSec : 0));
  return durs.length ? Math.max.apply(null, durs) : 0;
}

// The next pass's group number: one past the highest group present, or 1 if empty.
export function nextGroup(take) {
  const stems = (take && take.stems) || {};
  const groups = STEM_KEYS.map((k) => stems[k]).filter(slotHasAudio).map((s) => (isNum(s.group) ? s.group : 1));
  return (groups.length ? Math.max.apply(null, groups) : 0) + 1;
}

// The filled slots that make up the most recent pass (highest group). Retake acts
// on exactly these (AC: only the last recorded set of tracks is affected).
export function lastGroupSlotKeys(take) {
  const filled = filledSlotKeys(take);
  if (!filled.length) return [];
  const stems = take.stems;
  const maxG = Math.max.apply(null, filled.map((k) => (isNum(stems[k].group) ? stems[k].group : 1)));
  return filled.filter((k) => (isNum(stems[k].group) ? stems[k].group : 1) === maxG);
}

// Default input->slot routing: capture channel i feeds the i-th currently-free slot,
// capped at how many the interface + slots + hardware allow (min(inputs, free, 4)).
// Returns an array of slot keys indexed by capture-channel; pure so it is testable.
export function defaultRouting(freeKeys, maxCapture) {
  const n = Math.max(0, Math.min(maxCapture, freeKeys.length));
  return freeKeys.slice(0, n);
}

// ---- take records ----

// The take container entered into the manifest at record START (D22), before any
// audio byte exists: four EMPTY slots. `fields`: { take, sampleRate }. The first
// pass's slots are armed immediately after via appendPassTracks (same synchronous
// block, one manifest write).
export function makeTake(fields, now) {
  return {
    take: fields.take,
    status: 'recording',
    recovered: false,
    createdAt: now,
    durationSec: null,
    sampleRate: fields.sampleRate,
    stems: { stem1: null, stem2: null, stem3: null, stem4: null },
    bounce: null,
  };
}

// Monotonic next take number: scans ALL takes (active, discarded, AND
// "recording") so a number is never reused, including a take that died mid-record.
export function nextTakeNumber(manifest) {
  const takes = (manifest && manifest.takes) || [];
  return takes.reduce((max, t) => Math.max(max, isNum(t.take) ? t.take : 0), 0) + 1;
}

// Append a freshly-made (empty) take to the manifest.
export function appendTake(manifest, take) {
  return { ...manifest, takes: manifest.takes.concat([take]) };
}

function mapTake(manifest, takeNo, fn) {
  return { ...manifest, takes: manifest.takes.map((t) => (t.take === takeNo ? fn(t) : t)) };
}

// Arm a pass: fill the given free slots with freshly-named recording slots stamped
// with `group`, and mark the take "recording". Used for both a take's first pass
// and any subsequent overdub pass into its remaining free slots.
export function appendPassTracks(manifest, takeNo, slotKeys, group) {
  return mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of slotKeys) stems[key] = makeSlot(manifest.slug, takeNo, key, group);
    return { ...t, status: 'recording', stems };
  });
}

// Clean stop of a pass: set each just-recorded slot's measured duration, recompute
// the take length, "recording" -> "active". `slotDurations`: { stemK: seconds, ... }
// for exactly the slots this pass wrote.
export function finalizePass(manifest, takeNo, slotDurations) {
  return mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of Object.keys(slotDurations)) {
      if (stems[key]) stems[key] = { ...stems[key], durationSec: slotDurations[key] };
    }
    const take = { ...t, stems, status: 'active' };
    take.durationSec = maxSlotDuration(take);
    return take;
  });
}

// Crash recovery of an interrupted pass (on deck open, before the take is otherwise
// usable): `slotBytes` is each PENDING slot's measured on-disc byte count (0 when
// missing/empty). A nonzero count finalizes that slot's duration (2 bytes/sample,
// mono per track); an empty pending slot is freed (nulled) so only real audio
// survives. The take becomes active+recovered if any track survived, else it is
// tombstoned (an empty first pass that captured nothing).
export function finalizeRecoveredPass(manifest, takeNo, slotBytes, rate) {
  const m2 = mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of STEM_KEYS) {
      const slot = stems[key];
      if (!slotHasAudio(slot)) continue;
      if (slot.durationSec !== null) continue; // finalized by an earlier pass — leave it
      const bytes = (slotBytes && slotBytes[key]) || 0;
      stems[key] = bytes > 0 ? { ...slot, durationSec: bytes / (2 * rate) } : null;
    }
    const take = { ...t, stems };
    if (!takeHasAudio(take)) return take; // tombstoned below
    return { ...take, status: 'active', recovered: true, durationSec: maxSlotDuration(take) };
  });
  const t = m2.takes.find((x) => x.take === takeNo);
  if (t && !takeHasAudio(t)) return discardTake(m2, takeNo);
  return m2;
}

// Nulls every stem/bounce FILE field (audio is gone) but keeps the take record —
// the tombstone. Shared by Retake→Discard-whole-take and per-take Delete (D23); any
// take, any time.
export function discardTake(manifest, takeNo) {
  const nullFile = (stem) => (stem ? { ...stem, file: null } : null);
  return mapTake(manifest, takeNo, (t) => {
    const stems = {};
    for (const key of STEM_KEYS) stems[key] = nullFile(t.stems && t.stems[key]);
    return { ...t, status: 'discarded', stems, bounce: t.bounce ? { ...t.bounce, file: null } : null };
  });
}

// Free just the slots of one recording group (Retake→Discard-last-group): null
// those slots so they are re-recordable, recompute the take length, keep the take
// active with its other groups intact. The take record and its group history remain.
export function discardGroup(manifest, takeNo, group) {
  return mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of STEM_KEYS) {
      const slot = stems[key];
      if (slotHasAudio(slot) && (isNum(slot.group) ? slot.group : 1) === group) stems[key] = null;
    }
    const take = { ...t, stems };
    take.durationSec = takeHasAudio(take) ? maxSlotDuration(take) : null;
    return take;
  });
}

// Ping-pong bounce result: the destination now holds the summed (baked) audio, so
// its effect settings reset to neutral and its duration is the rendered length; the
// source slot is freed (nulled) and becomes re-recordable. Filenames are unchanged
// (dst keeps its own file, overwritten on disc), so no rename bookkeeping.
export function bounceTrackToTrack(manifest, takeNo, srcKey, dstKey, durationSec) {
  return mapTake(manifest, takeNo, (t) => {
    const dst = t.stems[dstKey];
    const stems = { ...t.stems };
    stems[dstKey] = { file: dst.file, group: dst.group, durationSec, ...defaultStemSettings() };
    stems[srcKey] = null;
    const take = { ...t, stems };
    take.durationSec = maxSlotDuration(take);
    return take;
  });
}

// Record a completed master bounce (AC-13/15: re-bounce overwrites, so this just
// replaces the single `bounce` field).
export function markBounced(manifest, takeNo, bounce) {
  return mapTake(manifest, takeNo, (t) => ({ ...t, bounce }));
}

// Merge + clamp a settings patch into one track slot (vol/EQ/comp are saved,
// non-destructive). No-ops on an absent (null) slot. Preserves the slot's `group`
// and `durationSec` — the settings edit must not drop the provenance/length fields.
export function setStemSettings(manifest, takeNo, stemKey, patch) {
  return mapTake(manifest, takeNo, (t) => {
    const current = t.stems && t.stems[stemKey];
    if (!current) return t;
    const merged = clampStemSettings({ ...current, ...patch, eq: { ...current.eq, ...(patch && patch.eq) } });
    return {
      ...t,
      stems: {
        ...t.stems,
        [stemKey]: { file: current.file, group: current.group, durationSec: current.durationSec, ...merged },
      },
    };
  });
}

// The take that loads when a deck opens (AC-11): the highest-numbered ACTIVE take
// that still has audio (an emptied post-discard container is not auto-loaded).
export function mostRecentKeptTake(manifest) {
  const takes = ((manifest && manifest.takes) || []).filter((t) => t.status === 'active' && takeHasAudio(t));
  if (!takes.length) return null;
  return takes.reduce((best, t) => (t.take > best.take ? t : best), takes[0]);
}

// ---- validation / normalization (defensive: reading a manifest this app wrote) ----

function validateStem(s, at, errors) {
  if (s === null || s === undefined) return; // a missing slot (v1 had no stem3/stem4) is a free slot
  if (typeof s !== 'object' || Array.isArray(s)) { errors.push(at + ' stem must be an object or null'); return; }
  if ('file' in s && s.file !== null && typeof s.file !== 'string') errors.push(at + ' stem file must be a string or null');
  if ('group' in s && !isNum(s.group)) errors.push(at + ' stem group must be a number');
  if ('durationSec' in s && s.durationSec !== null && !isNum(s.durationSec)) errors.push(at + ' stem durationSec must be a number or null');
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
  // `channels` is a legacy v1 field — accepted (and dropped) on read, not required.
  if (!t.stems || typeof t.stems !== 'object') errors.push('take stems must be an object');
  else for (const key of STEM_KEYS) validateStem(t.stems[key], 'stems.' + key, errors);
  if (t.bounce !== null && t.bounce !== undefined) {
    if (typeof t.bounce !== 'object' || Array.isArray(t.bounce)) errors.push('take bounce must be an object or null');
    else {
      if (typeof t.bounce.file !== 'string' && t.bounce.file !== null) errors.push('bounce file must be a string or null');
      if ('bouncedAt' in t.bounce && typeof t.bounce.bouncedAt !== 'string') errors.push('bounce bouncedAt must be a string');
      if ('lufs' in t.bounce && !isNum(t.bounce.lufs)) errors.push('bounce lufs must be a number');
    }
  }
  return { ok: errors.length === 0, errors };
}

// v2 slot normalize (injects defaults for a slot already in the 4-track shape).
function normalizeStem(s) {
  if (s === null || s === undefined) return null;
  const clamped = clampStemSettings(s);
  return {
    file: typeof s.file === 'string' ? s.file : null,
    group: isNum(s.group) ? s.group : 1,
    durationSec: isNum(s.durationSec) ? s.durationSec : null,
    ...clamped,
  };
}

function normalizeBounce(b) {
  return (b && typeof b === 'object')
    ? { file: typeof b.file === 'string' ? b.file : null, bouncedAt: str(b.bouncedAt), lufs: isNum(b.lufs) ? b.lufs : null }
    : null;
}

export function normalizeTake(t) {
  const dur = isNum(t.durationSec) ? t.durationSec : null;
  // v1 migration: a take with the legacy scalar `channels` and no per-slot `group`
  // maps stem1 (always) + stem2 (iff channels===2) into group-1 slots whose per-slot
  // durationSec is the take's duration; stem3/stem4 are new empty slots. Filenames
  // are unchanged, so the real WAVs on disc still resolve. Migration is idempotent:
  // a normalized (v2) take has no `channels`, so it takes the else branch and its
  // group/durationSec are preserved.
  const isV1 = ('channels' in t) && !STEM_KEYS.some((k) => t.stems && t.stems[k] && 'group' in t.stems[k]);
  let stems;
  if (isV1) {
    const migrate = (s) => {
      if (s === null || s === undefined) return null;
      return { file: typeof s.file === 'string' ? s.file : null, group: 1, durationSec: dur, ...clampStemSettings(s) };
    };
    stems = {
      stem1: migrate(t.stems && t.stems.stem1),
      stem2: t.channels === 2 ? migrate(t.stems && t.stems.stem2) : null,
      stem3: null,
      stem4: null,
    };
  } else {
    stems = {};
    for (const key of STEM_KEYS) stems[key] = normalizeStem(t.stems && t.stems[key]);
  }
  return {
    take: t.take,
    status: TAKE_STATUS.includes(t.status) ? t.status : 'discarded',
    recovered: !!t.recovered,
    createdAt: str(t.createdAt),
    durationSec: dur,
    sampleRate: isNum(t.sampleRate) ? t.sampleRate : 48000,
    stems,
    bounce: normalizeBounce(t.bounce),
  };
}

export function validateManifest(m) {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest must be an object'] };
  const errors = [];
  if ('schemaVersion' in m && m.schemaVersion !== 1 && m.schemaVersion !== 2) errors.push('manifest schemaVersion must be 1 or 2');
  if (typeof m.slug !== 'string' || m.slug.length < 1) errors.push('manifest slug must be a non-empty string');
  if (!Array.isArray(m.takes)) errors.push('manifest takes must be an array');
  else m.takes.forEach((t, i) => { const v = validateTake(t); if (!v.ok) errors.push('take ' + i + ': ' + v.errors[0]); });
  return { ok: errors.length === 0, errors };
}

// Normalizing always emits schemaVersion 2 (migrating any v1 take en route). The
// deck-open path validates the raw manifest, normalizes it, and writes it back, so
// a v1 manifest auto-upgrades in place on first open.
export function normalizeManifest(m) {
  return { schemaVersion: 2, slug: str(m.slug), takes: (m.takes || []).map(normalizeTake) };
}

// A fresh, empty manifest for a song that has never opened its deck.
export function createManifest(slug) {
  return { schemaVersion: 2, slug, takes: [] };
}
