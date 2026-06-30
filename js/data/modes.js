// data/modes.js — the modes Phase 1 supports. Pure data (OCP extension point:
// adding dorian / harmonic-minor etc. is one entry here, no logic changes).
//
//   steps          : semitone gaps between successive scale degrees
//   qualitySymbols : diatonic triad quality at each degree ('' maj / 'm' min / 'dim')
//   relativeDegree : scale-degree index whose note is the relative key's tonic
//                    (vi in major, III in minor)
//   opposingModeId : the relative key's mode
export const MODES = [
  {
    id: 'major',
    name: 'major',
    steps: [2, 2, 1, 2, 2, 2, 1],
    qualitySymbols: ['', 'm', 'm', '', '', 'm', 'dim'],
    relativeDegree: 5,
    opposingModeId: 'minor',
  },
  {
    id: 'minor', // natural minor (aeolian)
    name: 'minor',
    steps: [2, 1, 2, 2, 1, 2, 2],
    qualitySymbols: ['m', 'dim', '', 'm', 'm', '', ''],
    relativeDegree: 2,
    opposingModeId: 'major',
  },
];

export const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));
