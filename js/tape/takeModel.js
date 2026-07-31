// js/tape/takeModel.js — PURE take & manifest model: validation/normalization,
// immutable manifest transforms, naming helpers, and the effect-settings + DSP
// mapping constants. Mirrors js/songs.js and js/sketches.js: no DOM, no OPFS, no
// Date, no crypto — take numbers, timestamps, clip ids and durations are INJECTED by
// the impure shell (js/tape/audioEngine.js / js/main.js), so this stays node-importable
// and engine.test.js loads it directly.
//
// A per-song MANIFEST (OPFS takes/<slug>/manifest.json) holds an ordered list of
// TAKE records. A take is a 4-TRACK CONTAINER (lanes stem1..stem4). Each LANE is
//   null                                      (a free / never-recorded lane)
//   | { vol, eq:{bass,mid,treble}, comp, clips: Clip[] }
// where lane-level vol/EQ/comp are the Mix-tab channel-strip settings and `clips` is an
// ordered, NON-OVERLAPPING list of timeline CLIPS. A CLIP is
//   { id, file, startBar, bars, durationSec, loc, group }
// a self-contained mono WAV played from sample 0, positioned at integer bar `startBar`,
// `bars` bars long. loc + the recording `group` live PER CLIP. The pure integer-bar
// geometry (record-replace / slice / trim / dupe / non-overlap) lives in clipModel.js.
//
// A take is filled over MULTIPLE recording PASSES — not one simultaneous capture. Each
// pass writes one or more currently-free lanes and stamps every clip it writes with a
// monotonic `group` number; "the last recorded group" is the clips whose group is the
// maximum present, derived from the clips themselves. A take enters the manifest at
// record START with status "recording" (D22) — before any audio byte exists — so a
// crash mid-pass is recoverable. Discard/delete/free never removes the take record,
// only audio (tombstone, D10/D23): this keeps take numbers monotonic.
//
// Mono forever: every clip file is a single mono channel and the master bounce sums to
// one mono channel. There is no stereo/panning concept anywhere.
//
// A take also carries a per-take metronome `click` config (bpm/meter, set on its first
// pass): this is the bar<->seconds lattice every clip in the take shares.
import { clampClickConfig, defaultClickConfig, barSeconds } from './clickModel.js';
import { clampDrumConfig, defaultDrumConfig } from './drumModel.js';
import { laneLengthBars, replaceRegionWithClip, sliceClipAtBar, trimClipEdge, deleteClip, dupeClip } from './clipModel.js';

const str = (x) => (typeof x === 'string' ? x : '');
const isNum = (x) => typeof x === 'number' && isFinite(x);
const isInt = (x) => isNum(x) && Math.floor(x) === x;

export const MAX_TRACKS = 4;
export const STEM_KEYS = ['stem1', 'stem2', 'stem3', 'stem4'];
export const TAKE_STATUS = ['recording', 'active', 'discarded'];

// The nested tapeDeck/manifest schema version. v3 introduces the per-lane clip list
// (loc + group move into clips, timeline positions added); v1/v2 are read + migrated.
export const MANIFEST_SCHEMA = 3;

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

// Legacy single-file-per-lane name (v1/v2 takes on disc; kept verbatim on migration).
export function stemFileName(slug, take, stemKey) {
  return slug + '_' + take + '_' + stemKey + '.wav';
}
// v3 per-CLIP name: the _<clipId> suffix guarantees it never collides with the legacy name.
export function clipFileName(slug, take, stemKey, clipId) {
  return slug + '_' + take + '_' + stemKey + '_' + clipId + '.wav';
}
export function mixFileName(slug, take) {
  return slug + '_' + take + '_mix.wav';
}
// The song record's small reference to its OPFS take directory (AC-19).
export function tapeDeckRef(slug) {
  return { path: 'takes/' + slug + '/' };
}

// ---- playback cache invalidation (audioEngine.js D34 playback graph) ----

// audioEngine caches a take's DECODED playback buffers in a small descriptor and reuses
// them until this predicate reports the cache stale. Retake/ping-pong/clip-edit re-write
// audio under an unchanged (slug, take), so a slug+take key can't see it; the impure
// engine bumps a monotonic `epoch` on every in-place audio write. This is the single
// reload decision play()/replay() consult.
export function playbackCacheStale(loaded, want) {
  return !loaded || loaded.slug !== want.slug || loaded.take !== want.take || loaded.epoch !== want.epoch;
}

// ---- bar<->seconds lattice: every clip in a take shares the take's locked tempo/meter ----

export function secPerBar(take) {
  const bpm = (take && take.click && take.click.bpm) || 120;
  const tsi = (take && take.click && take.click.timeSigIndex != null) ? take.click.timeSigIndex : 2;
  return barSeconds(bpm, tsi);
}

