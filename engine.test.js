// engine.test.js — verifies the pure music-theory core against vectors captured
// from the live autochords.com app. Zero dependencies; run with `node engine.test.js`.
//
// Phase 2: feels are loaded from feels/*.json (read from disk here) and injected,
// so this also proves the JSON migration is LOSSLESS (identical output to the old
// hard-coded array) and that the schema + manifest + service-worker asset list are
// all consistent. The flat-key alternative roots use the corrected (key-aware)
// spelling; everything else matches the original (see generators/alternatives.js).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveOutput } from './js/derive.js';
import { scaleOf } from './js/theory/scale.js';
import { noteName } from './js/theory/pitch.js';
import { MODE_BY_ID } from './js/data/modes.js';
import { DEFAULT_STATE, validate, randomize, ROOTS, MODE_IDS } from './js/session.js';
import { validateFeel, normalizeFeel } from './js/feels.js';
import {
  validateSong, normalizeSong, nextUntitledName, slugifySongId, buildCapturedProgression,
  createSong, appendProgressions, reorderProgression, removeProgression,
  setProgressionLabel, setLyrics, renameSong, finalizeDraft,
  appendRow, addChord, setChord, removeChord,
} from './js/songs.js';
import {
  isAcceptedAudio, makeSketchMeta, validateSketchMeta,
  addSketchMeta, removeSketchMeta, setSketchNotes,
} from './js/sketches.js';
import { chordFromRootAndQuality, chordForTone, CHROMATIC_TONES } from './js/theory/roman.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const readJSON = (p) => JSON.parse(readFileSync(here(p), 'utf8'));

// ---- load feels from disk (the app fetches the same files at runtime) ----
const BUILTIN_IDS = readJSON('./feels/index.json');
const BUILTIN = BUILTIN_IDS.map((id) => readJSON(`./feels/${id}.json`));
const feelsById = Object.fromEntries(BUILTIN.map((f) => [f.id, f]));
const idByName = Object.fromEntries(BUILTIN.map((f) => [f.name, f.id]));
const FEEL_IDS = BUILTIN_IDS.slice();

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.log('FAIL ' + label + '\n  got:  ' + got + '\n  want: ' + want); }
}
function ok(label, cond) {
  if (cond) { pass++; } else { fail++; console.log('FAIL ' + label); }
}

const stateOf = (root, accidental, mode, feel) => ({ feel, root, accidental, mode, instrument: 'guitar' });
const feelId = (name) => idByName[name];

function allChordsAt(root, acc, mode) {
  return deriveOutput(stateOf(root, acc, mode, 'cliche'), feelsById).allChords
    .map((c) => `${c.name}[${c.notes.join(',')}]`).join(' ');
}
function sectionsAt(root, acc, mode, feelName) {
  return deriveOutput(stateOf(root, acc, mode, feelId(feelName)), feelsById).sections;
}
function mainAt(root, acc, mode, feelName) {
  return sectionsAt(root, acc, mode, feelName).find((s) => s.role === 'main').chords.map((c) => c.name).join(' ');
}
function altAt(root, acc, mode, feelName, role) {
  return sectionsAt(root, acc, mode, feelName).find((s) => s.role === role).chords.map((c) => c.name).join(' ');
}
function scaleStr(root, acc, mode) {
  return scaleOf({ letter: ROOTS.indexOf(root), acc: { flat: -1, natural: 0, sharp: 1 }[acc] }, MODE_BY_ID[mode])
    .map(noteName).join(' ');
}

