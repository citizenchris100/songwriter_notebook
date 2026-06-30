// generators/section.js — shared helper: build one progression Section by
// mapping a feel's degree template onto the diatonic chords of (tonic, mode).
// A Section carries provenance (role, keyLabel) so a later phase can persist or
// export it with no rework. Pure.
import { scaleOf } from '../theory/scale.js';
import { diatonicChords } from '../theory/chord.js';
import { noteName } from '../theory/pitch.js';

export function buildSection(role, tonic, mode, feel) {
  const keyLabel = noteName(tonic) + ' ' + mode.name;
  const chords = diatonicChords(scaleOf(tonic, mode), mode);
  return {
    role,
    keyLabel,
    title: keyLabel, // caller overrides with a display title
    chords: feel.degrees.map((d) => chords[d]), // repeats kept, in feel order
  };
}
