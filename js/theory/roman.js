// theory/roman.js — parse Roman-numeral chord tokens into spelled chords. Pure.
//
// A token names a chord by its position relative to the tonic, so a feel built
// from tokens is key-independent AND can be non-diatonic — bII, bVI, V/V (as II),
// #iv, planed power chords — which the diatonic degree model (0..6 in one mode)
// cannot represent. Grammar:
//
//   token := accidental? numeral quality?
//     accidental : "b" | "#"                       chromatic alteration of the root
//     numeral    : I..VII, case-sensitive          CASE = base quality (UPPER major, lower minor)
//     quality    : 5 | o | dim | + | aug | 7 | maj7 | m7 | sus2 | sus4   (optional; overrides)
//
// The numeral fixes the *letter* the root is spelled on (so bVII is a flatted-7th
// letter = B♭ in C, never A♯), the accidental shifts the semitone, and every chord
// tone is spelled with the same speller the diatonic scales use — correct
// enharmonics in every key. Chord tones are spelled relative to the root, not the
// tonic, which is what lets a chromatic root still carry a correctly-spelled triad.
import { spell } from './spell.js';
import { noteName } from './pitch.js';

// numeral (lowercased) -> [letter offset 0..6 from tonic, natural semitone in the major scale]
const NUMERALS = {
  i: [0, 0], ii: [1, 2], iii: [2, 4], iv: [3, 5], v: [4, 7], vi: [5, 9], vii: [6, 11],
};

// quality id -> { symbol, ivals }. ivals are [letterOffsetFromRoot, semitonesFromRoot]
// for each chord tone: root(0,0), third(2,_), fifth(4,7), seventh(6,_). Power chords
// are thirdless (root + fifth only) — the honest shape of a rhythm-guitar source.
const QUALITIES = {
  maj:  { symbol: '',     ivals: [[0, 0], [2, 4], [4, 7]] },
  min:  { symbol: 'm',    ivals: [[0, 0], [2, 3], [4, 7]] },
  dim:  { symbol: 'dim',  ivals: [[0, 0], [2, 3], [4, 6]] },
  aug:  { symbol: 'aug',  ivals: [[0, 0], [2, 4], [4, 8]] },
  pow:  { symbol: '5',    ivals: [[0, 0], [4, 7]] },
  sus2: { symbol: 'sus2', ivals: [[0, 0], [1, 2], [4, 7]] },
  sus4: { symbol: 'sus4', ivals: [[0, 0], [3, 5], [4, 7]] },
  dom7: { symbol: '7',    ivals: [[0, 0], [2, 4], [4, 7], [6, 10]] },
  maj7: { symbol: 'maj7', ivals: [[0, 0], [2, 4], [4, 7], [6, 11]] },
  min7: { symbol: 'm7',   ivals: [[0, 0], [2, 3], [4, 7], [6, 10]] },
};

// Match a leading numeral, longest-first within each case so "VII" wins over "VI"
// over "V", and "III"/"II" over "I". Case decides the base triad quality.
const NUMERAL_RE = /^(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)/;

function qualityOf(isMinor, suffix) {
  switch (suffix) {
    case '':     return isMinor ? 'min' : 'maj';
    case '5':    return 'pow';
    case 'o':
    case 'dim':  return 'dim';
    case '+':
    case 'aug':  return 'aug';
    case 'sus2': return 'sus2';
    case 'sus4': return 'sus4';
    case '7':    return isMinor ? 'min7' : 'dom7';
    case 'maj7': return 'maj7';
    case 'm7':   return 'min7';
    default:     return null;
  }
}

// Parse a token into { letterOffset, semitones (from tonic), quality }, or null if
// it is not a well-formed token. Pure, total — never throws.
export function parseToken(tok) {
  if (typeof tok !== 'string' || tok.length === 0) return null;
  let s = tok;
  let acc = 0;
  if (s[0] === 'b') { acc = -1; s = s.slice(1); }
  else if (s[0] === '#') { acc = 1; s = s.slice(1); }
  const m = s.match(NUMERAL_RE);
  if (!m) return null;
  const num = m[1];
  const isMinor = num === num.toLowerCase();
  const quality = qualityOf(isMinor, s.slice(num.length));
  if (!quality) return null;
  const [letterOffset, natSemi] = NUMERALS[num.toLowerCase()];
  return { letterOffset, semitones: natSemi + acc, quality };
}

