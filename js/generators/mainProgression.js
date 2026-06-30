// generators/mainProgression.js — the chosen feel in the chosen key. Pure.
// A ProgressionGenerator: takes a context and returns Section[].
import { buildSection } from './section.js';

export function mainProgression(ctx) {
  const s = buildSection('main', ctx.tonic, ctx.mode, ctx.feel);
  s.title = 'Main Progression';
  return [s];
}
