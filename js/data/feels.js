// data/feels.js — the 16 progression "feels". Each is a template of diatonic
// scale-degree indices (0..6); the engine maps it onto whatever key is chosen.
// Order matches the original's picker. Adding a feel is one entry here. Pure data.
export const FEELS = [
  { id: 'alternative', name: 'Alternative', degrees: [5, 3, 0, 4] },
  { id: 'canon', name: 'Canon', degrees: [0, 4, 5, 2, 3, 0, 3, 4] },
  { id: 'cliche', name: 'Cliché', degrees: [0, 4, 5, 3] },
  { id: 'cliche2', name: 'Cliché 2', degrees: [0, 5, 2, 6] },
  { id: 'creepy', name: 'Creepy', degrees: [0, 5, 3, 4] },
  { id: 'creepy2', name: 'Creepy 2', degrees: [0, 5, 1, 4] },
  { id: 'endless', name: 'Endless', degrees: [0, 5, 1, 3] },
  { id: 'energetic', name: 'Energetic', degrees: [0, 2, 3, 5] },
  { id: 'grungy', name: 'Grungy', degrees: [0, 3, 2, 5] },
  { id: 'memories', name: 'Memories', degrees: [0, 3, 0, 4] },
  { id: 'rebellious', name: 'Rebellious', degrees: [3, 0, 3, 4] },
  { id: 'sad', name: 'Sad', degrees: [0, 3, 4, 4] },
  { id: 'simple', name: 'Simple', degrees: [0, 3] },
  { id: 'simple2', name: 'Simple 2', degrees: [0, 4] },
  { id: 'twelveBarBlues', name: 'Twelve Bar Blues', degrees: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4] },
  { id: 'wistful', name: 'Wistful', degrees: [0, 0, 3, 5] },
];
