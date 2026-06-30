// session.js — the app-state model: option lists, defaults, validation, and
// randomize. Pure (rng + feel list injectable), so it loads into node for testing.
// Feels are no longer hard-coded; the available feel ids are passed in.
import { MODES } from './data/modes.js';
import { LETTERS } from './theory/pitch.js';

export const ROOTS = LETTERS.slice(); // C D E F G A B
export const ACCIDENTAL_IDS = ['flat', 'natural', 'sharp'];
export const MODE_IDS = MODES.map((m) => m.id); // major, minor
// Instrument is persisted and deep-linked but has no visual effect yet; it is the
// hook for real chord diagrams later.
export const INSTRUMENTS = ['guitar', 'piano'];

export const DEFAULT_FEEL = 'cliche'; // the original's default
export const DEFAULT_STATE = Object.freeze({
  feel: DEFAULT_FEEL,
  root: 'C',
  accidental: 'natural',
  mode: 'major',
  instrument: 'guitar',
});

// Coerce arbitrary input into a valid state, falling back per field. `feelIds` is
// the list of currently-available feel ids (built-in + user).
export function validate(s, feelIds) {
  s = s || {};
  const ids = feelIds && feelIds.length ? feelIds : [DEFAULT_FEEL];
  const feel = ids.includes(s.feel) ? s.feel : (ids.includes(DEFAULT_FEEL) ? DEFAULT_FEEL : ids[0]);
  return {
    feel,
    root: ROOTS.includes(s.root) ? s.root : DEFAULT_STATE.root,
    accidental: ACCIDENTAL_IDS.includes(s.accidental) ? s.accidental : DEFAULT_STATE.accidental,
    mode: MODE_IDS.includes(s.mode) ? s.mode : DEFAULT_STATE.mode,
    instrument: INSTRUMENTS.includes(s.instrument) ? s.instrument : DEFAULT_STATE.instrument,
  };
}

// Randomize feel / root / mode / instrument; accidental resets to natural, as the
// original did. rng and the feel id list are injectable for tests.
export function randomize(rng = Math.random, feelIds = [DEFAULT_FEEL]) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return {
    feel: pick(feelIds.length ? feelIds : [DEFAULT_FEEL]),
    root: pick(ROOTS),
    accidental: 'natural',
    mode: pick(MODE_IDS),
    instrument: pick(INSTRUMENTS),
  };
}
