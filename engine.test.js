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
  createSong, appendProgressions, reorderProgression, removeProgression, copyProgression,
  setProgressionLabel, setLyrics, renameSong, finalizeDraft,
  appendRow, addChord, setChord, removeChord,
} from './js/songs.js';
import {
  isAcceptedAudio, makeSketchMeta, validateSketchMeta,
  addSketchMeta, removeSketchMeta, setSketchNotes,
} from './js/sketches.js';
import { chordFromRootAndQuality, chordForTone, CHROMATIC_TONES } from './js/theory/roman.js';
import {
  validateTake, normalizeTake, validateManifest, normalizeManifest, createManifest,
  makeTake, appendTake, nextTakeNumber, appendPassTracks, finalizePass, finalizeRecoveredPass,
  discardTake, discardGroup, bounceTrackToTrack, markBounced, setStemSettings, mostRecentKeptTake,
  nextGroup, lastGroupSlotKeys, freeSlotKeys, filledSlotKeys, maxSlotDuration, takeHasAudio,
  slotHasAudio, defaultRouting, stemFileName, mixFileName, tapeDeckRef,
  defaultStemSettings, clampStemSettings, compressorParams, bounceGainDb,
  LUFS_TARGET, LUFS_FLOOR, BOUNCE_GAIN_DB_MIN, BOUNCE_GAIN_DB_MAX, LIMITER_CEILING_DB,
  STEM_KEYS, MAX_TRACKS, TAKE_STATUS,
} from './js/tape/takeModel.js';
import { wavHeader, floatToInt16, interleave, parseWav, SIZE_FIELDS } from './js/tape/wav.js';
import { integratedLoudness } from './js/tape/lufs.js';
import { limit } from './js/tape/limiter.js';

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
const copied = copyProgression(draft, 0, 't8');
eq('copy inserts a row', copied.progressions.length, 3);
eq('copy sits immediately below source', copied.progressions[1].title, draft.progressions[0].title);
eq('copy bumps updatedAt', copied.updatedAt, 't8');
ok('copy is immutable', draft.progressions.length === 2);
ok('copy deep-copies chords (new ref)', copied.progressions[1].chords !== draft.progressions[0].chords);
ok('copy deep-copies provenance (new ref, same data)',
   copied.progressions[1].provenance !== draft.progressions[0].provenance &&
   copied.progressions[1].provenance.keyLabel === draft.progressions[0].provenance.keyLabel);
ok('copy no-ops on a bad index', copyProgression(draft, 9, 't8') === draft);
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

// tapeDeck reference (additive, like sketches — schemaVersion stays 1).
ok('validateSong accepts a song with a good tapeDeck ref', validateSong({ ...goodSong, tapeDeck: { path: 'takes/my-song/' } }).ok);
ok('validateSong rejects a tapeDeck with an empty path', !validateSong({ ...goodSong, tapeDeck: { path: '' } }).ok);
ok('validateSong rejects a non-object tapeDeck', !validateSong({ ...goodSong, tapeDeck: 'nope' }).ok);
ok('normalizeSong preserves a present tapeDeck ref', normalizeSong({ ...goodSong, tapeDeck: { path: 'takes/my-song/' } }).tapeDeck.path === 'takes/my-song/');
ok('normalizeSong omits the tapeDeck key entirely when absent', !('tapeDeck' in normalizeSong(goodSong)));

// file link (additive, local-only — the .json a song is opened from / saved to; stays out
// of the export bundle; schemaVersion stays 1).
ok('validateSong accepts a song with a good file ref', validateSong({ ...goodSong, file: { name: 'My Song.json' } }).ok);
ok('validateSong rejects a file with an empty name', !validateSong({ ...goodSong, file: { name: '' } }).ok);
ok('validateSong rejects a non-object file', !validateSong({ ...goodSong, file: 'nope' }).ok);
ok('normalizeSong preserves a present file ref', normalizeSong({ ...goodSong, file: { name: 'My Song.json' } }).file.name === 'My Song.json');
ok('normalizeSong reduces file to { name } only', !('handle' in normalizeSong({ ...goodSong, file: { name: 'x.json', handle: 1 } }).file));
ok('normalizeSong omits the file key entirely when absent', !('file' in normalizeSong(goodSong)));