// ---- clip helpers (a clip is { id, file, startBar, bars, durationSec, loc, group }) ----

export function clipHasAudio(clip) {
  return !!(clip && clip.file);
}

// A fresh recording clip for a pass: named for its lane+id, stamped with the pass group,
// bars/duration unknown (null) until finalize, living in OPFS.
function makeClip(slug, take, stemKey, clipId, group, startBar) {
  return { id: clipId, file: clipFileName(slug, take, stemKey, clipId), startBar: startBar || 0, bars: null, durationSec: null, loc: 'opfs', group };
}

// ---- lane helpers (a lane is null | { vol, eq, comp, clips: Clip[] }) ----

export function laneClips(lane) {
  return (lane && Array.isArray(lane.clips)) ? lane.clips : [];
}

// A lane holds audio iff it has at least one clip with a file.
export function slotHasAudio(lane) {
  return laneClips(lane).some(clipHasAudio);
}

// Where a lane's audio lives at the LANE level: 'folder' once EVERY audio clip is Saved to
// the song folder, else 'opfs' (a fresh/partly-saved lane). Absent/empty → 'opfs'.
export function slotLoc(lane) {
  const audio = laneClips(lane).filter(clipHasAudio);
  return audio.length && audio.every((c) => c.loc === 'folder') ? 'folder' : 'opfs';
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

// The take's length in BARS: the furthest clip end across all lanes.
export function takeLengthBars(take) {
  const stems = (take && take.stems) || {};
  return Math.max(0, ...STEM_KEYS.map((k) => laneLengthBars(stems[k])));
}

// The take's playback/bounce length in SECONDS: the furthest clip END, honoring each clip's
// bar OFFSET (a clip at startBar 4 ends at 4*secPerBar + its duration). For a single clip at
// bar 0 this is just its duration — unchanged from the pre-clip model. Kept named
// maxSlotDuration for its many callers (take.durationSec = this).
export function maxSlotDuration(take) {
  const stems = (take && take.stems) || {};
  const spb = secPerBar(take);
  let max = 0;
  for (const k of STEM_KEYS) {
    for (const c of laneClips(stems[k])) {
      if (!clipHasAudio(c)) continue;
      const end = (c.startBar || 0) * spb + (isNum(c.durationSec) ? c.durationSec : 0);
      if (end > max) max = end;
    }
  }
  return max;
}

// The next pass's group number: one past the highest group across all audio clips, or 1.
export function nextGroup(take) {
  const stems = (take && take.stems) || {};
  let max = 0;
  for (const k of STEM_KEYS) for (const c of laneClips(stems[k])) if (clipHasAudio(c) && isNum(c.group) && c.group > max) max = c.group;
  return max + 1;
}

// The lane keys whose clips include the most-recent recording group (highest group present).
// Retake acts on exactly these lanes (and, at clip granularity, discardGroup removes that
// group's clips).
export function lastGroupSlotKeys(take) {
  const stems = (take && take.stems) || {};
  let maxG = 0;
  for (const k of STEM_KEYS) for (const c of laneClips(stems[k])) if (clipHasAudio(c) && isNum(c.group) && c.group > maxG) maxG = c.group;
  if (!maxG) return [];
  return STEM_KEYS.filter((k) => laneClips(stems[k]).some((c) => clipHasAudio(c) && c.group === maxG));
}

// Default input->slot routing: capture channel i feeds the i-th currently-free lane,
// capped at min(inputs, free, 4). Pure so it is testable.
export function defaultRouting(freeKeys, maxCapture) {
  const n = Math.max(0, Math.min(maxCapture, freeKeys.length));
  return freeKeys.slice(0, n);
}

// ---- take records ----

// The take container entered into the manifest at record START (D22), before any
// audio byte exists: four EMPTY (null) lanes. `fields`: { take, sampleRate }.
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
    click: fields.click ? clampClickConfig(fields.click) : defaultClickConfig(),
    drums: fields.drums ? clampDrumConfig(fields.drums) : defaultDrumConfig(),
  };
}

// Monotonic next take number: scans ALL takes (active, discarded, AND "recording") so a
// number is never reused, including a take that died mid-record.
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

// Arm a pass: fill each given free lane with a fresh recording clip at bar 0 (Mix records
// only into empty lanes), stamped with `group`, and mark the take "recording". Each armed
// lane becomes a lane object carrying neutral settings + its one recording clip.
export function appendPassTracks(manifest, takeNo, slotKeys, group) {
  return mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of slotKeys) {
      const clip = makeClip(manifest.slug, takeNo, key, 'g' + group, group, 0);
      stems[key] = { ...defaultStemSettings(), clips: [clip] };
    }
    return { ...t, status: 'recording', stems };
  });
}

