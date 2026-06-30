// derive.js — pure orchestration. Turns app state into the full output model the
// UI renders. The primary test target: deterministic, no DOM, no storage. Feels
// are injected (feelsById) so this stays pure while feels load dynamically from JSON.
import { MODE_BY_ID } from './data/modes.js';
import { scaleOf } from './theory/scale.js';
import { diatonicChords } from './theory/chord.js';
import { noteName, LETTERS } from './theory/pitch.js';
import { GENERATORS } from './generators/index.js';

const ACC_OFFSET = { flat: -1, natural: 0, sharp: 1 };
const LETTER_INDEX = Object.fromEntries(LETTERS.map((l, i) => [l, i]));

// Resolve app state (string ids) into engine objects, given the available feels.
export function resolveContext(state, feelsById) {
  const tonic = { letter: LETTER_INDEX[state.root], acc: ACC_OFFSET[state.accidental] };
  const mode = MODE_BY_ID[state.mode];
  const feel = feelsById[state.feel];
  return { tonic, mode, feel, modes: MODE_BY_ID };
}

// The full output model: the key label, the diatonic chords, and every generated
// progression section (main + alternatives, in order). `feelsById` maps feel id
// -> feel ({ id, name, degrees }).
export function deriveOutput(state, feelsById) {
  const ctx = resolveContext(state, feelsById);
  const allChords = diatonicChords(scaleOf(ctx.tonic, ctx.mode), ctx.mode);
  const sections = GENERATORS.flatMap((gen) => gen(ctx));
  return {
    keyLabel: noteName(ctx.tonic) + ' ' + ctx.mode.name,
    feelName: ctx.feel.name,
    allChords,
    sections,
  };
}