// ============================================================================
// 14. Tape deck (pure) — takeModel, wav, lufs, limiter
// ============================================================================

// ---- takeModel: constants ----
eq('STEM_KEYS', STEM_KEYS.join(','), 'stem1,stem2,stem3,stem4');
eq('MAX_TRACKS', MAX_TRACKS, 4);
eq('TAKE_STATUS', TAKE_STATUS.join(','), 'recording,active,discarded');
eq('LUFS_TARGET', LUFS_TARGET, -14);
eq('LUFS_FLOOR', LUFS_FLOOR, -50);
eq('BOUNCE_GAIN_DB_MIN', BOUNCE_GAIN_DB_MIN, -12);
eq('BOUNCE_GAIN_DB_MAX', BOUNCE_GAIN_DB_MAX, 20);
eq('LIMITER_CEILING_DB', LIMITER_CEILING_DB, -1);

// ---- takeModel: naming + ref helpers ----
eq('stemFileName stem1', stemFileName('blue-eyes', 3, 'stem1'), 'blue-eyes_3_stem1.wav');
eq('stemFileName stem4', stemFileName('blue-eyes', 3, 'stem4'), 'blue-eyes_3_stem4.wav');
eq('mixFileName', mixFileName('blue-eyes', 3), 'blue-eyes_3_mix.wav');
eq('tapeDeckRef path', tapeDeckRef('blue-eyes').path, 'takes/blue-eyes/');

// ---- takeModel: default input->slot routing ----
eq('defaultRouting caps at maxCapture', defaultRouting(['stem1', 'stem2', 'stem3', 'stem4'], 2).join(','), 'stem1,stem2');
eq('defaultRouting caps at free-slot count', defaultRouting(['stem3', 'stem4'], 4).join(','), 'stem3,stem4');
eq('defaultRouting empty when no free slots', defaultRouting([], 2).length, 0);

// ---- takeModel: effect settings ----
eq('defaultStemSettings vol', defaultStemSettings().vol, 1.0);
eq('defaultStemSettings comp', defaultStemSettings().comp, 0);
ok('defaultStemSettings eq flat', defaultStemSettings().eq.bass === 0 && defaultStemSettings().eq.mid === 0 && defaultStemSettings().eq.treble === 0);
eq('clampStemSettings clamps vol high', clampStemSettings({ vol: 99 }).vol, 1.5);
eq('clampStemSettings clamps vol low', clampStemSettings({ vol: -5 }).vol, 0);
eq('clampStemSettings clamps eq high', clampStemSettings({ eq: { bass: 99 } }).eq.bass, 12);
eq('clampStemSettings clamps eq low', clampStemSettings({ eq: { treble: -99 } }).eq.treble, -12);
eq('clampStemSettings clamps comp', clampStemSettings({ comp: 5 }).comp, 1);
eq('clampStemSettings defaults missing fields', JSON.stringify(clampStemSettings({})), JSON.stringify(defaultStemSettings()));

// compressorParams(0) MUST be the exact neutral/unity shape (D17) — not whatever
// the general formula naively evaluates to at c=0.
const cp0 = compressorParams(0);
ok('compressorParams(0) is neutral', cp0.threshold === 0 && cp0.ratio === 1 && cp0.knee === 0);
const cp1 = compressorParams(1);
ok('compressorParams(1) engages', cp1.threshold < 0 && cp1.ratio > 1 && cp1.makeupDb > 0);
ok('compressorParams(0.5) is between', compressorParams(0.5).threshold < 0 && compressorParams(0.5).ratio > 1 && compressorParams(0.5).ratio < cp1.ratio);