// Clean stop of a pass: set each just-recorded lane's recording clip length (durationSec +
// integer bars from the take's tempo), recompute the take length, "recording" -> "active".
// `slotDurations`: { stemK: seconds, ... } for exactly the lanes this pass wrote.
export function finalizePass(manifest, takeNo, slotDurations) {
  return mapTake(manifest, takeNo, (t) => {
    const spb = secPerBar(t);
    const stems = { ...t.stems };
    for (const key of Object.keys(slotDurations)) {
      const lane = stems[key];
      if (!lane) continue;
      const dur = slotDurations[key];
      const bars = Math.max(1, Math.round(dur / spb));
      const clips = laneClips(lane).map((c) => (c.durationSec === null ? { ...c, durationSec: dur, bars } : c));
      stems[key] = { ...lane, clips };
    }
    const take = { ...t, stems, status: 'active' };
    take.durationSec = maxSlotDuration(take);
    return take;
  });
}

// Crash recovery of an interrupted pass: `slotBytes` is each PENDING lane's on-disc byte
// count (0 when missing/empty). A nonzero count finalizes that lane's recording clip
// (2 bytes/sample, mono); an empty pending clip is dropped (its lane freed). The take
// becomes active+recovered if any clip survived, else tombstoned.
export function finalizeRecoveredPass(manifest, takeNo, slotBytes, rate) {
  const m2 = mapTake(manifest, takeNo, (t) => {
    const spb = secPerBar(t);
    const stems = { ...t.stems };
    for (const key of STEM_KEYS) {
      const lane = stems[key];
      if (!lane) continue;
      const clips = [];
      for (const c of laneClips(lane)) {
        if (c.durationSec !== null) { clips.push(c); continue; } // finalized earlier — keep
        const bytes = (slotBytes && slotBytes[key]) || 0;
        if (bytes > 0) { const dur = bytes / (2 * rate); clips.push({ ...c, durationSec: dur, bars: Math.max(1, Math.round(dur / spb)) }); }
        // else: an empty pending clip is dropped
      }
      stems[key] = clips.length ? { ...lane, clips } : null;
    }
    const take = { ...t, stems };
    if (!takeHasAudio(take)) return take; // tombstoned below
    return { ...take, status: 'active', recovered: true, durationSec: maxSlotDuration(take) };
  });
  const t = m2.takes.find((x) => x.take === takeNo);
  if (t && !takeHasAudio(t)) return discardTake(m2, takeNo);
  return m2;
}

// Tombstone: drop all audio (empty every lane's clips) but keep the take record so take
// numbers stay monotonic. Shared by Retake→Discard-whole-take and per-take Delete (D23).
export function discardTake(manifest, takeNo) {
  return mapTake(manifest, takeNo, (t) => {
    const stems = {};
    for (const key of STEM_KEYS) stems[key] = t.stems && t.stems[key] ? { ...t.stems[key], clips: [] } : null;
    return { ...t, status: 'discarded', stems, bounce: t.bounce ? { ...t.bounce, file: null } : null };
  });
}

// Free just one recording group's clips (Retake→Discard-last-group): remove clips whose
// group === `group` from every lane, recompute the take length, keep the take active. A lane
// left with no clips becomes free (null).
export function discardGroup(manifest, takeNo, group) {
  return mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of STEM_KEYS) {
      const lane = stems[key];
      if (!lane) continue;
      const clips = laneClips(lane).filter((c) => !(clipHasAudio(c) && c.group === group));
      stems[key] = clips.length ? { ...lane, clips } : null;
    }
    const take = { ...t, stems };
    take.durationSec = takeHasAudio(take) ? maxSlotDuration(take) : null;
    return take;
  });
}

// Ping-pong bounce (Mix-only): the destination lane collapses to ONE aggregate clip at bar 0
// holding the summed (baked) audio (its file reused, overwritten on disc), lane settings reset
// to neutral; the source lane is freed. The aggregate spans the longer of the two lanes.
export function bounceTrackToTrack(manifest, takeNo, srcKey, dstKey, durationSec) {
  return mapTake(manifest, takeNo, (t) => {
    const spb = secPerBar(t);
    const dst = t.stems[dstKey];
    const dstClip = laneClips(dst)[0];
    const bars = Math.max(1, Math.max(laneLengthBars(t.stems[srcKey]), laneLengthBars(dst)), Math.round(durationSec / spb));
    const stems = { ...t.stems };
    stems[dstKey] = { ...defaultStemSettings(), clips: [{ id: dstClip ? dstClip.id : 'bnc', file: dstClip ? dstClip.file : clipFileName(manifest.slug, takeNo, dstKey, 'bnc'), startBar: 0, bars, durationSec, loc: 'opfs', group: dstClip ? dstClip.group : nextGroup(t) }] };
    stems[srcKey] = null;
    const take = { ...t, stems };
    take.durationSec = maxSlotDuration(take);
    return take;
  });
}