// ============================================================================
// 1. All diatonic chords + triad notes — 12 roots x {major, minor} (oracle)
// ============================================================================
const ALL_CHORDS = {
  'C natural major': 'C[C,E,G] Dm[D,F,A] Em[E,G,B] F[F,A,C] G[G,B,D] Am[A,C,E] Bdim[B,D,F]',
  'G natural major': 'G[G,B,D] Am[A,C,E] Bm[B,D,F♯] C[C,E,G] D[D,F♯,A] Em[E,G,B] F♯dim[F♯,A,C]',
  'D natural major': 'D[D,F♯,A] Em[E,G,B] F♯m[F♯,A,C♯] G[G,B,D] A[A,C♯,E] Bm[B,D,F♯] C♯dim[C♯,E,G]',
  'A natural major': 'A[A,C♯,E] Bm[B,D,F♯] C♯m[C♯,E,G♯] D[D,F♯,A] E[E,G♯,B] F♯m[F♯,A,C♯] G♯dim[G♯,B,D]',
  'E natural major': 'E[E,G♯,B] F♯m[F♯,A,C♯] G♯m[G♯,B,D♯] A[A,C♯,E] B[B,D♯,F♯] C♯m[C♯,E,G♯] D♯dim[D♯,F♯,A]',
  'B natural major': 'B[B,D♯,F♯] C♯m[C♯,E,G♯] D♯m[D♯,F♯,A♯] E[E,G♯,B] F♯[F♯,A♯,C♯] G♯m[G♯,B,D♯] A♯dim[A♯,C♯,E]',
  'F natural major': 'F[F,A,C] Gm[G,B♭,D] Am[A,C,E] B♭[B♭,D,F] C[C,E,G] Dm[D,F,A] Edim[E,G,B♭]',
  'C sharp major': 'C♯[C♯,E♯,G♯] D♯m[D♯,F♯,A♯] E♯m[E♯,G♯,B♯] F♯[F♯,A♯,C♯] G♯[G♯,B♯,D♯] A♯m[A♯,C♯,E♯] B♯dim[B♯,D♯,F♯]',
  'F sharp major': 'F♯[F♯,A♯,C♯] G♯m[G♯,B,D♯] A♯m[A♯,C♯,E♯] B[B,D♯,F♯] C♯[C♯,E♯,G♯] D♯m[D♯,F♯,A♯] E♯dim[E♯,G♯,B]',
  'E flat major': 'E♭[E♭,G,B♭] Fm[F,A♭,C] Gm[G,B♭,D] A♭[A♭,C,E♭] B♭[B♭,D,F] Cm[C,E♭,G] Ddim[D,F,A♭]',
  'B flat major': 'B♭[B♭,D,F] Cm[C,E♭,G] Dm[D,F,A] E♭[E♭,G,B♭] F[F,A,C] Gm[G,B♭,D] Adim[A,C,E♭]',
  'A flat major': 'A♭[A♭,C,E♭] B♭m[B♭,D♭,F] Cm[C,E♭,G] D♭[D♭,F,A♭] E♭[E♭,G,B♭] Fm[F,A♭,C] Gdim[G,B♭,D♭]',
  'A natural minor': 'Am[A,C,E] Bdim[B,D,F] C[C,E,G] Dm[D,F,A] Em[E,G,B] F[F,A,C] G[G,B,D]',
  'E natural minor': 'Em[E,G,B] F♯dim[F♯,A,C] G[G,B,D] Am[A,C,E] Bm[B,D,F♯] C[C,E,G] D[D,F♯,A]',
  'B natural minor': 'Bm[B,D,F♯] C♯dim[C♯,E,G] D[D,F♯,A] Em[E,G,B] F♯m[F♯,A,C♯] G[G,B,D] A[A,C♯,E]',
  'F sharp minor': 'F♯m[F♯,A,C♯] G♯dim[G♯,B,D] A[A,C♯,E] Bm[B,D,F♯] C♯m[C♯,E,G♯] D[D,F♯,A] E[E,G♯,B]',
  'C sharp minor': 'C♯m[C♯,E,G♯] D♯dim[D♯,F♯,A] E[E,G♯,B] F♯m[F♯,A,C♯] G♯m[G♯,B,D♯] A[A,C♯,E] B[B,D♯,F♯]',
  'D natural minor': 'Dm[D,F,A] Edim[E,G,B♭] F[F,A,C] Gm[G,B♭,D] Am[A,C,E] B♭[B♭,D,F] C[C,E,G]',
  'G natural minor': 'Gm[G,B♭,D] Adim[A,C,E♭] B♭[B♭,D,F] Cm[C,E♭,G] Dm[D,F,A] E♭[E♭,G,B♭] F[F,A,C]',
  'C natural minor': 'Cm[C,E♭,G] Ddim[D,F,A♭] E♭[E♭,G,B♭] Fm[F,A♭,C] Gm[G,B♭,D] A♭[A♭,C,E♭] B♭[B♭,D,F]',
  'F natural minor': 'Fm[F,A♭,C] Gdim[G,B♭,D♭] A♭[A♭,C,E♭] B♭m[B♭,D♭,F] Cm[C,E♭,G] D♭[D♭,F,A♭] E♭[E♭,G,B♭]',
  'B flat minor': 'B♭m[B♭,D♭,F] Cdim[C,E♭,G♭] D♭[D♭,F,A♭] E♭m[E♭,G♭,B♭] Fm[F,A♭,C] G♭[G♭,B♭,D♭] A♭[A♭,C,E♭]',
  'E flat minor': 'E♭m[E♭,G♭,B♭] Fdim[F,A♭,C♭] G♭[G♭,B♭,D♭] A♭m[A♭,C♭,E♭] B♭m[B♭,D♭,F] C♭[C♭,E♭,G♭] D♭[D♭,F,A♭]',
  'A flat minor': 'A♭m[A♭,C♭,E♭] B♭dim[B♭,D♭,F♭] C♭[C♭,E♭,G♭] D♭m[D♭,F♭,A♭] E♭m[E♭,G♭,B♭] F♭[F♭,A♭,C♭] G♭[G♭,B♭,D♭]',
};
for (const [label, want] of Object.entries(ALL_CHORDS)) {
  const [root, acc, mode] = label.split(' ');
  eq('allChords ' + label, allChordsAt(root, acc, mode), want);
}

