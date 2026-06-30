// derive.js — pure orchestration. Turns app state into the full output model the
// UI renders. The primary test target: deterministic, no DOM, no storage. Feels
// are injected (feelsById) so this stays pure while feels load dynamically from JSON.
import { MODE_BY_ID } from './data/modes.js';
import { scaleOf } from './theory/scale.js';
import { diatonicChords } from './theory/chord.js';
import { noteName, LETTERS } from './theory/pitch.js';
import { GENERATORS } from './generators/index.js';
import { isTokenFeel } from './feels.js';

const ACC_OFFSET = { flat: -1, natural: 0, sharp: 1 };
const LETTER_INDEX = Object.fromEntries(LETTERS.map((l, i) => [l, i]));

// Resolve app state (string ids) into engine objects, given the available feels.
export function resolveContext(state, feelsById) {
  const tonic = { letter: LETTER_INDEX[state.root], acc: ACC_OFFSET[state.accidental] };
  const mode = MODE_BY_ID[state.mode];
  const feel = feelsById[state.feel];
  return { tonic, mode, feel, modes: MODE_BY_ID };
}

// The distinct chords used in a section, in first-seen order (the reference list
// for a chromatic feel, which has no parent key to enumerate).
function chordsUsed(section) {
  const seen = new Set();
  const out = [];
  for (const c of section.chords) {
    if (c && !seen.has(c.name)) { seen.add(c.name); out.push(c); }
  }
  return out;
}

// The full output model: the key label, the reference chords, and every generated
// progression section (main + alternatives, in order). `feelsById` maps feel id
// -> feel ({ id, name, degrees | progression }). For a chromatic (token) feel the
// mode does not apply: there are no diatonic alternatives, `allChords` is the set
// of chords the progression actually uses, and `chromatic` is true.
export function deriveOutput(state, feelsById) {
  const ctx = resolveContext(state, feelsById);
  const sections = GENERATORS.flatMap((gen) => gen(ctx));
  const chromatic = isTokenFeel(ctx.feel);
  const main = sections.find((s) => s.role === 'main');
  return {
    keyLabel: chromatic ? noteName(ctx.tonic) : noteName(ctx.tonic) + ' ' + ctx.mode.name,
    feelName: ctx.feel.name,
    chromatic,
    allChords: chromatic ? chordsUsed(main) : diatonicChords(scaleOf(ctx.tonic, ctx.mode), ctx.mode),
    sections,
  };
}