// ---- takeModel: the bounce gain rule (D25) ----
eq('bounceGainDb at target already', Math.round(bounceGainDb(-14) * 100) / 100, 0);
eq('bounceGainDb boosts a quiet take', Math.round(bounceGainDb(-24)), 10);
eq('bounceGainDb clamps a very quiet (but above-floor) take at the max', bounceGainDb(-40), BOUNCE_GAIN_DB_MAX); // raw would be +26 dB, clamped to +20
eq('bounceGainDb clamps a loud take at the min', bounceGainDb(10), BOUNCE_GAIN_DB_MIN);
eq('bounceGainDb skips (0 dB) below the floor', bounceGainDb(-60), 0);
eq('bounceGainDb skips (0 dB) on silence', bounceGainDb(-Infinity), 0);

// ---- takeModel: a take is a 4-track container filled over multiple passes ----
let man = createManifest('blue-eyes');
eq('createManifest starts empty', man.takes.length, 0);
eq('createManifest schemaVersion 2', man.schemaVersion, 2);
eq('nextTakeNumber on empty manifest', nextTakeNumber(man), 1);

// Take 1: an empty container, then a first pass arms two of its four slots (group 1).
const take1 = makeTake({ take: nextTakeNumber(man), sampleRate: 48000 }, 'T0');
man = appendTake(man, take1);
eq('makeTake status is recording', take1.status, 'recording');
eq('makeTake durationSec null while recording', take1.durationSec, null);
ok('makeTake starts with 4 empty slots', STEM_KEYS.every((k) => take1.stems[k] === null));
ok('a fresh container has no channels field', !('channels' in take1));

eq('nextGroup on an empty take is 1', nextGroup(man.takes[0]), 1);
man = appendPassTracks(man, 1, ['stem1', 'stem2'], 1);
ok('appendPassTracks names + stamps the pass slots', man.takes[0].stems.stem1.file === 'blue-eyes_1_stem1.wav' && man.takes[0].stems.stem1.group === 1 && man.takes[0].stems.stem1.durationSec === null);
ok('appendPassTracks leaves untargeted slots free', man.takes[0].stems.stem3 === null && man.takes[0].stems.stem4 === null);
eq('freeSlotKeys after arming pass 1', freeSlotKeys(man.takes[0]).join(','), 'stem3,stem4');

// Clean stop of the pass: per-slot durations, take length = max, status active.
man = finalizePass(man, 1, { stem1: 12.5, stem2: 10.0 });
eq('finalizePass sets active', man.takes[0].status, 'active');
eq('finalizePass per-slot duration', man.takes[0].stems.stem1.durationSec, 12.5);
eq('finalizePass take duration = max filled slot', man.takes[0].durationSec, 12.5);
eq('filledSlotKeys after pass 1', filledSlotKeys(man.takes[0]).join(','), 'stem1,stem2');
eq('maxSlotDuration', maxSlotDuration(man.takes[0]), 12.5);
ok('takeHasAudio true after a pass', takeHasAudio(man.takes[0]) === true);

// Overdub pass 2 into the two remaining free slots (group 2, on the same take).
eq('nextGroup after pass 1 is 2', nextGroup(man.takes[0]), 2);
man = appendPassTracks(man, 1, defaultRouting(freeSlotKeys(man.takes[0]), 2), 2);
ok('pass 2 arms stem3+stem4 at group 2', man.takes[0].stems.stem3.group === 2 && man.takes[0].stems.stem4.group === 2);
man = finalizePass(man, 1, { stem3: 8.0, stem4: 20.0 });
eq('take duration grows to the longest track', man.takes[0].durationSec, 20.0);
eq('filledSlotKeys after pass 2', filledSlotKeys(man.takes[0]).join(','), 'stem1,stem2,stem3,stem4');
eq('freeSlotKeys when full', freeSlotKeys(man.takes[0]).length, 0);

// lastGroupSlotKeys is the most recent pass only (retake acts on exactly these).
eq('lastGroupSlotKeys = the last pass', lastGroupSlotKeys(man.takes[0]).join(','), 'stem3,stem4');

