// theory/chord.js — diatonic chords and their triads from a scale. Pure.
import { noteName } from './pitch.js';

// One diatonic chord at scale degree i. Its root is scale[i]; its quality
// symbol ('' major / 'm' minor / 'dim') comes from the mode. The triad
// ("Notes in X") is built by stacking scale thirds: degrees i, i+2, i+4
// (wrapping) — exactly how the original derives it, which keeps the chord
// tones spelled consistently with the parent scale.
export function chordAt(scale, mode, i) {
  const root = scale[i];
  const symbol = mode.qualitySymbols[i];
  const notes = [scale[i], scale[(i + 2) % 7], scale[(i + 4) % 7]];
  return {
    degree: i,
    root,
    symbol,
    name: noteName(root) + symbol,
    notes: notes.map(noteName), // 3 note-name strings
  };
}

// All seven diatonic chords of (scale, mode), degree 0..6.
export function diatonicChords(scale, mode) {
  return scale.map((_, i) => chordAt(scale, mode, i));
}
