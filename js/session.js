// session.js — the app-state model: option lists, defaults, validation, and
// randomize. Pure (rng injectable), so it loads into node for testing.
import { FEELS } from './data/feels.js';
import { MODES } from './data/modes.js';
import { LETTERS } from './theory/pitch.js';

export const ROOTS = LETTERS.slice(); // C D E F G A B
export const ACCIDENTAL_IDS = ['flat', 'natural', 'sharp'];
export const MODE_IDS = MODES.map((m) => m.id); // major, minor
// Instrument is persisted and deep-linked but has no visual effect in Phase 1
// (faithful to the original). It is the hook for real chord diagrams later.
export const INSTRUMENTS = ['guitar', 'piano'];

export const DEFAULT_STATE = Object.freeze({
  feel: 2, // Cliché — the original's default
  root: 'C',
  accidental: 'natural',
  mode: 'major',
  instrument: 'guitar',
});

// Coerce arbitrary input into a valid state, falling back per field. Used for
// both stored state and URL params, so unknown/garbage values are ignored.
export function validate(s) {
  s = s || {};
  const feelIdx = typeof s.feel === 'string' ? Number(s.feel) : s.feel;
  return {
    feel: Number.isInteger(feelIdx) && feelIdx >= 0 && feelIdx < FEELS.length ? feelIdx : DEFAULT_STATE.feel,
    root: ROOTS.includes(s.root) ? s.root : DEFAULT_STATE.root,
    accidental: ACCIDENTAL_IDS.includes(s.accidental) ? s.accidental : DEFAULT_STATE.accidental,
    mode: MODE_IDS.includes(s.mode) ? s.mode : DEFAULT_STATE.mode,
    instrument: INSTRUMENTS.includes(s.instrument) ? s.instrument : DEFAULT_STATE.instrument,
  };
}

// Randomize feel / root / mode / instrument; accidental resets to natural, as
// the original did. rng defaults to Math.random but is injectable for tests.
export function randomize(rng = Math.random) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return {
    feel: Math.floor(rng() * FEELS.length),
    root: pick(ROOTS),
    accidental: 'natural',
    mode: pick(MODE_IDS),
    instrument: pick(INSTRUMENTS),
  };
}