// Retake→discard-last-group frees only that pass's slots, keeps the earlier group.
let dg = discardGroup(man, 1, 2);
eq('discardGroup frees the last group', freeSlotKeys(dg.takes[0]).join(','), 'stem3,stem4');
ok('discardGroup keeps group 1 intact', dg.takes[0].stems.stem1.file === 'blue-eyes_1_stem1.wav');
eq('discardGroup recomputes take duration', dg.takes[0].durationSec, 12.5);
ok('discardGroup keeps the take active', dg.takes[0].status === 'active');

// Ping-pong bounce: stem1 -> stem2. Source freed, dest neutral + new duration.
const preComp = setStemSettings(man, 1, 'stem2', { vol: 0.5, comp: 0.8 });
let pp = bounceTrackToTrack(preComp, 1, 'stem1', 'stem2', 13.0);
ok('bounceTrackToTrack frees the source slot', pp.takes[0].stems.stem1 === null);
ok('bounceTrackToTrack keeps the dest file', pp.takes[0].stems.stem2.file === 'blue-eyes_1_stem2.wav');
ok('bounceTrackToTrack resets dest settings to neutral', pp.takes[0].stems.stem2.vol === 1.0 && pp.takes[0].stems.stem2.comp === 0);
eq('bounceTrackToTrack sets dest duration', pp.takes[0].stems.stem2.durationSec, 13.0);
eq('bounceTrackToTrack frees a slot for recording', freeSlotKeys(pp.takes[0]).join(','), 'stem1');
// A group can span physically non-adjacent keys after a bounce-then-record — helpers key off stamps, never adjacency.
let pp2 = appendPassTracks(pp, 1, ['stem1'], nextGroup(pp.takes[0]));
eq('recording after ping-pong stamps a fresh group', pp2.takes[0].stems.stem1.group, 3);

// A discarded number is never reused.
eq('nextTakeNumber after take 1', nextTakeNumber(man), 2);
const take2 = makeTake({ take: nextTakeNumber(man), sampleRate: 48000 }, 'T1');
man = appendTake(man, take2);
man = appendPassTracks(man, 2, ['stem1'], 1);
man = discardTake(man, 2);
eq('discardTake sets discarded (tombstone)', man.takes[1].status, 'discarded');
ok('discardTake nulls every slot file field', STEM_KEYS.every((k) => !man.takes[1].stems[k] || man.takes[1].stems[k].file === null));
eq('nextTakeNumber never reuses a discarded number', nextTakeNumber(man), 3);

// A take that died mid-record still occupies its number; crash recovery per slot.
const take3 = makeTake({ take: nextTakeNumber(man), sampleRate: 48000 }, 'T2');
man = appendTake(man, take3);
man = appendPassTracks(man, 3, ['stem1', 'stem2'], 1);
eq('nextTakeNumber counts a "recording" take too', nextTakeNumber(man), 4);

// crash recovery: nonzero bytes -> finalize that slot; zero bytes -> free that slot.
const recovered = finalizeRecoveredPass(man, 3, { stem1: 48000 * 2 * 5, stem2: 0 }, 48000); // stem1 5s, stem2 empty
const rt = recovered.takes.find((t) => t.take === 3);
ok('finalizeRecoveredPass marks active+recovered', rt.status === 'active' && rt.recovered === true);
eq('finalizeRecoveredPass finalizes the nonempty slot', rt.stems.stem1.durationSec, 5);
ok('finalizeRecoveredPass frees the empty pending slot', rt.stems.stem2 === null);
// a pass where every slot captured nothing tombstones the whole (empty) take
const empties = finalizeRecoveredPass(man, 3, { stem1: 0, stem2: 0 }, 48000);
eq('finalizeRecoveredPass tombstones an all-empty pass', empties.takes.find((t) => t.take === 3).status, 'discarded');