// Record a completed master bounce (AC-13/15: re-bounce overwrites the single `bounce` field).
export function markBounced(manifest, takeNo, bounce) {
  return mapTake(manifest, takeNo, (t) => ({ ...t, bounce }));
}

// Merge + clamp a settings patch into ONE lane's vol/EQ/comp (saved, non-destructive). No-ops
// on an absent (null) lane. Leaves the lane's clips array UNTOUCHED (a settings edit must never
// drop or reshape the audio).
export function setStemSettings(manifest, takeNo, stemKey, patch) {
  return mapTake(manifest, takeNo, (t) => {
    const current = t.stems && t.stems[stemKey];
    if (!current) return t;
    const merged = clampStemSettings({ ...current, ...patch, eq: { ...current.eq, ...(patch && patch.eq) } });
    return { ...t, stems: { ...t.stems, [stemKey]: { ...merged, clips: current.clips } } };
  });
}

// ---- timeline clip transforms (thin clipModel wrappers; inject filenames + measured
// durations via the impure shell, return removed/copy side-channels for the WAV I/O) ----

// Stamp fresh (file:null) clips created by a geometry transform with real clipFileNames.
function nameCreated(slug, takeNo, stemKey, lane, created) {
  const byId = new Map(created.map((c) => [c.id, true]));
  const clips = laneClips(lane).map((c) => (byId.has(c.id) && !c.file ? { ...c, file: clipFileName(slug, takeNo, stemKey, c.id) } : c));
  return { ...lane, clips };
}

// RECORD a finished timeline clip into a lane at `startBar` for `bars` (fields: { id, startBar,
// bars, durationSec, group }). Evicts every clip the region reaches (per the replace-ENTIRELY
// rule). Returns { manifest, removedFiles } so the shell deletes orphaned WAVs.
export function recordClip(manifest, takeNo, stemKey, fields) {
  let removedFiles = [];
  const m = mapTake(manifest, takeNo, (t) => {
    const lane = t.stems[stemKey] || { ...defaultStemSettings(), clips: [] };
    const clip = { id: fields.id, file: clipFileName(manifest.slug, takeNo, stemKey, fields.id), startBar: fields.startBar, bars: fields.bars, durationSec: fields.durationSec, loc: 'opfs', group: fields.group };
    const r = replaceRegionWithClip(lane, fields.startBar, fields.bars, clip);
    removedFiles = r.removed.map((c) => c.file).filter(Boolean);
    const take = { ...t, status: 'active', stems: { ...t.stems, [stemKey]: r.lane } };
    take.durationSec = maxSlotDuration(take);
    return take;
  });
  return { manifest: m, removedFiles };
}

export function sliceClip(manifest, takeNo, stemKey, clipId, bar, ids) {
  let copyFrom = null;
  const m = mapTake(manifest, takeNo, (t) => {
    const r = sliceClipAtBar(t.stems[stemKey], clipId, bar, ids);
    copyFrom = r.copyFrom;
    const take = { ...t, stems: { ...t.stems, [stemKey]: nameCreated(manifest.slug, takeNo, stemKey, r.lane, r.created) } };
    take.durationSec = maxSlotDuration(take);
    return take;
  });
  return { manifest: m, copyFrom };
}

export function trimClip(manifest, takeNo, stemKey, clipId, edge, ids) {
  let copyFrom = null, removedFiles = [];
  const m = mapTake(manifest, takeNo, (t) => {
    const r = trimClipEdge(t.stems[stemKey], clipId, edge, ids);
    copyFrom = r.copyFrom;
    removedFiles = r.removed.filter((c) => !r.created.length).map((c) => c.file).filter(Boolean); // deleted (trim-to-zero)
    const lane = nameCreated(manifest.slug, takeNo, stemKey, r.lane, r.created);
    const take = { ...t, stems: { ...t.stems, [stemKey]: laneClips(lane).length ? lane : null } };
    take.durationSec = takeHasAudio(take) ? maxSlotDuration(take) : take.durationSec;
    return take;
  });
  return { manifest: m, copyFrom, removedFiles };
}

export function deleteClipFromLane(manifest, takeNo, stemKey, clipId) {
  let removedFiles = [];
  const m = mapTake(manifest, takeNo, (t) => {
    const r = deleteClip(t.stems[stemKey], clipId);
    removedFiles = r.removed.map((c) => c.file).filter(Boolean);
    const lane = laneClips(r.lane).length ? r.lane : null;
    const take = { ...t, stems: { ...t.stems, [stemKey]: lane } };
    take.durationSec = takeHasAudio(take) ? maxSlotDuration(take) : null;
    return take;
  });
  return { manifest: m, removedFiles };
}

