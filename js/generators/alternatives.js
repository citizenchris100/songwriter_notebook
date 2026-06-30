// generators/alternatives.js — three "neighbouring key" progressions that tend
// to sit well with the main one, running the same feel. A ProgressionGenerator.
//
// The original derived these via the circle of fifths and a sharp-biased
// enharmonic table, which mis-spells the dominant/subdominant in flat keys
// (e.g. it labels the subdominant of F major as "A♯ major" with an F♯♯m chord).
// The neighbours are simply the dominant (V), subdominant (IV) and relative
// (vi in major / III in minor), so we read their roots straight off the
// already-correctly-spelled diatonic scale. Same pitches as the original in
// every key, correct spelling in every key. Pure.
//
// These are diatonic reinterpretations (read off the parent scale), so they do not
// apply to chromatic/token feels — those return no alternatives.
import { scaleOf } from '../theory/scale.js';
import { buildSection } from './section.js';
import { isChromaticFeel } from '../feels.js';

export function alternatives(ctx) {
  const { tonic, mode, feel, modes } = ctx;
  if (isChromaticFeel(feel)) return [];
  const scale = scaleOf(tonic, mode);
  const relativeMode = modes[mode.opposingModeId];

  const make = (role, label, root, m) => {
    const s = buildSection(role, root, m, feel);
    s.title = label + ' · ' + s.keyLabel;
    return s;
  };

  return [
    make('relative', 'Relative', scale[mode.relativeDegree], relativeMode),
    make('dominant', 'Dominant', scale[4], mode),
    make('subdominant', 'Subdominant', scale[3], mode),
  ];
}
