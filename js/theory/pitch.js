// theory/pitch.js — primitive pitch constants and helpers. Pure, no I/O.
//
// A Note in this engine is a plain record { letter, acc }:
//   letter : 0..6  index into LETTERS (C..B)
//   acc    : integer accidental offset in semitones (… -2 ♭♭, -1 ♭, 0, +1 ♯, +2 ♯♯ …)
// Spelling identity lives in the *letter*, not the pitch class, which is what
// lets B♭ differ from A♯ and lets double accidentals exist for theoretical keys.

// Diatonic letters in scale order starting from C.
export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

// Natural pitch-class (0..11) of each letter, indexed to LETTERS.
export const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

// The three accidentals the Phase-1 key picker exposes.
export const ACCIDENTALS = [
  { id: 'flat', offset: -1, symbol: '♭' },
  { id: 'natural', offset: 0, symbol: '' },
  { id: 'sharp', offset: 1, symbol: '♯' },
];

// Positive modulo (JS % keeps the sign of the dividend).
export const mod = (n, m) => ((n % m) + m) % m;

// Render an integer accidental offset as glyphs. Doubles (♯♯ / ♭♭) only arise
// in theoretical keys such as B♯ major; they are spelled, not hidden.
export function accSymbol(offset) {
  if (offset === 0) return '';
  return (offset > 0 ? '♯' : '♭').repeat(Math.abs(offset));
}

export const makeNote = (letter, acc) => ({ letter, acc });
export const noteName = (note) => LETTERS[note.letter] + accSymbol(note.acc);
export const notePc = (note) => mod(LETTER_PC[note.letter] + note.acc, 12);