// ============================================================================
// 2. Main progressions — all 16 feels x {C major, A minor} (lossless migration)
// ============================================================================
const MAIN_C_MAJOR = {
  Alternative: 'Am F C G', Canon: 'C G Am Em F C F G', 'Cliché': 'C G Am F',
  'Cliché 2': 'C Am Em Bdim', 'Doo Wop': 'C Am F G', 'Doo Wop 2': 'C Am Dm G',
  Endless: 'C Am Dm F', Energetic: 'C Em F Am', Grungy: 'C F Em Am',
  Memories: 'C F C G', Rebellious: 'F C F G', Sad: 'C F G G',
  Simple: 'C F', 'Simple 2': 'C G', 'Twelve Bar Blues': 'C C C C F F C C G F C G',
  Wistful: 'C C F Am',
};
const MAIN_A_MINOR = {
  Alternative: 'F Dm Am Em', Canon: 'Am Em F C Dm Am Dm Em', 'Cliché': 'Am Em F Dm',
  'Cliché 2': 'Am F C G', 'Doo Wop': 'Am F Dm Em', 'Doo Wop 2': 'Am F Bdim Em',
  Endless: 'Am F Bdim Dm', Energetic: 'Am C Dm F', Grungy: 'Am Dm C F',
  Memories: 'Am Dm Am Em', Rebellious: 'Dm Am Dm Em', Sad: 'Am Dm Em Em',
  Simple: 'Am Dm', 'Simple 2': 'Am Em', 'Twelve Bar Blues': 'Am Am Am Am Dm Dm Am Am Em Dm Am Em',
  Wistful: 'Am Am Dm F',
};
for (const [feel, want] of Object.entries(MAIN_C_MAJOR)) eq('main C major ' + feel, mainAt('C', 'natural', 'major', feel), want);
for (const [feel, want] of Object.entries(MAIN_A_MINOR)) eq('main A minor ' + feel, mainAt('A', 'natural', 'minor', feel), want);

// ============================================================================
// 3. Alternatives — full set for C major / A minor (exact oracle match)
// ============================================================================
eq('alt relative  C major Cliché', altAt('C', 'natural', 'major', 'Cliché', 'relative'), 'Am Em F Dm');
eq('alt dominant  C major Cliché', altAt('C', 'natural', 'major', 'Cliché', 'dominant'), 'G D Em C');
eq('alt subdom    C major Cliché', altAt('C', 'natural', 'major', 'Cliché', 'subdominant'), 'F C Dm B♭');
eq('alt relative  A minor Cliché', altAt('A', 'natural', 'minor', 'Cliché', 'relative'), 'C G Am F');
eq('alt dominant  A minor Cliché', altAt('A', 'natural', 'minor', 'Cliché', 'dominant'), 'Em Bm C Am');
eq('alt subdom    A minor Cliché', altAt('A', 'natural', 'minor', 'Cliché', 'subdominant'), 'Dm Am B♭ Gm');
eq('alt label dominant C major', sectionsAt('C', 'natural', 'major', 'Cliché').find((s) => s.role === 'dominant').title, 'Dominant · G major');

// ============================================================================
// 4. Flat-key alternative roots — CORRECTED spelling (original mis-spells these)
// ============================================================================
eq('alt subdom  F major  (B♭, not A♯)', altAt('F', 'natural', 'major', 'Cliché', 'subdominant'), 'B♭ F Gm E♭');
eq('alt subdom  B♭ major (E♭, not D♯)', altAt('B', 'flat', 'major', 'Cliché', 'subdominant'), 'E♭ B♭ Cm A♭');
eq('alt dominant A♭ major (E♭, not D♯)', altAt('A', 'flat', 'major', 'Cliché', 'dominant'), 'E♭ B♭ Cm A♭');
eq('alt subdom  A♭ major (D♭, not C♯)', altAt('A', 'flat', 'major', 'Cliché', 'subdominant'), 'D♭ A♭ B♭m G♭');

// ============================================================================
// 5. Speller edge cases — scale spelling incl. theoretical/double accidentals
// ============================================================================
eq('scale F major', scaleStr('F', 'natural', 'major'), 'F G A B♭ C D E');
eq('scale C♯ major', scaleStr('C', 'sharp', 'major'), 'C♯ D♯ E♯ F♯ G♯ A♯ B♯');
eq('scale A♭ minor', scaleStr('A', 'flat', 'minor'), 'A♭ B♭ C♭ D♭ E♭ F♭ G♭');
eq('scale E♭ major', scaleStr('E', 'flat', 'major'), 'E♭ F G A♭ B♭ C D');

// ============================================================================
// 6. Output model structure + state model (feel is now an id)
// ============================================================================
const sample = deriveOutput(DEFAULT_STATE, feelsById);
ok('default state derives 4 sections (main + 3 alts)', sample.sections.length === 4);
eq('section roles in order', sample.sections.map((s) => s.role).join(','), 'main,relative,dominant,subdominant');
ok('default key label is C major', sample.keyLabel === 'C major');
eq('default feel is Cliché', sample.feelName, 'Cliché');
ok('every chord chip has 3 triad notes', sample.sections.every((s) => s.chords.every((c) => c.notes.length === 3)));

eq('validate garbage → defaults', JSON.stringify(validate({ feel: 'nope', root: 'Q', mode: 'lydian', accidental: 'x', instrument: 'kazoo' }, FEEL_IDS)), JSON.stringify(DEFAULT_STATE));
eq('validate keeps a known feel id', validate({ feel: 'sad', root: 'C', accidental: 'natural', mode: 'major', instrument: 'guitar' }, FEEL_IDS).feel, 'sad');

