// js/tape/clickModel.js — PURE metronome model for the tape deck's click track.
// Ported from the standalone Metronome PWA (guitarapp.com rebuild): the SAME 16 time
// signatures, subdivisions 1-4, and accent groupings, so the deck's click matches the
// standalone app. No AudioContext, no DOM, no Date — the audible scheduler lives in
// js/tape/click.js; this file only computes the accent PATTERN and clamps/validates a
// click config, so engine.test.js can load it headlessly (mirrors takeModel.js's pure
// discipline).
//
// A click config is { enabled, bpm, timeSigIndex, subdivision, accentIndex }, stored
// per TAKE (takeModel.js): a take carries its own tempo so one song can hold takes at
// different tempos, and every overdub pass reuses the take's config.

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

// The 16 meters (incl. compound ♩.) and their accent-grouping options — verbatim from
// the standalone app. `beats` = primary clicks per bar; "Off" = all beats equal, "On" =
// accent the downbeat only, "a+b+c" = group the bar a|b|c and accent each group's first
// beat (downbeat strongest). The ♩. entries are the compound meters with a fixed grouping.
export const TIME_SIGS = [
  { label: '2/4', beats: 2, accents: ['Off', 'On'] },
  { label: '3/4', beats: 3, accents: ['Off', 'On'] },
  { label: '4/4', beats: 4, accents: ['Off', 'On'] },
  { label: '5/4', beats: 5, accents: ['Off', 'On', '3+2', '2+3'] },
  { label: '5/8', beats: 5, accents: ['Off', 'On', '3+2', '2+3'] },
  { label: '6/8', beats: 6, accents: ['Off', 'On', '3+3', '2+2+2'] },
  { label: '6/8 ♩.', beats: 6, accents: ['Off', '3+3'] },
  { label: '7/8', beats: 7, accents: ['Off', 'On', '3+4', '4+3', '3+2+2', '2+2+3'] },
  { label: '8/8', beats: 8, accents: ['Off', 'On', '3+3+2'] },
  { label: '9/8', beats: 9, accents: ['Off', 'On', '3+3+3', '4+3+2', '3+4+2', '4+5', '4+2+3'] },
  { label: '9/8 ♩.', beats: 9, accents: ['Off', '3+3+3'] },
  { label: '10/8', beats: 10, accents: ['Off', 'On', '3+3+2+2', '2+2+3+3'] },
  { label: '11/8', beats: 11, accents: ['Off', 'On', '3+3+3+2', '4+4+3', '2+2+3+4'] },
  { label: '12/8', beats: 12, accents: ['Off', 'On', '3+3+3+3', '3+3+2+2+2', '3+2+3+2+2', '3+2+3+4'] },
  { label: '12/8 ♩.', beats: 12, accents: ['Off', '3+3+3+3'] },
  { label: '13/8', beats: 13, accents: ['Off', 'On', '3+3+3+2+2', '4+4+3+2', '4+3+4+2', '3+4+2+4'] },
];

export const SUBS = [
  { n: 1, name: 'Quarter' }, { n: 2, name: 'Eighths' }, { n: 3, name: 'Triplet' }, { n: 4, name: 'Sixteenths' },
];

export const MIN_BPM = 20;
export const MAX_BPM = 300;

// Parse an accent-grouping string into integer group sizes (null = no accents).
export function accentGroups(name, beats) {
  if (name === 'Off') return null;    // all beats equal
  if (name === 'On') return [beats];  // one group spanning the bar = downbeat only
  const parts = String(name).split('+');
  const g = [];
  for (let i = 0; i < parts.length; i++) g.push(parseInt(parts[i], 10));
  return g;
}

// Per-beat accent tiers for a meter+accent selection: 0 normal, 1 group start, 2 downbeat.
// Reworked from the standalone computeLevels() to take indices and RETURN the array
// rather than mutate a module global.
export function computeLevels(timeSigIndex, accentIndex) {
  const m = TIME_SIGS[timeSigIndex] || TIME_SIGS[0];
  const name = m.accents[accentIndex] || m.accents[0];
  const groups = accentGroups(name, m.beats);
  const levels = new Array(m.beats).fill(0);
  if (groups) {
    let pos = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      if (pos < levels.length) levels[pos] = gi === 0 ? 2 : 1; // downbeat vs group start
      pos += groups[gi];
    }
  }
  return levels;
}

// Bar / count-in durations. Subdivision does NOT change bar length
// (ticksPerBar * secondsPerTick = beats*sub * (60/bpm)/sub = beats * 60/bpm).
export function barSeconds(bpm, timeSigIndex) {
  const m = TIME_SIGS[timeSigIndex] || TIME_SIGS[0];
  return (m.beats * 60) / bpm;
}
export function countInSeconds(bpm, timeSigIndex, bars = 2) {
  return bars * barSeconds(bpm, timeSigIndex);
}

// The first non-"Off" accent option (the standalone app's default: "On", or the fixed
// grouping for a ♩. meter). Matches index.html defaultAccent().
export function defaultAccentIndex(timeSigIndex) {
  const m = TIME_SIGS[timeSigIndex] || TIME_SIGS[0];
  return m.accents.length > 1 ? 1 : 0;
}

// The schema/legacy baseline: DISABLED. "Default ON" is a UI default (main.js
// readClickDefault), kept deliberately separate so a legacy take with no `click`
// normalizes to OFF (its first pass had no click) rather than silently gaining one.
export function defaultClickConfig() {
  return { enabled: false, bpm: 120, timeSigIndex: 2, subdivision: 1, accentIndex: 1 };
}

// Clamp a partial click config into the full persisted shape. accentIndex is validated
// against the SELECTED meter's accent-list length — a time-sig change can strand an
// out-of-range index, so an invalid one falls back to that meter's default accent (the
// same rule as the standalone load() at index.html:573-574).
export function clampClickConfig(c) {
  const src = c || {};
  const timeSigIndex = clampInt(src.timeSigIndex, 0, TIME_SIGS.length - 1, 2);
  const accCount = TIME_SIGS[timeSigIndex].accents.length;
  const rawAcc = Math.round(Number(src.accentIndex));
  const accentIndex = (Number.isFinite(rawAcc) && rawAcc >= 0 && rawAcc < accCount)
    ? rawAcc
    : defaultAccentIndex(timeSigIndex);
  return {
    enabled: !!src.enabled,
    bpm: clampInt(src.bpm, MIN_BPM, MAX_BPM, 120),
    timeSigIndex,
    subdivision: clampInt(src.subdivision, 1, 4, 1),
    accentIndex,
  };
}