eq('mostRecentKeptTake picks the highest active take with audio', mostRecentKeptTake(man).take, 1);
ok('mostRecentKeptTake is null with no active takes', mostRecentKeptTake(createManifest('x')) === null);
// An emptied (all-discarded-group) active container is not auto-loaded.
const emptiedActive = { schemaVersion: 2, slug: 'x', takes: [{ take: 1, status: 'active', recovered: false, createdAt: 'T', durationSec: null, sampleRate: 48000, stems: { stem1: null, stem2: null, stem3: null, stem4: null }, bounce: null }] };
ok('mostRecentKeptTake skips an active container with no audio', mostRecentKeptTake(emptiedActive) === null);

const bouncedMan = markBounced(man, 1, { file: 'blue-eyes_1_mix.wav', bouncedAt: 'T3', lufs: -14.1 });
eq('markBounced sets the bounce record', bouncedMan.takes[0].bounce.file, 'blue-eyes_1_mix.wav');

// setStemSettings preserves the slot's group + durationSec (regression: earlier code dropped them).
const settingsMan = setStemSettings(man, 1, 'stem1', { vol: 0.5, eq: { bass: 3 } });
const s1 = settingsMan.takes[0].stems.stem1;
ok('setStemSettings merges + clamps, keeps the file name', s1.vol === 0.5 && s1.eq.bass === 3 && s1.eq.mid === 0 && s1.file === 'blue-eyes_1_stem1.wav');
ok('setStemSettings preserves group + durationSec', s1.group === 1 && s1.durationSec === 12.5);
// A free (null) slot must stay null — never resurrected as a {file:undefined,...} object.
eq('setStemSettings no-ops on a free slot', setStemSettings(man, 3, 'stem3', { vol: 0.9 }).takes.find((t) => t.take === 3).stems.stem3, null);

// ---- takeModel: validate/normalize ----
ok('validateManifest accepts a well-formed manifest', validateManifest(man).ok);
ok('validateManifest rejects a bad slug', !validateManifest({ slug: '', takes: [] }).ok);
ok('validateManifest rejects a non-array takes', !validateManifest({ slug: 'x', takes: 'nope' }).ok);
ok('validateTake rejects an empty object', !validateTake({}).ok);
ok('validateTake accepts a normalized take', validateTake(normalizeTake(take1)).ok);
ok('normalizeManifest emits schemaVersion 2', normalizeManifest({ slug: 'x', takes: [] }).schemaVersion === 2);
ok('normalizeTake defaults a missing status to discarded', normalizeTake({ take: 1 }).status === 'discarded');

// ---- takeModel: v1 -> v2 migration (real on-device takes must survive) ----
const v1Stereo = {
  schemaVersion: 1, slug: 'blue-eyes', takes: [
    { take: 1, status: 'active', recovered: false, createdAt: 'T', durationSec: 12.5, sampleRate: 48000, channels: 2, capturedWithoutInterface: false,
      stems: { stem1: { file: 'blue-eyes_1_stem1.wav', vol: 1, eq: { bass: 3, mid: 0, treble: -2 }, comp: 0.2 },
               stem2: { file: 'blue-eyes_1_stem2.wav', vol: 0.8, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 } },
      bounce: { file: 'blue-eyes_1_mix.wav', bouncedAt: 'T2', lufs: -14.1 } },
  ],
};
ok('validateManifest accepts a raw v1 manifest', validateManifest(v1Stereo).ok);
const migrated = normalizeManifest(v1Stereo);
const mt = migrated.takes[0];
eq('migration stamps schemaVersion 2', migrated.schemaVersion, 2);
ok('migration keeps stem1/stem2 filenames (WAVs still resolve)', mt.stems.stem1.file === 'blue-eyes_1_stem1.wav' && mt.stems.stem2.file === 'blue-eyes_1_stem2.wav');
ok('migration stamps group 1', mt.stems.stem1.group === 1 && mt.stems.stem2.group === 1);
ok('migration sets per-slot durationSec from the take duration', mt.stems.stem1.durationSec === 12.5 && mt.stems.stem2.durationSec === 12.5);
ok('migration opens stem3/stem4 as free slots', mt.stems.stem3 === null && mt.stems.stem4 === null);
ok('migration preserves the effect settings', mt.stems.stem1.eq.bass === 3 && mt.stems.stem1.comp === 0.2 && mt.stems.stem2.vol === 0.8);
ok('migration drops the legacy channels field', !('channels' in mt));
ok('migration is idempotent (re-normalize is stable)', JSON.stringify(normalizeManifest(migrated)) === JSON.stringify(migrated));
eq('a migrated 2-track take opens as a partial 4-track take', freeSlotKeys(mt).join(','), 'stem3,stem4');
// A mono v1 take -> stem1 only, stem2 stays null.
const v1Mono = { schemaVersion: 1, slug: 's', takes: [{ take: 1, status: 'active', recovered: false, createdAt: 'T', durationSec: 6, sampleRate: 48000, channels: 1, stems: { stem1: { file: 's_1_stem1.wav', vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 }, stem2: null }, bounce: null }] };
const mm = normalizeManifest(v1Mono).takes[0];
ok('mono v1 migrates stem1 only', mm.stems.stem1.file === 's_1_stem1.wav' && mm.stems.stem1.group === 1 && mm.stems.stem2 === null);

