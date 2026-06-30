// derive.js — pure orchestration. Turns app state into the full output model the
// UI renders. The primary test target: deterministic, no DOM, no storage.
import { MODE_BY_ID } from './data/modes.js';
import { FEELS } from './data/feels.js';
import { scaleOf } from './theory/scale.js';
import { diatonicChords } from './theory/chord.js';
import { noteName, LETTERS } from './theory/pitch.js';
import { GENERATORS } from './generators/index.js';

const ACC_OFFSET = { flat: -1, natural: 0, sharp: 1 };
const LETTER_INDEX = Object.fromEntries(LETTERS.map((l, i) => [l, i]));

// Resolve app state (string ids + indices) into engine objects.
export function resolveContext(state) {
  const tonic = { letter: LETTER_INDEX[state.root], acc: ACC_OFFSET[state.accidental] };
  const mode = MODE_BY_ID[state.mode];
  const feel = FEELS[state.feel];
  return { tonic, mode, feel, modes: MODE_BY_ID };
}

// The full output model: the key label, the diatonic chords, and every
// generated progression section (main + alternatives, in order).
export function deriveOutput(state) {
  const ctx = resolveContext(state);
  const allChords = diatonicChords(scaleOf(ctx.tonic, ctx.mode), ctx.mode);
  const sections = GENERATORS.flatMap((gen) => gen(ctx));
  return {
    keyLabel: noteName(ctx.tonic) + ' ' + ctx.mode.name,
    feelName: ctx.feel.name,
    allChords,
    sections,
  };
}