export function dupeClipInLane(manifest, takeNo, stemKey, clipId, targetBar, ids) {
  let copyFrom = null;
  const m = mapTake(manifest, takeNo, (t) => {
    const r = dupeClip(t.stems[stemKey], clipId, targetBar, ids);
    copyFrom = r.copyFrom;
    const take = { ...t, stems: { ...t.stems, [stemKey]: nameCreated(manifest.slug, takeNo, stemKey, r.lane, r.created) } };
    take.durationSec = maxSlotDuration(take);
    return take;
  });
  return { manifest: m, copyFrom };
}

// The mostly-recent kept take (AC-11): the highest-numbered ACTIVE take that still has audio.
export function mostRecentKeptTake(manifest) {
  const takes = ((manifest && manifest.takes) || []).filter((t) => t.status === 'active' && takeHasAudio(t));
  if (!takes.length) return null;
  return takes.reduce((best, t) => (t.take > best.take ? t : best), takes[0]);
}

// ---- folder-persistence helpers (Save moves clip audio OPFS -> the song folder) ----

// Lane keys with at least one clip still only in OPFS (needs migrating on the next Save).
export function pendingOpfsSlotKeys(take) {
  const stems = (take && take.stems) || {};
  return filledSlotKeys(take).filter((k) => laneClips(stems[k]).some((c) => clipHasAudio(c) && c.loc !== 'folder'));
}

// A take is fully persisted iff every clip AND its bounce (if any) is 'folder'.
export function takeIsSaved(take) {
  const stems = (take && take.stems) || {};
  const clipsSaved = filledSlotKeys(take).every((k) => laneClips(stems[k]).every((c) => !clipHasAudio(c) || c.loc === 'folder'));
  const b = take && take.bounce;
  const bounceSaved = !(b && b.file) || b.loc === 'folder';
  return clipsSaved && bounceSaved;
}

// Immutably mark the given lanes' clips (and, with {bounce:true}, the bounce) as living in the
// song folder — called only after their bytes are verified on disc.
export function migrateTakeSlots(manifest, takeNo, keys, opts) {
  const markBounce = !!(opts && opts.bounce);
  return mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of keys) {
      const lane = stems[key];
      if (!lane) continue;
      stems[key] = { ...lane, clips: laneClips(lane).map((c) => (clipHasAudio(c) ? { ...c, loc: 'folder' } : c)) };
    }
    const bounce = markBounce && t.bounce && t.bounce.file ? { ...t.bounce, loc: 'folder' } : t.bounce;
    return { ...t, stems, bounce };
  });
}

// Inverse of migrateTakeSlots: mark lanes' clips (and optionally the bounce) back to 'opfs'
// after an in-place OPFS overwrite of a previously-saved file (defensive).
export function revertSlotToOpfs(manifest, takeNo, keys, opts) {
  const markBounce = !!(opts && opts.bounce);
  return mapTake(manifest, takeNo, (t) => {
    const stems = { ...t.stems };
    for (const key of keys) {
      const lane = stems[key];
      if (!lane) continue;
      stems[key] = { ...lane, clips: laneClips(lane).map((c) => (clipHasAudio(c) ? { ...c, loc: 'opfs' } : c)) };
    }
    const bounce = markBounce && t.bounce && t.bounce.file ? { ...t.bounce, loc: 'opfs' } : t.bounce;
    return { ...t, stems, bounce };
  });
}

// Every clip filename referenced by any take's lanes — the set Save copies OPFS->folder and
// Delete cleans up (the clip-aware analogue of the old (slug,take,key) name derivation).
export function referencedClipFiles(manifest) {
  const out = new Set();
  for (const t of (manifest && manifest.takes) || []) {
    for (const k of STEM_KEYS) for (const c of laneClips(t.stems && t.stems[k])) if (clipHasAudio(c)) out.add(c.file);
  }
  return out;
}

// ---- drum MIDI archival (the imported .mid travels with the song) ----

export function midiRef(slug) {
  return 'midi/' + slug + '/';
}
export function referencedMidiFiles(manifest) {
  const out = new Set();
  for (const t of (manifest && manifest.takes) || []) {
    const src = t && t.drums && t.drums.source;
    if (src && src.type === 'midi' && typeof src.midiFile === 'string' && src.midiFile) out.add(src.midiFile);
  }
  return out;
}
export function setDrumMidiFile(manifest, takeNo, name) {
  return mapTake(manifest, takeNo, (t) => {
    const drums = t.drums || defaultDrumConfig();
    const source = { ...(drums.source || {}), type: 'midi', midiFile: name };
    return { ...t, drums: clampDrumConfig({ ...drums, source }) };
  });
}