// ============================================================================
// 15. Tape deck (pure) — wav.js
// ============================================================================
eq('SIZE_FIELDS shape', JSON.stringify(SIZE_FIELDS), JSON.stringify([{ offset: 4, bias: 36 }, { offset: 40, bias: 0 }]));

const hdr = new DataView(wavHeader(2, 48000, 1000));
eq('wavHeader RIFF magic', String.fromCharCode(hdr.getUint8(0), hdr.getUint8(1), hdr.getUint8(2), hdr.getUint8(3)), 'RIFF');
eq('wavHeader WAVE magic', String.fromCharCode(hdr.getUint8(8), hdr.getUint8(9), hdr.getUint8(10), hdr.getUint8(11)), 'WAVE');
eq('wavHeader ChunkSize = dataBytes + 36', hdr.getUint32(4, true), 1036);
eq('wavHeader NumChannels', hdr.getUint16(22, true), 2);
eq('wavHeader SampleRate', hdr.getUint32(24, true), 48000);
eq('wavHeader ByteRate', hdr.getUint32(28, true), 48000 * 2 * 2);
eq('wavHeader BlockAlign', hdr.getUint16(32, true), 4);
eq('wavHeader BitsPerSample', hdr.getUint16(34, true), 16);
eq('wavHeader data magic', String.fromCharCode(hdr.getUint8(36), hdr.getUint8(37), hdr.getUint8(38), hdr.getUint8(39)), 'data');
eq('wavHeader Subchunk2Size = dataBytes', hdr.getUint32(40, true), 1000);

eq('floatToInt16 clamps +1.5 -> 32767', floatToInt16(new Float32Array([1.5]))[0], 0x7fff);
eq('floatToInt16 clamps -2 -> -32768', floatToInt16(new Float32Array([-2]))[0], -0x8000);
eq('floatToInt16 zero', floatToInt16(new Float32Array([0]))[0], 0);
eq('floatToInt16 asymmetric scale +1', floatToInt16(new Float32Array([1]))[0], 0x7fff);
eq('floatToInt16 asymmetric scale -1', floatToInt16(new Float32Array([-1]))[0], -0x8000);

const chL = new Float32Array([1, 2, 3]);
const chR = new Float32Array([10, 20, 30]);
eq('interleave stereo', Array.from(interleave([chL, chR])).join(','), '1,10,2,20,3,30');
eq('interleave mono is a no-op', interleave([chL]), chL);

