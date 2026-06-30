// generators/section.js — shared helper: build one progression Section from a feel.
// Diatonic feels map a degree template onto the diatonic chords of (tonic, mode);
// chromatic feels map Roman-numeral tokens directly (mode-independent). A Section
// carries provenance (role, keyLabel) so a later phase can persist or export it
// with no rework. Pure.
import { scaleOf } from '../theory/scale.js';
import { diatonicChords } from '../theory/chord.js';
import { chordFromToken } from '../theory/roman.js';
import { noteName } from '../theory/pitch.js';
import { isTokenFeel } from '../feels.js';

// Build a chromatic Section from a list of Roman-numeral tokens. Reused for flat
// token feels and for each labeled block of a sectioned feel.
export function tokenSection(role, tonic, tokens, title) {
  const keyLabel = noteName(tonic); // chromatic feels are absolute — no mode label
  return {
    role,
    keyLabel,
    title: title != null ? title : keyLabel,
    chords: tokens.map((t) => chordFromToken(tonic, t)), // repeats kept, in token order
  };
}

export function buildSection(role, tonic, mode, feel) {
  if (isTokenFeel(feel)) return tokenSection(role, tonic, feel.progression);
  const keyLabel = noteName(tonic) + ' ' + mode.name;
  const chords = diatonicChords(scaleOf(tonic, mode), mode);
  return {
    role,
    keyLabel,
    title: keyLabel, // caller overrides with a display title
    chords: feel.degrees.map((d) => chords[d]), // repeats kept, in feel order
  };
}
