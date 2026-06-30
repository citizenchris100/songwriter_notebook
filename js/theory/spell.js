// theory/spell.js — key-signature-aware enharmonic speller. Pure.
//
// This is the cornerstone of the engine. The original autochords app walked the
// scale and searched an enharmonic table for a spelling that avoided reusing a
// letter — order-dependent and fragile. Here the two concerns are split and made
// declarative: the *letter* is decided up front by `letterOffset`, and the
// *accidental* falls out of modular arithmetic. Spelling F major → B♭, C♯ major
// → E♯/B♯, A♭ minor → C♭/F♭, and double accidentals all emerge with no special
// cases. Verified against the live app in engine.test.js.
import { LETTER_PC, mod, makeNote } from './pitch.js';

// Spell the note `letterOffset` diatonic steps and `semitones` semitones above
// `tonic`. A scale that walks letterOffset 0..6 therefore uses each letter A–G
// exactly once, which guarantees correct diatonic spelling by construction.
export function spell(tonic, letterOffset, semitones) {
  const letter = mod(tonic.letter + letterOffset, 7);
  const targetPc = mod(LETTER_PC[tonic.letter] + tonic.acc + semitones, 12);
  let acc = mod(targetPc - LETTER_PC[letter], 12);
  if (acc > 6) acc -= 12; // pick the nearer accidental rather than e.g. ♯♯♯♯♯
  return makeNote(letter, acc);
}