// ---- drum-loop archival (the sequencer's picked loops travel with the song) ----

export function loopsRef(slug) {
  return 'loops/' + slug + '/';
}
export function referencedLoopFiles(manifest) {
  const out = new Set();
  for (const t of (manifest && manifest.takes) || []) {
    const seq = t && t.drums && t.drums.sequence;
    if (!seq) continue;
    const folder = typeof seq.folderName === 'string' ? seq.folderName : '';
    for (const f of Array.isArray(seq.loopFiles) ? seq.loopFiles : []) {
      if (typeof f === 'string' && f) out.add(folder ? folder + '/' + f : f);
    }
    if (typeof seq.intro === 'string' && seq.intro) out.add(seq.intro);
    if (typeof seq.outro === 'string' && seq.outro) out.add(seq.outro);
  }
  return out;
}
export function setDrumSequence(manifest, takeNo, sequence, pattern) {
  return mapTake(manifest, takeNo, (t) => {
    const drums = t.drums || defaultDrumConfig();
    return { ...t, drums: clampDrumConfig({ ...drums, enabled: true, pattern, source: { type: 'sequence' }, sequence }) };
  });
}

// ---- durable song-embedded take records (survive OPFS eviction; restored on song open) ----

// Active, audio-bearing takes a manifest (or a bare { takes }) claims.
export function activeAudioTakeCount(manifest) {
  return ((manifest && manifest.takes) || []).filter((t) => t && t.status === 'active' && takeHasAudio(t)).length;
}

// Project a manifest down to durable, folder-backed records: per lane keep only clips physically
// saved to the folder (loc:'folder'); null a lane left with no folder clips; a take that thereby
// loses clips is PARTIAL and stamped recovered:true; keep the bounce only if folder-saved;
// preserve take NUMBER; recompute durationSec; omit tombstones + takes with zero folder clips.
export function projectTakesForJson(manifest) {
  const out = [];
  for (const t of (manifest && manifest.takes) || []) {
    if (t.status !== 'active') continue;
    const stems = {};
    let kept = 0;
    let lost = false;
    for (const key of STEM_KEYS) {
      const lane = (t.stems || {})[key];
      const folderClips = laneClips(lane).filter((c) => clipHasAudio(c) && c.loc === 'folder');
      const hadAudio = slotHasAudio(lane);
      if (folderClips.length) { stems[key] = { ...lane, clips: folderClips.map((c) => ({ ...c })) }; kept += folderClips.length; if (hadAudio && folderClips.length < laneClips(lane).filter(clipHasAudio).length) lost = true; }
      else { stems[key] = null; if (hadAudio) lost = true; }
    }
    if (!kept) continue;
    const bounce = t.bounce && t.bounce.file && t.bounce.loc === 'folder' ? { ...t.bounce } : null;
    const projected = { ...t, stems, bounce, recovered: t.recovered || lost };
    projected.durationSec = maxSlotDuration(projected);
    out.push(projected);
  }
  return out;
}

// The full tapeDeck field to stamp on a song record: the path ref + durable saved-take records.
export function tapeDeckWithTakes(slug, manifest) {
  return { path: tapeDeckRef(slug).path, schemaVersion: MANIFEST_SCHEMA, takes: projectTakesForJson(manifest) };
}

// Re-key a manifest onto a NEW slug for the song-duplicate path: clone it with slug=newSlug and
// every clip/bounce filename re-derived from newSlug, so it references the WAVs the duplicate
// copies into the new folder. The caller bases this on projectTakesForJson (folder-saved clips
// only) and writes every kept clip into the new folder. Pure.
export function rekeyManifest(manifest, newSlug) {
  const takes = ((manifest && manifest.takes) || []).map((t) => {
    const stems = {};
    for (const k of STEM_KEYS) {
      const lane = (t.stems || {})[k];
      if (!lane) { stems[k] = null; continue; }
      stems[k] = { ...lane, clips: laneClips(lane).map((c) => (clipHasAudio(c) ? { ...c, file: clipFileName(newSlug, t.take, k, c.id) } : { ...c })) };
    }
    const bounce = (t.bounce && t.bounce.file) ? { ...t.bounce, file: mixFileName(newSlug, t.take) } : (t.bounce || null);
    return { ...t, stems, bounce };
  });
  return { schemaVersion: MANIFEST_SCHEMA, slug: newSlug, takes };
}

// Reconstruct a working manifest from a song's embedded saved takes (restore when OPFS evicted).
export function hydrateSavedTakes(slug, savedTakes) {
  return normalizeManifest({ slug, takes: Array.isArray(savedTakes) ? savedTakes : [] });
}

// ---- validation / normalization (defensive: reading a manifest this app wrote) ----