const seq = [0.99, 0.5, 0.0, 0.5, 0.2]; let i = 0; const rng = () => seq[i++ % seq.length];
const r = randomize(rng, FEEL_IDS);
ok('randomize feel is a known id', FEEL_IDS.includes(r.feel));
ok('randomize root valid', ROOTS.includes(r.root));
ok('randomize mode valid', MODE_IDS.includes(r.mode));
eq('randomize accidental reset to natural', r.accidental, 'natural');

// ============================================================================
// 7. Feel schema (validateFeel mirrors feels/feel.schema.json)
// ============================================================================
for (const id of BUILTIN_IDS) ok('schema accepts ' + id, validateFeel(readJSON(`./feels/${id}.json`)).ok);
ok('schema rejects out-of-range degree', !validateFeel({ id: 'x', name: 'X', degrees: [0, 7] }).ok);
ok('schema rejects bad id', !validateFeel({ id: 'Bad ID', name: 'X', degrees: [0] }).ok);
ok('schema rejects missing degrees', !validateFeel({ id: 'x', name: 'X' }).ok);
ok('schema rejects empty degrees', !validateFeel({ id: 'x', name: 'X', degrees: [] }).ok);
ok('schema rejects unknown property', !validateFeel({ id: 'x', name: 'X', degrees: [0], bogus: 1 }).ok);
ok('schema accepts optional fields', validateFeel({ id: 'x', name: 'X', degrees: [0, 3], description: 'd', tags: ['t'], schemaVersion: 1 }).ok);

// ============================================================================
// 8. Manifest + service-worker asset-list integrity
// ============================================================================
const feelFiles = readdirSync(here('./feels')).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'feel.schema.json');
const fileIds = feelFiles.map((f) => f.replace(/\.json$/, '')).sort();
eq('index.json lists exactly the feel files present', BUILTIN_IDS.slice().sort().join(','), fileIds.join(','));
const sw = readFileSync(here('./sw.js'), 'utf8');
ok('sw.js caches the manifest', sw.includes('"./feels/index.json"'));
for (const id of BUILTIN_IDS) ok('sw.js caches feel ' + id, sw.includes(`"./feels/${id}.json"`));
ok('sw.js caches the roman.js module', sw.includes('"./js/theory/roman.js"'));
for (const f of ['dom', 'songs', 'songStore', 'songsView', 'sketches', 'audioStore', 'sketchesView']) ok('sw.js caches ' + f + '.js', sw.includes(`"./js/${f}.js"`));

// ============================================================================
// 9. Chromatic (Roman-numeral token) feels — non-diatonic progressions
// ============================================================================
// Feels are injected here (not committed as built-ins) so the engine is proven
// without prescribing any particular content — the /songwriter-pwa-feel skill is
// what authors real chromatic feels from analysis.
const tfChrom = normalizeFeel({ id: 'wf-chromatic', name: 'WF Chromatic', progression: ['i', 'bVII', 'bVI', 'bVII'], schemaVersion: 2 });
const tfPower = normalizeFeel({ id: 'wf-power', name: 'WF Power', progression: ['I5', 'bIII5', 'IV5', 'I5'], schemaVersion: 2 });
const tfSeven = normalizeFeel({ id: 'wf-7', name: 'WF7', progression: ['I', 'V7', 'ii7', 'bII'], schemaVersion: 2 });
const tfById = { ...feelsById, [tfChrom.id]: tfChrom, [tfPower.id]: tfPower, [tfSeven.id]: tfSeven };
const tokenMain = (root, acc, mode, id) =>
  deriveOutput(stateOf(root, acc, mode, id), tfById).sections.find((s) => s.role === 'main').chords.map((c) => c.name).join(' ');

// Same loop is transposed correctly and spelled key-correctly in every key.
eq('chromatic i bVII bVI bVII in A', tokenMain('A', 'natural', 'minor', 'wf-chromatic'), 'Am G F G');
eq('chromatic same loop in C', tokenMain('C', 'natural', 'minor', 'wf-chromatic'), 'Cm B♭ A♭ B♭');
eq('chromatic same loop in E', tokenMain('E', 'natural', 'minor', 'wf-chromatic'), 'Em D C D');
// Mode-independent: tokens carry their own quality, so major mode gives the same chords.
eq('chromatic mode-independent', tokenMain('A', 'natural', 'major', 'wf-chromatic'), 'Am G F G');

const chromModel = deriveOutput(stateOf('A', 'natural', 'minor', 'wf-chromatic'), tfById);
ok('chromatic flag is set', chromModel.chromatic === true);
ok('chromatic feel yields only the main section (no alternatives)', chromModel.sections.length === 1);
eq('chromatic keyLabel is just the root', chromModel.keyLabel, 'A');
eq('chromatic chords-used dedups, first-seen order', chromModel.allChords.map((c) => c.name).join(' '), 'Am G F');
eq('chromatic bVI triad notes in A', chromModel.sections[0].chords[2].notes.join(','), 'F,A,C');