// encode -> parseWav round-trip
function makeSine(freq, amp, seconds, rate) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}
const srcL = makeSine(440, 0.5, 0.01, 48000);
const srcR = makeSine(660, 0.3, 0.01, 48000);
const enc16 = floatToInt16(interleave([srcL, srcR]));
const encBytes = new Uint8Array(enc16.buffer);
const full = new Uint8Array(44 + encBytes.length);
full.set(new Uint8Array(wavHeader(2, 48000, encBytes.length)), 0);
full.set(encBytes, 44);
const parsed = parseWav(full);
eq('parseWav channels', parsed.channels, 2);
eq('parseWav rate', parsed.rate, 48000);
eq('parseWav frame count', parsed.samples[0].length, srcL.length);
let maxErrL = 0, maxErrR = 0;
for (let i = 0; i < srcL.length; i++) { maxErrL = Math.max(maxErrL, Math.abs(parsed.samples[0][i] - srcL[i])); maxErrR = Math.max(maxErrR, Math.abs(parsed.samples[1][i] - srcR[i])); }
ok('parseWav round-trips within one 16-bit quantization step (L)', maxErrL < 0.0001);
ok('parseWav round-trips within one 16-bit quantization step (R)', maxErrR < 0.0001);

let threwOnGarbage = false;
try { parseWav(new Uint8Array(100)); } catch { threwOnGarbage = true; }
ok('parseWav rejects a non-RIFF buffer', threwOnGarbage);

// ============================================================================
// 16. Tape deck (pure) — lufs.js
// ============================================================================
eq('integratedLoudness of silence is -Infinity', integratedLoudness([new Float32Array(48000)], 48000), -Infinity);
// Amplitude solved offline (binary search) for -14 LUFS at 1kHz mono, 48kHz.
const lufsTone = makeSine(1000, 0.28195637900229065, 1.0, 48000);
const measured = integratedLoudness([lufsTone], 48000);
ok('a synthesized -14 LUFS tone measures within 0.1 LU of -14', Math.abs(measured - (-14)) < 0.1);
// Louder tone measures louder; quieter measures quieter (monotonic sanity check).
const louder = integratedLoudness([makeSine(1000, 0.5, 1.0, 48000)], 48000);
const quieter = integratedLoudness([makeSine(1000, 0.1, 1.0, 48000)], 48000);
ok('louder tone measures higher LUFS', louder > measured);
ok('quieter tone measures lower LUFS', quieter < measured);

// ============================================================================
// 17. Tape deck (pure) — limiter.js
// ============================================================================
const ceilingLinear = Math.pow(10, LIMITER_CEILING_DB / 20);
const loudSine = [makeSine(1000, Math.pow(10, 3 / 20), 0.05, 48000)]; // +3 dBFS
limit(loudSine, 48000, LIMITER_CEILING_DB);
let peak = 0;
for (const v of loudSine[0]) peak = Math.max(peak, Math.abs(v));
ok('+3 dBFS sine comes out at or under the ceiling', peak <= ceilingLinear + 1e-6);

// Under-ceiling material passes through bit-identical, accounting for the fixed
// lookahead delay (a real delay line, not a zero-latency approximation).
const lookaheadSamples = Math.round(0.005 * 48000);
const quietSrc = makeSine(440, 0.1, 0.02, 48000);
const quietCopy = Float32Array.from(quietSrc);
limit([quietCopy], 48000, LIMITER_CEILING_DB);
let passthroughExact = true;
for (let i = 0; i < lookaheadSamples; i++) if (quietCopy[i] !== 0) passthroughExact = false;
for (let i = lookaheadSamples; i < quietSrc.length; i++) if (quietCopy[i] !== quietSrc[i - lookaheadSamples]) passthroughExact = false;
ok('under-ceiling material passes through bit-identical (delay-shifted)', passthroughExact);

// ============================================================================
// 18. Tape deck — sw.js caches every new module (tape/… asset-list assertion)
// ============================================================================
for (const f of ['tape/takeModel', 'tape/wav', 'tape/lufs', 'tape/limiter', 'tape/audioEngine', 'tape/takeStore', 'tape/opfsWorker', 'tape/captureProcessor', 'tape/devices', 'tape/tapeView']) {
  ok('sw.js caches ' + f + '.js', sw.includes(`"./js/${f}.js"`));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