function validateClip(c, at, errors) {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) { errors.push(at + ' clip must be an object'); return; }
  if (typeof c.id !== 'string' || !c.id) errors.push(at + ' clip id must be a non-empty string');
  if ('file' in c && c.file !== null && typeof c.file !== 'string') errors.push(at + ' clip file must be a string or null');
  if (!isInt(c.startBar) || c.startBar < 0) errors.push(at + ' clip startBar must be an integer >= 0');
  if (c.bars !== null && (!isInt(c.bars) || c.bars < 1)) errors.push(at + ' clip bars must be null or an integer >= 1');
  if (c.durationSec !== null && !isNum(c.durationSec)) errors.push(at + ' clip durationSec must be a number or null');
  if ('loc' in c && c.loc !== 'opfs' && c.loc !== 'folder') errors.push(at + ' clip loc must be "opfs" or "folder"');
  if (!isNum(c.group)) errors.push(at + ' clip group must be a number');
}

// A lane is null | a legacy slot { file, group, durationSec, loc, ...settings } (v1/v2) |
// a v3 lane { vol, eq, comp, clips[] }. Validate shape only (not the non-overlap invariant,
// which normalize repairs).
function validateLane(s, at, errors) {
  if (s === null || s === undefined) return; // free lane
  if (typeof s !== 'object' || Array.isArray(s)) { errors.push(at + ' lane must be an object or null'); return; }
  if (!isNum(s.vol)) errors.push(at + ' lane vol must be a number');
  if (!s.eq || typeof s.eq !== 'object') errors.push(at + ' lane eq must be an object');
  else for (const b of ['bass', 'mid', 'treble']) if (!isNum(s.eq[b])) errors.push(at + ' lane eq.' + b + ' must be a number');
  if (!isNum(s.comp)) errors.push(at + ' lane comp must be a number');
  if ('clips' in s && s.clips !== undefined) {
    if (!Array.isArray(s.clips)) { errors.push(at + ' lane clips must be an array'); return; }
    s.clips.forEach((c, i) => validateClip(c, at + '.clips[' + i + ']', errors));
  } else {
    // legacy v1/v2 slot fields (accepted on read, migrated by normalize)
    if ('file' in s && s.file !== null && typeof s.file !== 'string') errors.push(at + ' slot file must be a string or null');
    if ('group' in s && !isNum(s.group)) errors.push(at + ' slot group must be a number');
    if ('durationSec' in s && s.durationSec !== null && !isNum(s.durationSec)) errors.push(at + ' slot durationSec must be a number or null');
    if ('loc' in s && s.loc !== 'opfs' && s.loc !== 'folder') errors.push(at + ' slot loc must be "opfs" or "folder"');
  }
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
  if (!t.stems || typeof t.stems !== 'object') errors.push('take stems must be an object');
  else for (const key of STEM_KEYS) validateLane(t.stems[key], 'stems.' + key, errors);
  if (t.bounce !== null && t.bounce !== undefined) {
    if (typeof t.bounce !== 'object' || Array.isArray(t.bounce)) errors.push('take bounce must be an object or null');
    else {
      if (typeof t.bounce.file !== 'string' && t.bounce.file !== null) errors.push('bounce file must be a string or null');
      if ('bouncedAt' in t.bounce && typeof t.bounce.bouncedAt !== 'string') errors.push('bounce bouncedAt must be a string');
      if ('lufs' in t.bounce && t.bounce.lufs !== null && !isNum(t.bounce.lufs)) errors.push('bounce lufs must be a number or null');
      if ('loc' in t.bounce && t.bounce.loc !== 'opfs' && t.bounce.loc !== 'folder') errors.push('bounce loc must be "opfs" or "folder"');
    }
  }
  if (t.click !== null && t.click !== undefined) {
    if (typeof t.click !== 'object' || Array.isArray(t.click)) errors.push('take click must be an object or null');
    else {
      if (typeof t.click.enabled !== 'boolean') errors.push('click enabled must be a boolean');
      for (const f of ['bpm', 'timeSigIndex', 'subdivision', 'accentIndex']) if (!isNum(t.click[f])) errors.push('click ' + f + ' must be a number');
    }
  }
  if (t.drums !== null && t.drums !== undefined) {
    if (typeof t.drums !== 'object' || Array.isArray(t.drums)) errors.push('take drums must be an object or null');
    else if (typeof t.drums.enabled !== 'boolean') errors.push('take drums enabled must be a boolean');
  }
  return { ok: errors.length === 0, errors };
}