// Power chords are thirdless (root + fifth only) — the honest rhythm-tab shape.
const powerModel = deriveOutput(stateOf('E', 'natural', 'minor', 'wf-power'), tfById);
eq('power-chord names in E', powerModel.sections[0].chords.map((c) => c.name).join(' '), 'E5 G5 A5 E5');
ok('power chords are thirdless (2 notes)', powerModel.sections[0].chords.every((c) => c.notes.length === 2));
eq('power I5 notes in E', powerModel.sections[0].chords[0].notes.join(','), 'E,B');

// Sevenths (dom vs min by case) and a borrowed bII.
eq('sevenths + bII in C', tokenMain('C', 'natural', 'major', 'wf-7'), 'C G7 Dm7 D♭');
eq('V7 is a dominant seventh (4 notes)', deriveOutput(stateOf('C', 'natural', 'major', 'wf-7'), tfById).sections[0].chords[1].notes.join(','), 'G,B,D,F');

// Schema acceptance / rejection for the token shape.
ok('schema accepts a token feel', validateFeel({ id: 'x', name: 'X', progression: ['I', 'bVII'], schemaVersion: 2 }).ok);
ok('schema accepts schemaVersion 2', validateFeel({ id: 'x', name: 'X', progression: ['I'], schemaVersion: 2 }).ok);
ok('schema rejects a malformed token', !validateFeel({ id: 'x', name: 'X', progression: ['H9'] }).ok);
ok('schema rejects degrees AND progression together', !validateFeel({ id: 'x', name: 'X', degrees: [0], progression: ['I'] }).ok);
ok('schema rejects neither degrees nor progression', !validateFeel({ id: 'x', name: 'X' }).ok);
ok('schema rejects an empty progression', !validateFeel({ id: 'x', name: 'X', progression: [] }).ok);

// ============================================================================
// 10. Sectioned (labeled-block) feels — Main / Bridge, schemaVersion 3
// ============================================================================
const tfSpec = normalizeFeel({
  id: 'wf-sectioned', name: 'WF Sectioned', schemaVersion: 3,
  sections: [
    { label: 'Main', progression: ['I', 'vi', 'IV', 'V'] },
    { label: 'Bridge', progression: ['III7', 'VI7', 'II7', 'V7'] },
  ],
});
const sById = { ...feelsById, [tfSpec.id]: tfSpec };
const sModel = deriveOutput(stateOf('C', 'natural', 'major', 'wf-sectioned'), sById);
ok('sectioned feel is chromatic', sModel.chromatic === true);
ok('sectioned feel yields one section per block, no alternatives', sModel.sections.length === 2);
eq('sectioned section roles', sModel.sections.map((s) => s.role).join(','), 'main,section');
eq('sectioned section titles are the labels', sModel.sections.map((s) => s.title).join(','), 'Main,Bridge');
eq('sectioned Main in C', sModel.sections[0].chords.map((c) => c.name).join(' '), 'C Am F G');
eq('sectioned Bridge in C (secondary dominants)', sModel.sections[1].chords.map((c) => c.name).join(' '), 'E7 A7 D7 G7');
eq('sectioned chords-used pools both blocks, deduped', sModel.allChords.map((c) => c.name).join(' '), 'C Am F G E7 A7 D7 G7');
// transposes as a unit, key-correct spelling
eq('sectioned Main in E', deriveOutput(stateOf('E', 'natural', 'major', 'wf-sectioned'), sById).sections[0].chords.map((c) => c.name).join(' '), 'E C♯m A B');
// schema acceptance / rejection for the sectioned shape
ok('schema accepts a sectioned feel', validateFeel({ id: 'x', name: 'X', schemaVersion: 3, sections: [{ label: 'Main', progression: ['I', 'V'] }] }).ok);
ok('schema rejects a section without a label', !validateFeel({ id: 'x', name: 'X', sections: [{ progression: ['I'] }] }).ok);
ok('schema rejects a section with a bad token', !validateFeel({ id: 'x', name: 'X', sections: [{ label: 'M', progression: ['H9'] }] }).ok);
ok('schema rejects an empty sections array', !validateFeel({ id: 'x', name: 'X', sections: [] }).ok);
ok('schema rejects sections AND progression together', !validateFeel({ id: 'x', name: 'X', progression: ['I'], sections: [{ label: 'M', progression: ['I'] }] }).ok);
ok('schema rejects a section with an unknown property', !validateFeel({ id: 'x', name: 'X', sections: [{ label: 'M', progression: ['I'], bogus: 1 }] }).ok);
ok('schema accepts schemaVersion 3', validateFeel({ id: 'x', name: 'X', schemaVersion: 3, sections: [{ label: 'M', progression: ['I'] }] }).ok);

// The renamed built-ins resolve and the new sectioned built-in validates.
ok('doo-wop built-in present + valid', !!feelsById['doo-wop'] && validateFeel(readJSON('./feels/doo-wop.json')).ok);
ok('spector-girl-groups built-in present + valid', !!feelsById['spector-girl-groups'] && validateFeel(readJSON('./feels/spector-girl-groups.json')).ok);
ok('old creepy ids are gone', !feelsById['creepy'] && !feelsById['creepy2']);

