// generators/mainProgression.js — the chosen feel in the chosen key. Pure.
// A ProgressionGenerator: takes a context and returns Section[]. A flat feel yields
// one "Main Progression" section; a sectioned feel yields one section per labeled
// block (Main, Bridge, …), each titled with its label.
import { buildSection, tokenSection } from './section.js';
import { isSectionedFeel } from '../feels.js';

export function mainProgression(ctx) {
  const { tonic, mode, feel } = ctx;
  if (isSectionedFeel(feel)) {
    return feel.sections.map((s, i) => tokenSection(i === 0 ? 'main' : 'section', tonic, s.progression, s.label));
  }
  const s = buildSection('main', tonic, mode, feel);
  s.title = 'Main Progression';
  return [s];
}
