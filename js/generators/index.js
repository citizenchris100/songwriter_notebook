// generators/index.js — the ordered list of progression generators.
//
// This is the open/closed seam for progression strategies: adding one (secondary
// dominants, modal interchange, a reharmonizer, …) means appending a function
// here. `deriveOutput` iterates the list and concatenates the Section[] each
// returns — no other file changes, no edits to the core.
import { mainProgression } from './mainProgression.js';
import { alternatives } from './alternatives.js';

export const GENERATORS = [mainProgression, alternatives];