// ============================================================================
// 11. Songs — record validation, untitled numbering, snapshot capture, transforms
// ============================================================================
const goodSong = {
  schemaVersion: 1, id: 'my-song', name: 'My Song', createdAt: 't', updatedAt: 't', lyrics: 'la la',
  progressions: [{
    label: 'Verse', title: 'Main Progression',
    chords: [{ name: 'C', notes: ['C', 'E', 'G'] }, { name: 'G', notes: ['G', 'B', 'D'] }],
    provenance: { feelId: 'cliche', feelName: 'Cliché', root: 'C', accidental: 'natural', mode: 'major', chromatic: false, keyLabel: 'C major', role: 'main' },
  }],
};
ok('validateSong accepts a good song', validateSong(goodSong).ok);
ok('validateSong accepts a minimal song', validateSong({ id: 's', name: 'S', progressions: [{ chords: [{ name: 'C', notes: ['C'] }] }] }).ok);
ok('validateSong accepts a chromatic snapshot', validateSong({ id: 's2', name: 'S2', progressions: [{ label: 'Bridge', title: 'Bridge', chords: [{ name: 'E7', notes: ['E', 'G♯', 'B', 'D'] }], provenance: { feelId: 'x', feelName: 'X', root: 'C', accidental: 'natural', mode: 'major', chromatic: true, keyLabel: 'C', role: 'section' } }] }).ok);
ok('validateSong rejects missing name', !validateSong({ id: 'x', progressions: [{ chords: [{ name: 'C', notes: ['C'] }] }] }).ok);
ok('validateSong rejects empty progressions', !validateSong({ id: 'x', name: 'X', progressions: [] }).ok);
ok('validateSong rejects non-array progressions', !validateSong({ id: 'x', name: 'X', progressions: 'nope' }).ok);
ok('validateSong rejects a chord without notes', !validateSong({ id: 'x', name: 'X', progressions: [{ chords: [{ name: 'C' }] }] }).ok);
ok('validateSong rejects empty chords', !validateSong({ id: 'x', name: 'X', progressions: [{ chords: [] }] }).ok);
ok('validateSong rejects a non-preset label', !validateSong({ id: 'x', name: 'X', progressions: [{ label: 'Refrain', chords: [{ name: 'C', notes: ['C'] }] }] }).ok);
ok('validateSong rejects schemaVersion 2', !validateSong({ id: 'x', name: 'X', schemaVersion: 2, progressions: [{ chords: [{ name: 'C', notes: ['C'] }] }] }).ok);
ok('validateSong rejects a bad id slug', !validateSong({ id: 'Bad ID', name: 'X', progressions: [{ chords: [{ name: 'C', notes: ['C'] }] }] }).ok);
ok('validateSong rejects an extra chord property', !validateSong({ id: 'x', name: 'X', progressions: [{ chords: [{ name: 'C', notes: ['C'], bogus: 1 }] }] }).ok);
ok('validateSong rejects non-boolean provenance.chromatic', !validateSong({ id: 'x', name: 'X', progressions: [{ chords: [{ name: 'C', notes: ['C'] }], provenance: { chromatic: 'yes' } }] }).ok);
// forward-compatible: unknown top-level keys tolerated, but normalize strips them
ok('validateSong tolerates an unknown top-level key', validateSong({ ...goodSong, tempo: 120 }).ok);
ok('normalizeSong strips unknown keys', !('tempo' in normalizeSong({ ...goodSong, tempo: 120 })));

eq('nextUntitledName empty', nextUntitledName([]), 'untitled000');
eq('nextUntitledName increments', nextUntitledName(['untitled000']), 'untitled001');
eq('nextUntitledName fills the lowest gap', nextUntitledName(['untitled000', 'untitled002']), 'untitled001');
eq('nextUntitledName ignores non-matching names', nextUntitledName(['My Song', 'demo']), 'untitled000');

eq('slugifySongId basic', slugifySongId('My Song!', []), 'my-song');
eq('slugifySongId suffixes a collision', slugifySongId('My Song', ['my-song']), 'my-song-2');
eq('slugifySongId empty falls back', slugifySongId('', []), 'song');

// buildCapturedProgression — diatonic main snapshot
const capModel = deriveOutput(stateOf('C', 'natural', 'major', 'cliche'), feelsById);
const capMain = buildCapturedProgression(stateOf('C', 'natural', 'major', 'cliche'), capModel, capModel.sections.find((s) => s.role === 'main'));
eq('capture title', capMain.title, 'Main Progression');
ok('capture chords are name+notes only', capMain.chords.every((c) => Object.keys(c).sort().join(',') === 'name,notes'));
eq('capture provenance feelId', capMain.provenance.feelId, 'cliche');
ok('capture provenance chromatic false', capMain.provenance.chromatic === false);
eq('capture provenance keyLabel', capMain.provenance.keyLabel, 'C major');
eq('capture provenance role', capMain.provenance.role, 'main');
eq('capture label empty', capMain.label, '');
ok('a captured snapshot validates inside a song', validateSong({ id: 'cap', name: 'Cap', progressions: [capMain] }).ok);