export const isValidToken = (tok) => parseToken(tok) !== null;

// Build the spelled chord a token names, in the key whose tonic Note is given.
// Returns { token, root, symbol, name, quality, notes:[name strings] }, or null
// for a malformed token (callers gate on validateFeel, so this is defensive).
export function chordFromToken(tonic, token) {
  const p = parseToken(token);
  if (!p) return null;
  const root = spell(tonic, p.letterOffset, p.semitones);
  const q = QUALITIES[p.quality];
  const notes = q.ivals.map(([lo, semi]) => spell(root, lo, semi));
  return {
    token,
    root,
    symbol: q.symbol,
    quality: p.quality,
    name: noteName(root) + q.symbol,
    notes: notes.map(noteName),
  };
}

// Build a chord directly from an absolute root Note and a quality id (any key of
// QUALITIES; the Songs-tab picker uses 'maj' / 'min'). Same speller as chordFromToken,
// so the triad is spelled correctly relative to the root. Returns
// { root, symbol, quality, name, notes:[name strings] }, or null for a bad quality.
export function chordFromRootAndQuality(root, quality) {
  const q = QUALITIES[quality];
  if (!q) return null;
  const notes = q.ivals.map(([lo, semi]) => spell(root, lo, semi));
  return {
    root,
    symbol: q.symbol,
    quality,
    name: noteName(root) + q.symbol,
    notes: notes.map(noteName),
  };
}

// The 12 chromatic tones from C, each carrying BOTH spellings of its root. The
// Songs-tab picker lists these; naturals have identical sharp/flat, the 5 black keys
// carry both (label shows both, e.g. "C♯ / D♭").
export const CHROMATIC_TONES = [
  { label: 'C', sharp: { letter: 0, acc: 0 }, flat: { letter: 0, acc: 0 } },
  { label: 'C♯ / D♭', sharp: { letter: 0, acc: 1 }, flat: { letter: 1, acc: -1 } },
  { label: 'D', sharp: { letter: 1, acc: 0 }, flat: { letter: 1, acc: 0 } },
  { label: 'D♯ / E♭', sharp: { letter: 1, acc: 1 }, flat: { letter: 2, acc: -1 } },
  { label: 'E', sharp: { letter: 2, acc: 0 }, flat: { letter: 2, acc: 0 } },
  { label: 'F', sharp: { letter: 3, acc: 0 }, flat: { letter: 3, acc: 0 } },
  { label: 'F♯ / G♭', sharp: { letter: 3, acc: 1 }, flat: { letter: 4, acc: -1 } },
  { label: 'G', sharp: { letter: 4, acc: 0 }, flat: { letter: 4, acc: 0 } },
  { label: 'G♯ / A♭', sharp: { letter: 4, acc: 1 }, flat: { letter: 5, acc: -1 } },
  { label: 'A', sharp: { letter: 5, acc: 0 }, flat: { letter: 5, acc: 0 } },
  { label: 'A♯ / B♭', sharp: { letter: 5, acc: 1 }, flat: { letter: 6, acc: -1 } },
  { label: 'B', sharp: { letter: 6, acc: 0 }, flat: { letter: 6, acc: 0 } },
];

// Build the chord for a CHROMATIC_TONES entry + quality, choosing the root spelling
// that avoids double accidentals: flat root for major (E♭, A♭ …), sharp root for minor
// (C♯m, G♯m …). Naturals are unaffected (their sharp and flat spellings are identical).
export function chordForTone(tone, quality) {
  const root = quality === 'min' ? tone.sharp : tone.flat;
  return chordFromRootAndQuality(root, quality);
}