function normalizeClip(c) {
  return {
    id: typeof c.id === 'string' && c.id ? c.id : 'c',
    file: typeof c.file === 'string' ? c.file : null,
    startBar: isInt(c.startBar) && c.startBar >= 0 ? c.startBar : 0,
    bars: isInt(c.bars) && c.bars >= 1 ? c.bars : null,
    durationSec: isNum(c.durationSec) ? c.durationSec : null,
    loc: c.loc === 'folder' ? 'folder' : 'opfs',
    group: isNum(c.group) ? c.group : 1,
  };
}

// Normalize a lane, synthesizing a one-clip lane from a legacy v1/v2 slot. `spb` (seconds per
// bar) + `dur` (the take duration, for a legacy slot with no per-slot duration) come from the
// take. `deriveBars` computes a legacy clip's bar span (ceil, since it wasn't bar-recorded).
function normalizeLane(s, spb, legacyDur) {
  if (s === null || s === undefined) return null;
  const settings = clampStemSettings(s);
  if (Array.isArray(s.clips)) {
    const clips = s.clips.map(normalizeClip).sort((a, b) => a.startBar - b.startBar);
    // repair overlaps defensively: drop a later clip that overlaps an earlier kept one
    const kept = [];
    for (const c of clips) {
      if (kept.some((k) => k.startBar < c.startBar + (c.bars || 1) && c.startBar < k.startBar + (k.bars || 1))) continue;
      kept.push(c);
    }
    return { ...settings, clips: kept };
  }
  // legacy slot -> one clip at bar 0 (filename kept verbatim so the WAV still resolves).
  if (typeof s.file !== 'string' || !s.file) return { ...settings, clips: [] };
  const dur = isNum(s.durationSec) ? s.durationSec : (isNum(legacyDur) ? legacyDur : null);
  const bars = isNum(dur) && dur > 0 ? Math.max(1, Math.ceil(dur / spb)) : null;
  return { ...settings, clips: [{ id: 'c0', file: s.file, startBar: 0, bars, durationSec: dur, loc: s.loc === 'folder' ? 'folder' : 'opfs', group: isNum(s.group) ? s.group : 1 }] };
}

function normalizeBounce(b) {
  return (b && typeof b === 'object')
    ? { file: typeof b.file === 'string' ? b.file : null, bouncedAt: str(b.bouncedAt), lufs: isNum(b.lufs) ? b.lufs : null, loc: b.loc === 'folder' ? 'folder' : 'opfs' }
    : null;
}

function normalizeClick(c) {
  return (c && typeof c === 'object' && !Array.isArray(c)) ? clampClickConfig(c) : defaultClickConfig();
}
function normalizeDrums(d) {
  return (d && typeof d === 'object' && !Array.isArray(d)) ? clampDrumConfig(d) : defaultDrumConfig();
}

export function normalizeTake(t) {
  const dur = isNum(t.durationSec) ? t.durationSec : null;
  const click = normalizeClick(t.click);
  const spb = barSeconds(click.bpm, click.timeSigIndex);
  // v1 migration: a take with the legacy scalar `channels` and no clips maps stem1 (always) +
  // stem2 (iff channels===2) into one-clip lanes; stem3/stem4 are new free lanes.
  const isV1 = ('channels' in t) && !STEM_KEYS.some((k) => t.stems && t.stems[k] && Array.isArray(t.stems[k].clips));
  let stems;
  if (isV1) {
    stems = {
      stem1: normalizeLane(t.stems && t.stems.stem1, spb, dur),
      stem2: t.channels === 2 ? normalizeLane(t.stems && t.stems.stem2, spb, dur) : null,
      stem3: null,
      stem4: null,
    };
  } else {
    stems = {};
    for (const key of STEM_KEYS) stems[key] = normalizeLane(t.stems && t.stems[key], spb, dur);
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
    click,
    drums: normalizeDrums(t.drums),
  };
}

export function validateManifest(m) {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest must be an object'] };
  const errors = [];
  if ('schemaVersion' in m && m.schemaVersion !== 1 && m.schemaVersion !== 2 && m.schemaVersion !== 3) errors.push('manifest schemaVersion must be 1, 2 or 3');
  if (typeof m.slug !== 'string' || m.slug.length < 1) errors.push('manifest slug must be a non-empty string');
  if (!Array.isArray(m.takes)) errors.push('manifest takes must be an array');
  else m.takes.forEach((t, i) => { const v = validateTake(t); if (!v.ok) errors.push('take ' + i + ': ' + v.errors[0]); });
  return { ok: errors.length === 0, errors };
}

// Normalizing always emits the current schemaVersion (migrating any older take en route).
export function normalizeManifest(m) {
  return { schemaVersion: MANIFEST_SCHEMA, slug: str(m.slug), takes: (m.takes || []).map(normalizeTake) };
}

// A fresh, empty manifest for a song that has never opened its deck.
export function createManifest(slug) {
  return { schemaVersion: MANIFEST_SCHEMA, slug, takes: [] };
}