// buildCapturedProgression — sectioned bridge snapshot (chromatic)
const secModel = deriveOutput(stateOf('C', 'natural', 'major', 'wf-sectioned'), sById);
const capBridge = buildCapturedProgression(stateOf('C', 'natural', 'major', 'wf-sectioned'), secModel, secModel.sections[1]);
ok('capture sectioned chromatic true', capBridge.provenance.chromatic === true);
eq('capture sectioned role', capBridge.provenance.role, 'section');
eq('capture sectioned keyLabel', capBridge.provenance.keyLabel, 'C');
eq('capture sectioned title', capBridge.title, 'Bridge');

// immutable transforms (a fixed injected `now`)
const draft = appendProgressions(createSong('t0'), [capMain, capBridge], 't1');
eq('createSong+append length', draft.progressions.length, 2);
eq('createSong schemaVersion', draft.schemaVersion, 1);
eq('createSong empty id (draft)', draft.id, '');
const reordered = reorderProgression(draft, 0, 1, 't2');
eq('reorder swaps order', reordered.progressions[0].title, 'Bridge');
ok('reorder is immutable', draft.progressions[0].title === 'Main Progression');
eq('reorder bumps updatedAt', reordered.updatedAt, 't2');
ok('reorder no-op at boundary', reorderProgression(draft, 0, -1, 't2') === draft);
eq('remove drops one', removeProgression(draft, 0, 't3').progressions.length, 1);
eq('setLabel applies a preset', setProgressionLabel(draft, 0, 'Chorus', 't4').progressions[0].label, 'Chorus');
eq('setLabel rejects non-preset -> empty', setProgressionLabel(draft, 0, 'Nope', 't4').progressions[0].label, '');
eq('setLyrics applies', setLyrics(draft, 'words', 't5').lyrics, 'words');
const finalized = finalizeDraft(draft, 'My Song', [], 't6');
eq('finalizeDraft assigns id', finalized.id, 'my-song');
eq('finalizeDraft sets name', finalized.name, 'My Song');
const renamed = renameSong(finalized, 'New Name', 't7');
eq('renameSong keeps id stable', renamed.id, 'my-song');
eq('renameSong changes name', renamed.name, 'New Name');
ok('finalized song round-trips through validateSong', validateSong(finalized).ok);

// ============================================================================
// 12. Hand-editing: chord builder, 12-tone picker, and row/chord transforms
// ============================================================================
const chordStr = (c) => c.name + ': ' + c.notes.join(' ');
eq('C major from root+quality', chordStr(chordFromRootAndQuality({ letter: 0, acc: 0 }, 'maj')), 'C: C E G');
eq('C minor from root+quality', chordStr(chordFromRootAndQuality({ letter: 0, acc: 0 }, 'min')), 'Cm: C E♭ G');
ok('chordFromRootAndQuality returns null on a bad quality', chordFromRootAndQuality({ letter: 0, acc: 0 }, 'nope') === null);
eq('CHROMATIC_TONES has 12 tones', CHROMATIC_TONES.length, 12);

// The black-key spelling rule: flat root for major, sharp root for minor (no doubles).
const tone = (label) => CHROMATIC_TONES.find((t) => t.label === label);
eq('E♭ major uses the flat root', chordStr(chordForTone(tone('D♯ / E♭'), 'maj')), 'E♭: E♭ G B♭');
eq('C♯ minor uses the sharp root', chordStr(chordForTone(tone('C♯ / D♭'), 'min')), 'C♯m: C♯ E G♯');
eq('A♭ major uses the flat root', chordStr(chordForTone(tone('G♯ / A♭'), 'maj')), 'A♭: A♭ C E♭');
eq('G♯ minor uses the sharp root', chordStr(chordForTone(tone('G♯ / A♭'), 'min')), 'G♯m: G♯ B D♯');
eq('a natural tone is unaffected by the rule', chordStr(chordForTone(tone('G'), 'maj')), 'G: G B D');

// Row/chord transforms — immutable and invariant-preserving (rows never empty).
const cMaj = chordFromRootAndQuality({ letter: 0, acc: 0 }, 'maj');
const withRow = appendRow(createSong('t0'), cMaj, 't1');
eq('appendRow adds a seeded row', withRow.progressions.length, 1);
eq('appendRow seeds C major', withRow.progressions[0].chords[0].name, 'C');
ok('appendRow stores name+notes only', Object.keys(withRow.progressions[0].chords[0]).sort().join(',') === 'name,notes');
const twoRows = appendRow(withRow, cMaj, 't2');
const added = addChord(twoRows, 0, chordFromRootAndQuality({ letter: 4, acc: 0 }, 'maj'), 't3');
eq('addChord appends to the row', added.progressions[0].chords.map((c) => c.name).join(' '), 'C G');
ok('addChord is immutable', twoRows.progressions[0].chords.length === 1);
const setted = setChord(added, 0, 1, chordFromRootAndQuality({ letter: 5, acc: 0 }, 'min'), 't4');
eq('setChord replaces chord j', setted.progressions[0].chords.map((c) => c.name).join(' '), 'C Am');
const rmChord = removeChord(setted, 0, 1, 't5');
eq('removeChord drops one chord, row keeps the rest', rmChord.progressions[0].chords.map((c) => c.name).join(' '), 'C');
ok('removeChord is immutable', setted.progressions[0].chords.length === 2);
const rmRow = removeChord(rmChord, 0, 0, 't6'); // row 0 has one chord left, but 2 rows exist -> drop the row
eq('removeChord on a row\'s last chord drops the row', rmRow.progressions.length, 1);
const soleSong = appendRow(createSong('t0'), cMaj, 't1');
ok('removeChord no-ops on the last chord of the only row', removeChord(soleSong, 0, 0, 't2') === soleSong);
ok('a hand-built song passes validateSong', validateSong(finalizeDraft(added, 'Hand Built', [], 't7')).ok);

