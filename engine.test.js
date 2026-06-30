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
  'Cliché 2': 'C Am Em Bdim', Creepy: 'C Am F G', 'Creepy 2': 'C Am Dm G',
  Endless: 'C Am Dm F', Energetic: 'C Em F Am', Grungy: 'C F Em Am',
  Memories: 'C F C G', Rebellious: 'F C F G', Sad: 'C F G G',
  Simple: 'C F', 'Simple 2': 'C G', 'Twelve Bar Blues': 'C C C C F F C C G F C G',
  Wistful: 'C C F Am',
};
const MAIN_A_MINOR = {
  Alternative: 'F Dm Am Em', Canon: 'Am Em F C Dm Am Dm Em', 'Cliché': 'Am Em F Dm',
  'Cliché 2': 'Am F C G', Creepy: 'Am F Dm Em', 'Creepy 2': 'Am F Bdim Em',
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
