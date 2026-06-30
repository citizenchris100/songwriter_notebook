// theory/scale.js — build a diatonic scale (7 spelled notes) for a key. Pure.
import { spell } from './spell.js';

// `mode.steps` is the list of semitone gaps between consecutive degrees
// (major = [2,2,1,2,2,2,1]). Accumulate them into absolute semitone offsets
// from the tonic and spell each degree on its own letter (offset i), so the
// scale uses one of each letter A–G and every enharmonic is correct.
export function scaleOf(tonic, mode) {
  const degrees = [];
  let semis = 0;
  for (let i = 0; i < mode.steps.length; i++) {
    degrees.push(spell(tonic, i, semis));
    semis += mode.steps[i];
  }
  return degrees; // 7 Notes
}