// ============================================================================
// 13. Sketches (pure) — format acceptance, metadata, and song sketch transforms
// ============================================================================
// isAcceptedAudio: only .m4a, extension-authoritative, case-insensitive.
ok('isAcceptedAudio accepts .m4a', isAcceptedAudio('idea.m4a', 'audio/mp4').ok);
ok('isAcceptedAudio accepts .M4A (case-insensitive)', isAcceptedAudio('IDEA.M4A', '').ok);
eq('isAcceptedAudio reports the format', isAcceptedAudio('idea.m4a', '').format, 'm4a');
ok('isAcceptedAudio rejects .mp3', !isAcceptedAudio('idea.mp3', 'audio/mpeg').ok);
ok('isAcceptedAudio rejects .wav', !isAcceptedAudio('idea.wav', 'audio/wav').ok);
ok('isAcceptedAudio rejects .flac', !isAcceptedAudio('idea.flac', 'audio/flac').ok);
ok('isAcceptedAudio rejects no extension', !isAcceptedAudio('idea', '').ok);
ok('isAcceptedAudio error names m4a', /m4a/.test(isAcceptedAudio('x.ogg', '').error));

// makeSketchMeta: fields set, addedAt injected, notes empty.
const skMeta = makeSketchMeta({ id: 'sk1', filename: 'idea.m4a', mimeType: 'audio/mp4', size: 4096 }, 'T');
eq('makeSketchMeta id', skMeta.id, 'sk1');
eq('makeSketchMeta filename', skMeta.filename, 'idea.m4a');
eq('makeSketchMeta format', skMeta.format, 'm4a');
eq('makeSketchMeta size', skMeta.size, 4096);
eq('makeSketchMeta addedAt is the injected now', skMeta.addedAt, 'T');
eq('makeSketchMeta notes empty', skMeta.notes, '');

// validateSketchMeta.
ok('validateSketchMeta accepts a good record', validateSketchMeta(skMeta).ok);
ok('validateSketchMeta rejects a missing id', !validateSketchMeta({ filename: 'x.m4a', format: 'm4a' }).ok);
ok('validateSketchMeta rejects a missing filename', !validateSketchMeta({ id: 'a', format: 'm4a' }).ok);
ok('validateSketchMeta rejects a bad format', !validateSketchMeta({ id: 'a', filename: 'x', format: 'wav' }).ok);

// Song sketch transforms — immutable, updatedAt bumped, notes applied, remove by id.
const skSong0 = { ...goodSong, sketches: [] };
const skA = addSketchMeta(skSong0, skMeta, 'T1');
eq('addSketchMeta appends', skA.sketches.length, 1);
eq('addSketchMeta bumps updatedAt', skA.updatedAt, 'T1');
ok('addSketchMeta is immutable', skSong0.sketches.length === 0);
const skB = setSketchNotes(skA, 'sk1', 'beatbox verse', 'T2');
eq('setSketchNotes applies', skB.sketches[0].notes, 'beatbox verse');
eq('setSketchNotes bumps updatedAt', skB.updatedAt, 'T2');
ok('setSketchNotes is immutable', skA.sketches[0].notes === '');
ok('setSketchNotes no-ops on a missing id', setSketchNotes(skA, 'nope', 'x', 'T2') === skA);
const skC = removeSketchMeta(skB, 'sk1', 'T3');
eq('removeSketchMeta drops by id', skC.sketches.length, 0);
eq('removeSketchMeta bumps updatedAt', skC.updatedAt, 'T3');
ok('removeSketchMeta no-ops on a missing id', removeSketchMeta(skB, 'nope', 'T3') === skB);

// validateSong / normalizeSong with sketches (schemaVersion stays 1; additive field).
ok('validateSong accepts a song with a valid sketches[]', validateSong({ ...goodSong, sketches: [skMeta] }).ok);
ok('validateSong rejects a sketch with a bad format', !validateSong({ ...goodSong, sketches: [{ id: 'a', filename: 'x.m4a', format: 'wav' }] }).ok);
ok('validateSong rejects a non-array sketches', !validateSong({ ...goodSong, sketches: 'nope' }).ok);
ok('normalizeSong defaults missing sketches to []', normalizeSong(goodSong).sketches.length === 0);
eq('normalizeSong keeps schemaVersion 1', normalizeSong(goodSong).schemaVersion, 1);
const skNorm = normalizeSong({ ...goodSong, sketches: [{ ...skMeta, bogus: 1 }] });
ok('normalizeSong strips unknown sketch keys', !('bogus' in skNorm.sketches[0]));
eq('normalizeSong keeps the sketch id', skNorm.sketches[0].id, 'sk1');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
