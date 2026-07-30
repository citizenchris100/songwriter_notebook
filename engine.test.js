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
import vm from 'node:vm';
import { deriveOutput } from './js/derive.js';
import { scaleOf } from './js/theory/scale.js';
import { noteName } from './js/theory/pitch.js';
import { MODE_BY_ID } from './js/data/modes.js';
import { DEFAULT_STATE, validate, randomize, ROOTS, MODE_IDS } from './js/session.js';
import { validateFeel, normalizeFeel } from './js/feels.js';
import {
  validateSong, normalizeSong, nextUntitledName, slugifySongId, buildCapturedProgression,
  createSong, appendProgressions, reorderProgression, removeProgression, copyProgression,
  setProgressionLabel, setLyrics, renameSong, finalizeDraft, duplicateSong,
  appendRow, addChord, setChord, removeChord, toMarkdown,
  toSongFile, resolveOpenedTapeDeck,
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
  slotHasAudio, slotLoc, defaultRouting, stemFileName, mixFileName, tapeDeckRef, playbackCacheStale,
  pendingOpfsSlotKeys, takeIsSaved, migrateTakeSlots, revertSlotToOpfs, midiRef, referencedMidiFiles, setDrumMidiFile,
  loopsRef, referencedLoopFiles, setDrumSequence,
  projectTakesForJson, hydrateSavedTakes, tapeDeckWithTakes, activeAudioTakeCount, rekeyManifest,
  defaultStemSettings, clampStemSettings, compressorParams, bounceGainDb,
  LUFS_TARGET, LUFS_FLOOR, BOUNCE_GAIN_DB_MIN, BOUNCE_GAIN_DB_MAX, LIMITER_CEILING_DB,
  STEM_KEYS, MAX_TRACKS, TAKE_STATUS,
} from './js/tape/takeModel.js';
import { wavHeader, floatToInt16, interleave, parseWav, SIZE_FIELDS } from './js/tape/wav.js';
import { integratedLoudness } from './js/tape/lufs.js';
import { limit } from './js/tape/limiter.js';
import {
  detectClickSample, rttSeconds, median, summarizeTrials, isPlausibleRtt,
  PLAUSIBLE_RTT_MIN, PLAUSIBLE_RTT_MAX,
  estimateMonitorLatencySec, resolveMonitorLatencySec,
} from './js/tape/latency.js';
import {
  TIME_SIGS, SUBS, MIN_BPM, MAX_BPM, computeLevels, accentGroups,
  barSeconds, countInSeconds, barTicks, defaultAccentIndex, defaultClickConfig, clampClickConfig, lockClickEdit,
} from './js/tape/clickModel.js';
import {
  CLIP_THRESHOLD, METER_TOP_DB, METER_FLOOR_DB, FALL_DB_PER_SEC, CLIP_HOLD_MS,
  peakToSegments, peakToLit, decayPeak, clipState,
} from './js/tape/meterModel.js';
import {
  STEPS_PER_BAR, SWING_MAX, VOICES, VOICE_IDS, KIT_IDS, EFFECT_IDS, voiceForNote,
  stepSeconds, hitTime, cellOf, velocityFromMidi, quantizeTick, drumHitsUntil,
  defaultDrumConfig, clampDrumConfig, validateDrumConfig, toggleCell, setCellVelocity, setBars,
  smfToPattern, concatPatterns, MAX_FLAT_BARS, lockDrumEdit,
} from './js/tape/drumModel.js';
import { readVarLen, parseSMF, notesFromSMF } from './js/tape/midiParse.js';
import {
  RULESET_TYPES, validateRuleset, normalizeRuleset, realizeSequence,
  flattenRealizedSequence, sequenceBars,
} from './js/tape/rulesetModel.js';
import {
  LOOP_NAME_RE, isLoopName, loopNumber, sortLoopNames, validateLoopFolderNames,
} from './js/tape/loopFolder.js';

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

// duplicateSong (the "Dupe" feature) — fresh id/name/dates, deep-copied progressions, remapped
// sketch ids, no tapeDeck (the impure caller attaches a rekeyed one).
const dupSong = duplicateSong(finalized, { id: 'my-song-2', name: 'My Song copy', now: 't9' });
eq('duplicateSong sets the new id', dupSong.id, 'my-song-2');
eq('duplicateSong sets the new name', dupSong.name, 'My Song copy');
eq('duplicateSong stamps createdAt = now', dupSong.createdAt, 't9');
eq('duplicateSong stamps updatedAt = now', dupSong.updatedAt, 't9');
eq('duplicateSong links the copy .json filename', dupSong.file.name, 'my-song-2.json');
eq('duplicateSong copies every progression', dupSong.progressions.length, finalized.progressions.length);
ok('duplicateSong deep-copies chords (new ref)', dupSong.progressions[0].chords !== finalized.progressions[0].chords);
ok('duplicateSong carries no tapeDeck (attached impurely)', !('tapeDeck' in dupSong));
ok('a duplicated song round-trips through validateSong', validateSong(dupSong).ok);
ok('duplicateSong is immutable (source name unchanged)', finalized.name === 'My Song');
// Sketch remap: keep only sketches the caller copied a blob for (present in sketchIdMap).
const srcSk = { ...finalized, sketches: [
  { id: 'sk-old-1', filename: 'a.m4a', mimeType: 'audio/mp4', format: 'm4a', size: 1, addedAt: 't0', notes: '' },
  { id: 'sk-old-2', filename: 'b.m4a', mimeType: 'audio/mp4', format: 'm4a', size: 1, addedAt: 't0', notes: '' },
] };
const dupSk = duplicateSong(srcSk, { id: 'my-song-3', name: 'X', now: 't9', sketchIdMap: { 'sk-old-1': 'sk-new-1' } });
eq('duplicateSong keeps only mapped sketches', dupSk.sketches.length, 1);
eq('duplicateSong rekeys the sketch id', dupSk.sketches[0].id, 'sk-new-1');
ok('duplicateSong drops a sketch with no copied blob', !dupSk.sketches.some((s) => s.id === 'sk-old-2'));

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

// tapeDeck.takes — durable folder-saved take records embedded in the song (restore-on-open).
const savedTakeRec = { take: 2, status: 'active', recovered: false, createdAt: 'T', durationSec: 5, sampleRate: 48000,
  stems: { stem1: { file: 'my-song_2_stem1.wav', group: 1, durationSec: 5, loc: 'folder', vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 }, stem2: null, stem3: null, stem4: null },
  bounce: null };
ok('validateSong accepts a tapeDeck with saved take records', validateSong({ ...goodSong, tapeDeck: { path: 'takes/my-song/', schemaVersion: 2, takes: [savedTakeRec] } }).ok);
ok('validateSong rejects a non-array tapeDeck.takes', !validateSong({ ...goodSong, tapeDeck: { path: 'takes/my-song/', takes: 'nope' } }).ok);
// A malformed take entry must NOT fail the whole song (else loadSongs drops lyrics + progressions).
ok('validateSong does not fail the song over a malformed take entry', validateSong({ ...goodSong, tapeDeck: { path: 'takes/my-song/', takes: [{ take: 'bogus' }] } }).ok);
const tdNorm = normalizeSong({ ...goodSong, tapeDeck: { path: 'takes/my-song/', takes: [savedTakeRec, { take: 'bogus' }] } });
eq('normalizeSong drops invalid saved take entries, keeps valid ones', tdNorm.tapeDeck.takes.length, 1);
eq('normalizeSong keeps the saved take number', tdNorm.tapeDeck.takes[0].take, 2);
eq('normalizeSong keeps folder loc on a restored slot', tdNorm.tapeDeck.takes[0].stems.stem1.loc, 'folder');
eq('normalizeSong stamps tapeDeck.schemaVersion 2', tdNorm.tapeDeck.schemaVersion, 2);
ok('normalizeSong round-trips a bare { path } tapeDeck (back-compat, no takes key)', !('takes' in normalizeSong({ ...goodSong, tapeDeck: { path: 'takes/my-song/' } }).tapeDeck));

// file link (additive, local-only — the .json a song is opened from / saved to; stays out
// of the export bundle; schemaVersion stays 1).
ok('validateSong accepts a song with a good file ref', validateSong({ ...goodSong, file: { name: 'My Song.json' } }).ok);
ok('validateSong rejects a file with an empty name', !validateSong({ ...goodSong, file: { name: '' } }).ok);
ok('validateSong rejects a non-object file', !validateSong({ ...goodSong, file: 'nope' }).ok);
ok('normalizeSong preserves a present file ref', normalizeSong({ ...goodSong, file: { name: 'My Song.json' } }).file.name === 'My Song.json');
ok('normalizeSong reduces file to { name } only', !('handle' in normalizeSong({ ...goodSong, file: { name: 'x.json', handle: 1 } }).file));
ok('normalizeSong omits the file key entirely when absent', !('file' in normalizeSong(goodSong)));

// ---- toSongFile: the pure export-shaped song file. It is the single writer of the .json's
// metadata (the impure caller only adds the base64 `audio` map), and it MUST embed the durable
// tapeDeck.takes so the .json is the single source of truth for restore-on-open (the take AUDIO
// stays in the folder, referenced by filename). This is the guard for the dead-code bug where
// main.js's copy returned before the tapeDeck block, silently dropping takes from every .json. ----
const tdSongFile = { ...goodSong, tapeDeck: { path: 'takes/my-song/', schemaVersion: 2, takes: [savedTakeRec] } };
const sf = toSongFile(tdSongFile);
eq('toSongFile sets $schema', sf['$schema'], './song.schema.json');
eq('toSongFile stamps schemaVersion 1', sf.schemaVersion, 1);
eq('toSongFile carries id + name', sf.id + '/' + sf.name, 'my-song/My Song');
ok('toSongFile passes progressions through', sf.progressions.length === 1 && sf.progressions[0].chords[0].name === 'C');
ok('toSongFile passes sketches through', Array.isArray(sf.sketches));
// THE RED-PROVING VECTOR — tapeDeck.takes must survive into the .json.
ok('toSongFile embeds the tapeDeck', !!sf.tapeDeck && sf.tapeDeck.path === 'takes/my-song/');
eq('toSongFile stamps tapeDeck.schemaVersion 2', sf.tapeDeck.schemaVersion, 2);
eq('toSongFile round-trips the saved take records', sf.tapeDeck.takes.length, 1);
eq('toSongFile keeps the saved take number', sf.tapeDeck.takes[0].take, 2);
eq('toSongFile keeps the folder loc on a restored slot', sf.tapeDeck.takes[0].stems.stem1.loc, 'folder');
ok('toSongFile omits tapeDeck when the song has none', !('tapeDeck' in toSongFile(goodSong)));
ok('toSongFile never writes the local file link', !('file' in toSongFile({ ...goodSong, file: { name: 'x.json' } })));
ok('toSongFile normalizes a takeless tapeDeck path to takes:[]',
   JSON.stringify(toSongFile({ ...goodSong, tapeDeck: { path: 'takes/my-song/' } }).tapeDeck.takes) === '[]');

// projectTakesForJson is lossless for durable metadata: it spreads the whole take, so a take's
// click config and frozen drum pattern survive into the .json (see section 14's `proj` fixture).
// (asserted in section 14 next to projectTakesForJson, where p1 is in scope.)

// ---- resolveOpenedTapeDeck: opening a .json must NEVER destroy durable take records the file
// itself doesn't contain (the migration-safety invariant that prevents the localStorage wipe). ----
const ownTd = { path: 'takes/my-song/', schemaVersion: 2, takes: [savedTakeRec] };
const openIncomingTd = { ...goodSong, id: 'my-song', tapeDeck: ownTd };
const openIncomingNoTd = { ...goodSong, id: 'my-song' };
const openExistingTd = { ...goodSong, id: 'my-song', tapeDeck: ownTd };
ok('resolveOpenedTapeDeck keeps a matching incoming tapeDeck on a faithful open',
   resolveOpenedTapeDeck(openIncomingTd, undefined, 'open', false) === ownTd);
ok('resolveOpenedTapeDeck preserves EXISTING takes when the incoming .json has none (no wipe)',
   resolveOpenedTapeDeck(openIncomingNoTd, openExistingTd, 'open', false) === ownTd);
ok('resolveOpenedTapeDeck strips on a foreign import',
   resolveOpenedTapeDeck(openIncomingTd, openExistingTd, 'import', false) === undefined);
ok('resolveOpenedTapeDeck strips on an id reslug (dead refs)',
   resolveOpenedTapeDeck(openIncomingTd, undefined, 'open', true) === undefined);
ok('resolveOpenedTapeDeck drops a mismatched-path incoming tapeDeck when nothing durable exists',
   resolveOpenedTapeDeck({ ...goodSong, id: 'other', tapeDeck: ownTd }, undefined, 'open', false) === undefined);
ok('resolveOpenedTapeDeck yields undefined when neither side has takes',
   resolveOpenedTapeDeck(openIncomingNoTd, undefined, 'open', false) === undefined);
ok('resolveOpenedTapeDeck ignores an existing EMPTY takes array',
   resolveOpenedTapeDeck(openIncomingNoTd, { ...goodSong, tapeDeck: { path: 'takes/my-song/', takes: [] } }, 'open', false) === undefined);

// ---- toMarkdown: the pure Rich .md companion export (title, per-row headings, aligned
// chord table with spelled notes, Lyrics block). Date is sliced off updatedAt, never Date. ----
const mdSong = {
  schemaVersion: 1, id: 'my-song', name: 'My Song', createdAt: 't', updatedAt: '2026-07-24T10:00:00.000Z',
  lyrics: 'line one\nline two\n', progressions: [
    { label: 'Verse', title: 'Main Progression',
      chords: [{ name: 'F', notes: ['F', 'A', 'C'] }, { name: 'Dm7', notes: ['D', 'F', 'A', 'C'] }],
      provenance: { feelName: 'Jangle Pop', keyLabel: 'F major' } },
    { label: '', title: '', chords: [{ name: 'C', notes: ['C', 'E', 'G'] }] },
  ],
};
const md = toMarkdown(mdSong);
ok('toMarkdown starts with the song title', md.startsWith('# My Song\n'));
ok('toMarkdown includes the updated date line', md.includes('*Songwriter Notebook · updated 2026-07-24*'));
ok('toMarkdown heads a labeled row with its section + title/key/feel', md.includes('## Verse — Main Progression · F major · Jangle Pop'));
ok('toMarkdown labels an unlabeled row Section N', md.includes('## Section 2'));
ok('toMarkdown emits an aligned chord table header', md.includes('| Chord | Notes'));
ok('toMarkdown emits a chord row with spelled notes', md.includes('| F ') && md.includes('| F A C'));
ok('toMarkdown includes a Lyrics block with the lyrics', md.includes('## Lyrics') && md.includes('line one\nline two'));
ok('toMarkdown ends with exactly one trailing newline', md.endsWith('\n') && !md.endsWith('\n\n'));
ok('toMarkdown escapes a pipe in a chord name', toMarkdown({ name: 'P', progressions: [{ chords: [{ name: 'C|x', notes: ['C'] }] }] }).includes('C\\|x'));
eq('toMarkdown omits the Lyrics heading when lyrics are empty',
   toMarkdown({ name: 'X', updatedAt: '', progressions: [] }).includes('## Lyrics'), false);
eq('toMarkdown falls back to Untitled for a nameless song', toMarkdown({}).startsWith('# Untitled\n'), true);

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
ok('migration marks migrated slots loc opfs', mt.stems.stem1.loc === 'opfs' && mt.stems.stem2.loc === 'opfs');
ok('migration marks the migrated bounce loc opfs', mt.bounce.loc === 'opfs');
ok('migration is idempotent (re-normalize is stable)', JSON.stringify(normalizeManifest(migrated)) === JSON.stringify(migrated));
eq('a migrated 2-track take opens as a partial 4-track take', freeSlotKeys(mt).join(','), 'stem3,stem4');
// A mono v1 take -> stem1 only, stem2 stays null.
const v1Mono = { schemaVersion: 1, slug: 's', takes: [{ take: 1, status: 'active', recovered: false, createdAt: 'T', durationSec: 6, sampleRate: 48000, channels: 1, stems: { stem1: { file: 's_1_stem1.wav', vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 }, stem2: null }, bounce: null }] };
const mm = normalizeManifest(v1Mono).takes[0];
ok('mono v1 migrates stem1 only', mm.stems.stem1.file === 's_1_stem1.wav' && mm.stems.stem1.group === 1 && mm.stems.stem2 === null);

// ---- takeModel: folder-persistence loc model + Save-migration helpers ----
let locMan = appendTake(createManifest('blue-eyes'), makeTake({ take: 1, sampleRate: 48000 }, 'T'));
locMan = appendPassTracks(locMan, 1, ['stem1', 'stem2'], 1);
locMan = finalizePass(locMan, 1, { stem1: 10, stem2: 8 });
let locT = locMan.takes[0];
eq('a fresh recorded slot defaults loc opfs', slotLoc(locT.stems.stem1), 'opfs');
eq('pendingOpfsSlotKeys lists all fresh slots', pendingOpfsSlotKeys(locT).join(','), 'stem1,stem2');
ok('a fresh take is not yet saved', !takeIsSaved(locT));

locMan = migrateTakeSlots(locMan, 1, ['stem1'], {});
locT = locMan.takes[0];
eq('migrateTakeSlots flips only the named slot', slotLoc(locT.stems.stem1), 'folder');
eq('migrateTakeSlots leaves the others opfs', slotLoc(locT.stems.stem2), 'opfs');
eq('pendingOpfsSlotKeys shrinks after a partial migrate', pendingOpfsSlotKeys(locT).join(','), 'stem2');
ok('a partially-migrated take is still not saved', !takeIsSaved(locT));

locMan = migrateTakeSlots(locMan, 1, ['stem2'], {});
locT = locMan.takes[0];
ok('a take with all filled slots in the folder is saved', takeIsSaved(locT));
eq('no slots pending once saved', pendingOpfsSlotKeys(locT).length, 0);

// An overdub after Save lands as a fresh OPFS temp — the per-file split the whole design turns on.
locMan = appendPassTracks(locMan, 1, ['stem3'], nextGroup(locMan.takes[0]));
locMan = finalizePass(locMan, 1, { stem3: 9 });
locT = locMan.takes[0];
eq('an overdub after save is opfs while saved slots stay folder', slotLoc(locT.stems.stem3) + '/' + slotLoc(locT.stems.stem1), 'opfs/folder');
ok('an overdub makes the take unsaved again', !takeIsSaved(locT));
eq('only the overdub is pending', pendingOpfsSlotKeys(locT).join(','), 'stem3');

// A settings edit must NOT change a slot's location.
eq('setStemSettings preserves loc folder', slotLoc(setStemSettings(locMan, 1, 'stem1', { vol: 0.5 }).takes[0].stems.stem1), 'folder');
// revertSlotToOpfs flips a saved slot back (defensive; used after an in-place OPFS overwrite).
eq('revertSlotToOpfs flips folder back to opfs', slotLoc(revertSlotToOpfs(locMan, 1, ['stem1'], {}).takes[0].stems.stem1), 'opfs');

// Bounce loc: a fresh master bounce is opfs; migrate with {bounce:true} flips it.
let bMan = markBounced(locMan, 1, { file: mixFileName('blue-eyes', 1), bouncedAt: 'TB', lufs: -14, loc: 'opfs' });
eq('a fresh bounce is opfs', bMan.takes[0].bounce.loc, 'opfs');
bMan = migrateTakeSlots(bMan, 1, pendingOpfsSlotKeys(bMan.takes[0]), { bounce: true });
eq('migrate with {bounce:true} flips the bounce to folder', bMan.takes[0].bounce.loc, 'folder');

// normalize: default absent loc -> opfs, preserve folder, clamp garbage -> opfs.
const mkStem = (loc) => ({ file: 'x_1_stem1.wav', group: 1, durationSec: 5, ...(loc ? { loc } : {}), vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 });
const mkTake = (loc, bounceLoc) => ({ take: 1, status: 'active', createdAt: 'T', durationSec: 5, sampleRate: 48000, stems: { stem1: mkStem(loc), stem2: null, stem3: null, stem4: null }, bounce: bounceLoc ? { file: 'x_1_mix.wav', bouncedAt: 'T', lufs: -14, loc: bounceLoc } : null });
eq('normalizeStem defaults absent loc to opfs', normalizeTake(mkTake(null)).stems.stem1.loc, 'opfs');
eq('normalizeStem preserves loc folder', normalizeTake(mkTake('folder')).stems.stem1.loc, 'folder');
eq('normalizeStem clamps a garbage loc to opfs', normalizeTake(mkTake('bogus')).stems.stem1.loc, 'opfs');
ok('validateManifest rejects a bad slot loc', !validateManifest({ slug: 'x', takes: [mkTake('nope')] }).ok);
ok('validateManifest accepts loc folder + bounce loc opfs', validateManifest({ slug: 'x', takes: [mkTake('folder', 'opfs')] }).ok);

// ---- takeModel: durable song-embedded projection + hydrate (restore-on-open) ----
let projMan = createManifest('blue-eyes');
// take 1: fully saved — both slots + bounce migrated to the folder.
projMan = appendTake(projMan, makeTake({ take: 1, sampleRate: 48000 }, 'T'));
projMan = appendPassTracks(projMan, 1, ['stem1', 'stem2'], 1);
projMan = finalizePass(projMan, 1, { stem1: 10, stem2: 8 });
projMan = migrateTakeSlots(projMan, 1, ['stem1', 'stem2'], {});
projMan = markBounced(projMan, 1, { file: mixFileName('blue-eyes', 1), bouncedAt: 'TB', lufs: -14, loc: 'opfs' });
projMan = migrateTakeSlots(projMan, 1, [], { bounce: true });
// take 2: partial — stem1 saved to folder, stem2 left in OPFS (will be lost on reboot).
projMan = appendTake(projMan, makeTake({ take: 2, sampleRate: 48000 }, 'T'));
projMan = appendPassTracks(projMan, 2, ['stem1', 'stem2'], 1);
projMan = finalizePass(projMan, 2, { stem1: 12, stem2: 9 });
projMan = migrateTakeSlots(projMan, 2, ['stem1'], {});
// take 3: OPFS-only — never Saved, nothing durable to restore.
projMan = appendTake(projMan, makeTake({ take: 3, sampleRate: 48000 }, 'T'));
projMan = appendPassTracks(projMan, 3, ['stem1'], 1);
projMan = finalizePass(projMan, 3, { stem1: 5 });
// take 4: discarded tombstone.
projMan = appendTake(projMan, makeTake({ take: 4, sampleRate: 48000 }, 'T'));
projMan = appendPassTracks(projMan, 4, ['stem1'], 1);
projMan = finalizePass(projMan, 4, { stem1: 3 });
projMan = migrateTakeSlots(projMan, 4, ['stem1'], {});
projMan = discardTake(projMan, 4);

const proj = projectTakesForJson(projMan);
eq('projectTakesForJson keeps only takes with folder audio', proj.map((t) => t.take).join(','), '1,2');
const p1 = proj.find((t) => t.take === 1);
ok('projection keeps both folder slots of a fully-saved take', slotLoc(p1.stems.stem1) === 'folder' && slotLoc(p1.stems.stem2) === 'folder');
ok('projection keeps a folder bounce', !!(p1.bounce && p1.bounce.loc === 'folder'));
ok('a fully-saved projected take is not flagged recovered', p1.recovered === false);
// Losslessness guard: the projection spreads the whole take, so per-take click config and the
// frozen drum pattern survive into the .json — proving tapeDeck.takes is a COMPLETE durable
// record (what lets the .json be the single source of truth and the folder manifest be dropped).
ok('projectTakesForJson preserves per-take click config', 'click' in p1);
ok('projectTakesForJson preserves per-take drums config (the frozen pattern lives here)', 'drums' in p1);
const p2 = proj.find((t) => t.take === 2);
ok('projection keeps the folder slot of a partial take', slotLoc(p2.stems.stem1) === 'folder');
eq('projection nulls the opfs-only slot of a partial take', p2.stems.stem2, null);
ok('a partial projected take is flagged recovered', p2.recovered === true);
eq('projection recomputes durationSec from surviving slots', p2.durationSec, 12);
ok('projection drops an opfs-only take', !proj.some((t) => t.take === 3));
ok('projection drops a discarded take', !proj.some((t) => t.take === 4));

eq('activeAudioTakeCount over the manifest counts active+audio takes', activeAudioTakeCount(projMan), 3);
eq('activeAudioTakeCount over projected records', activeAudioTakeCount({ takes: proj }), 2);

const hyd = hydrateSavedTakes('blue-eyes', proj);
ok('hydrateSavedTakes yields a valid manifest', validateManifest(hyd).ok);
eq('hydrate keeps schemaVersion 2', hyd.schemaVersion, 2);
eq('hydrate keeps the take numbers', hyd.takes.map((t) => t.take).join(','), '1,2');
eq('hydrate selects the right most-recent take', mostRecentKeptTake(hyd).take, 2);
eq('project/hydrate round-trip is idempotent', JSON.stringify(projectTakesForJson(hyd)), JSON.stringify(proj));

const tdw = tapeDeckWithTakes('blue-eyes', projMan);
eq('tapeDeckWithTakes carries the path ref', tdw.path, 'takes/blue-eyes/');
eq('tapeDeckWithTakes stamps schemaVersion 2', tdw.schemaVersion, 2);
eq('tapeDeckWithTakes projects the saved takes', tdw.takes.length, 2);

// rekeyManifest (the "Dupe" feature) — re-key a manifest onto a new slug, re-deriving every
// id-bearing stem/bounce filename; null (opfs-projected) slots stay null; immutable.
const rekeyed = rekeyManifest({ schemaVersion: 2, slug: 'blue-eyes', takes: proj }, 'blue-eyes-copy');
eq('rekeyManifest sets the new slug', rekeyed.slug, 'blue-eyes-copy');
eq('rekeyManifest keeps schemaVersion 2', rekeyed.schemaVersion, 2);
eq('rekeyManifest keeps the take numbers', rekeyed.takes.map((t) => t.take).join(','), '1,2');
const rk1 = rekeyed.takes.find((t) => t.take === 1);
eq('rekeyManifest re-derives a stem filename for the new slug', rk1.stems.stem1.file, stemFileName('blue-eyes-copy', 1, 'stem1'));
eq('rekeyManifest re-derives the bounce filename', rk1.bounce.file, mixFileName('blue-eyes-copy', 1));
const rk2 = rekeyed.takes.find((t) => t.take === 2);
eq('rekeyManifest re-derives a partial take\'s surviving slot', rk2.stems.stem1.file, stemFileName('blue-eyes-copy', 2, 'stem1'));
eq('rekeyManifest leaves an opfs-projected (null) slot null', rk2.stems.stem2, null);
ok('rekeyManifest is immutable (source filename unchanged)', proj.find((t) => t.take === 1).stems.stem1.file === stemFileName('blue-eyes', 1, 'stem1'));
ok('a rekeyed manifest validates', validateManifest(rekeyed).ok);

// ---- takeModel: MIDI archival helpers ----
eq('midiRef path', midiRef('blue-eyes'), 'midi/blue-eyes/');
let midiMan = appendTake(createManifest('s'), makeTake({ take: 1, sampleRate: 48000, drums: { enabled: true, source: { type: 'midi' } } }, 'T'));
eq('referencedMidiFiles is empty before a filename is set', referencedMidiFiles(midiMan).size, 0);
midiMan = setDrumMidiFile(midiMan, 1, 'groove.mid');
eq('setDrumMidiFile records the filename', midiMan.takes[0].drums.source.midiFile, 'groove.mid');
eq('setDrumMidiFile keeps source.type midi', midiMan.takes[0].drums.source.type, 'midi');
eq('referencedMidiFiles collects the referenced name', [...referencedMidiFiles(midiMan)].join(','), 'groove.mid');
eq('referencedMidiFiles ignores grid-source takes', referencedMidiFiles(appendTake(createManifest('s'), makeTake({ take: 1, sampleRate: 48000 }, 'T'))).size, 0);

// ---- playbackCacheStale: the retake / in-place-overwrite cache-invalidation predicate ----
// audioEngine caches a take's DECODED playback buffers keyed on a small descriptor. A
// "retake" re-records the SAME take number into the SAME OPFS WAV, and a ping-pong bounce
// overwrites the dst WAV in place — both under an unchanged (slug, take). Only an engine-local
// monotonic recordEpoch distinguishes the new audio; content fields are unreliable (group
// resets to 1 on a single-pass retake, durationSec can collide). This pure predicate is the
// single reload decision play()/replay() consult: it MUST report stale on an epoch bump under
// a fixed (slug, take), or the deck replays the first cut forever.
ok('cache is fresh when slug+take+epoch all match',
   playbackCacheStale({ slug: 's', take: 1, epoch: 0 }, { slug: 's', take: 1, epoch: 0 }) === false);
ok('cache is stale on a null (never-loaded) cache',
   playbackCacheStale(null, { slug: 's', take: 1, epoch: 0 }) === true);
ok('cache is stale when the slug differs',
   playbackCacheStale({ slug: 's', take: 1, epoch: 0 }, { slug: 't', take: 1, epoch: 0 }) === true);
ok('cache is stale when the take number differs',
   playbackCacheStale({ slug: 's', take: 1, epoch: 0 }, { slug: 's', take: 2, epoch: 0 }) === true);
// THE RED-PROVING VECTOR — same slug, same take number, bumped epoch (a retake overwrote the
// take's WAV in place). A take-number-only cache returns false ("fresh") here and replays the
// first recording; the fix makes it true. This one line IS the reported bug.
ok('cache is stale when only the record epoch bumped (retake in place)',
   playbackCacheStale({ slug: 's', take: 1, epoch: 0 }, { slug: 's', take: 1, epoch: 1 }) === true);
// Second manifestation: a ping-pong bounce overwrites dst under the same take number.
ok('cache is stale after an in-place bounce bumps the epoch',
   playbackCacheStale({ slug: 's', take: 3, epoch: 4 }, { slug: 's', take: 3, epoch: 5 }) === true);

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
// 17b. Tape deck (pure) — latency.js (overdub round-trip calibration math)
// ============================================================================
// A captured buffer: silence, then a click (short decaying burst) at a known index.
function bufferWithClick(len, at, amp) {
  const b = new Float32Array(len);
  for (let i = 0; i < 200 && at + i < len; i++) b[at + i] = amp * Math.sin((2 * Math.PI * 2000 * i) / 48000) * (1 - i / 200);
  return b;
}
const clickBuf = bufferWithClick(48000, 12000, 0.8);
const onset = detectClickSample(clickBuf);
ok('detectClickSample finds the onset near the click start', Math.abs(onset - 12000) <= 3);
eq('detectClickSample returns -1 on silence', detectClickSample(new Float32Array(48000)), -1);
eq('detectClickSample returns -1 on empty', detectClickSample(new Float32Array(0)), -1);
// A little room noise, click well above it -> still detected at the right place.
const noisy = bufferWithClick(48000, 20000, 0.6);
for (let i = 0; i < noisy.length; i++) noisy[i] += (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.02; // deterministic pseudo-noise
ok('detectClickSample survives low room noise', Math.abs(detectClickSample(noisy) - 20000) <= 5);

eq('rttSeconds computes onset-minus-emit over rate', rttSeconds(48000 + 960, 48000, 48000), 0.02); // 20 ms
ok('rttSeconds NaN on bad input', Number.isNaN(rttSeconds(1, 2, 0)));

eq('median odd', median([3, 1, 2]), 2);
eq('median even', median([4, 1, 3, 2]), 2.5);
ok('median ignores non-numbers', median([2, NaN, 4, undefined, 6]) === 4);

ok('isPlausibleRtt accepts a typical 20 ms round trip', isPlausibleRtt(0.02));
ok('isPlausibleRtt rejects 0', !isPlausibleRtt(0));
ok('isPlausibleRtt rejects an absurd 2 s', !isPlausibleRtt(2));
eq('PLAUSIBLE band', PLAUSIBLE_RTT_MIN + ',' + PLAUSIBLE_RTT_MAX, '0.001,0.5');

// summarizeTrials: median is robust to one wild outlier; the spread reports confidence.
const good = summarizeTrials([0.021, 0.019, 0.020, 0.022, 0.018, 0.200]); // last is an outlier
ok('summarizeTrials is ok with a quorum', good.ok);
ok('summarizeTrials median rejects the outlier', Math.abs(good.medianSec - 0.0205) < 0.002);
ok('summarizeTrials reports a spread', good.spreadMs > 0);
ok('summarizeTrials filters implausible values before the quorum', !summarizeTrials([0.02, null, 5, 0]).ok);
ok('summarizeTrials fails on all-silent trials', !summarizeTrials([null, null, null]).ok);

// ============================================================================
// 17c. Overdub latency AUTO-ESTIMATE (uncalibrated) — pure resolve/estimate math.
//   Proves the fix for the "recorded audio lags the drums" bug: when the user has NOT
//   calibrated, the compensation must come from the live AudioContext (+ track) latency,
//   not default to 0. estimateMonitorLatencySec models RTL = output + input + one comp
//   lookahead (symmetric input fallback); resolveMonitorLatencySec keeps a measured/manual
//   value authoritative and otherwise falls back to the estimate.
// ============================================================================
// Uncalibrated + a real output latency -> a positive, plausible compensation.
const est = estimateMonitorLatencySec({ outputLatency: 0.012, baseLatency: 0.006, inputLatency: 0.012 });
ok('estimate is positive when the context reports output latency', est > 0);
ok('estimate stays within the plausible round-trip band', isPlausibleRtt(est));
ok('estimate = output + input + comp lookahead', Math.abs(est - (0.012 + 0.006 + 0.012)) < 1e-9);
// Monotonic non-decreasing in outputLatency.
ok('estimate grows with outputLatency',
   estimateMonitorLatencySec({ outputLatency: 0.020 }) > estimateMonitorLatencySec({ outputLatency: 0.010 }));
// Missing/implausible input latency -> symmetric fallback (2*out + comp).
ok('absent input latency falls back to symmetric (2*out + comp)',
   Math.abs(estimateMonitorLatencySec({ outputLatency: 0.010 }) - (0.020 + 0.006)) < 1e-9);
// baseLatency is only a floor fallback when outputLatency is unusable.
ok('baseLatency is the fallback when outputLatency is 0',
   estimateMonitorLatencySec({ outputLatency: 0, baseLatency: 0.006 }) > 0);
// No usable data at all -> 0 (record uncompensated; never guess a full default -> no early pull).
eq('no latency data -> 0', estimateMonitorLatencySec({}), 0);
eq('zero everything -> 0', estimateMonitorLatencySec({ outputLatency: 0, baseLatency: 0 }), 0);
// A large-but-usable pair whose SUM exceeds the band is clamped to the max.
eq('the estimate is clamped to the plausible max',
   estimateMonitorLatencySec({ outputLatency: 0.3, inputLatency: 0.3 }), PLAUSIBLE_RTT_MAX);
// resolve: a measured (loopback) or manual value is authoritative, returned verbatim.
eq('resolve returns the measured value unchanged',
   resolveMonitorLatencySec({ source: 'measured', storedSec: 0.031, outputLatency: 0.012 }), 0.031);
eq('resolve returns the manual value unchanged (even 0)',
   resolveMonitorLatencySec({ source: 'manual', storedSec: 0, outputLatency: 0.012 }), 0);
// resolve: uncalibrated -> the live estimate; with no context data -> 0.
ok('resolve falls back to the estimate when source is none',
   resolveMonitorLatencySec({ source: 'none', storedSec: 0, outputLatency: 0.012, inputLatency: 0.012 }) > 0);
eq('resolve is 0 when uncalibrated AND no context data',
   resolveMonitorLatencySec({ source: 'none', storedSec: 0 }), 0);

// ============================================================================
// 18. Tape deck — sw.js caches every new module (tape/… asset-list assertion)
// ============================================================================
for (const f of ['tape/takeModel', 'tape/meterModel', 'tape/clickModel', 'tape/click', 'tape/wav', 'tape/lufs', 'tape/limiter', 'tape/latency', 'tape/audioEngine', 'tape/takeStore', 'tape/folderStore', 'tape/opfsWorker', 'tape/captureProcessor', 'tape/devices', 'tape/deckControls', 'tape/tapeView', 'tape/drumModel', 'tape/midiParse', 'tape/drumKits', 'tape/drumMachine', 'tape/drumPanel', 'tape/rulesetModel', 'tape/rulesetStore', 'tape/loopFolder', 'tape/loopPicker']) {
  ok('sw.js caches ' + f + '.js', sw.includes(`"./js/${f}.js"`));
}

// ============================================================================
// 19. Metronome click model (the tape deck's per-take click track)
// ============================================================================
// Ported time-sig / subdivision / BPM tables match the standalone app.
eq('clickModel has 16 time sigs', TIME_SIGS.length, 16);
eq('clickModel BPM range', MIN_BPM + '-' + MAX_BPM, '20-300');
eq('clickModel has 4 subdivisions', SUBS.length, 4);

// computeLevels turns a meter+accent into per-beat tiers (2 downbeat / 1 group / 0 beat).
eq('4/4 "On" accents only the downbeat', computeLevels(2, 1).join(','), '2,0,0,0');
eq('4/4 "Off" has no accents', computeLevels(2, 0).join(','), '0,0,0,0');
// 7/8 (index 7) grouped 3+2+2 (accent index 4) -> downbeat + two group starts.
eq('7/8 3+2+2 tiers', computeLevels(7, 4).join(','), '2,0,0,1,0,1,0');
eq('accentGroups parses a compound grouping', accentGroups('3+2+2', 7).join(','), '3,2,2');
eq('accentGroups "Off" is null', accentGroups('Off', 4), null);

// Count-in length is 2 bars of beats; subdivision does not change it.
eq('4/4 @120 bar is 2s', barSeconds(120, 2), 2);
eq('2-bar count-in @120 4/4 is 4s', countInSeconds(120, 2), 4);
eq('2-bar count-in @60 3/4 is 6s', countInSeconds(60, 1), 6);

// clampClickConfig: schema baseline is DISABLED; clamps every field into range.
eq('defaultClickConfig is disabled', defaultClickConfig().enabled, false);
const cc = clampClickConfig({ enabled: true, bpm: 999, timeSigIndex: 99, subdivision: 9, accentIndex: 50 });
eq('clamp bpm to max', cc.bpm, 300);
eq('clamp bpm to min', clampClickConfig({ bpm: 1 }).bpm, 20);
eq('clamp timeSigIndex into range', cc.timeSigIndex, 15);
eq('clamp subdivision into range', cc.subdivision, 4);
ok('clamp keeps enabled', cc.enabled === true);
// A stranded accentIndex (too big for the selected meter) falls back to that meter's default.
eq('out-of-range accent falls back to default', clampClickConfig({ timeSigIndex: 2, accentIndex: 9 }).accentIndex, defaultAccentIndex(2));
eq('valid accent is kept', clampClickConfig({ timeSigIndex: 7, accentIndex: 4 }).accentIndex, 4);
// The 2-bar count-in is a decoupled flag now (drums, not a click, back the take). Legacy
// losslessness: an absent countIn defaults to `enabled`; an explicit value always wins.
eq('defaultClickConfig count-in is off', defaultClickConfig().countIn, false);
eq('legacy click-on defaults count-in on', clampClickConfig({ enabled: true }).countIn, true);
eq('legacy click-off defaults count-in off', clampClickConfig({ enabled: false }).countIn, false);
eq('explicit count-in overrides (on w/ click off)', clampClickConfig({ enabled: false, countIn: true }).countIn, true);
eq('explicit count-in overrides (off w/ click on)', clampClickConfig({ enabled: true, countIn: false }).countIn, false);

// ============================================================================
// 20. Take schema carries the per-take click config (additive, defaulted on read)
// ============================================================================
const clickTake = makeTake({ take: 1, sampleRate: 48000, click: { enabled: true, bpm: 96, timeSigIndex: 3, subdivision: 2, accentIndex: 2 } }, '2026-07-25T00:00:00Z');
eq('makeTake stores the click bpm', clickTake.click.bpm, 96);
eq('makeTake stores click enabled', clickTake.click.enabled, true);
eq('makeTake without a click defaults to disabled', makeTake({ take: 2, sampleRate: 48000 }, '2026-07-25T00:00:00Z').click.enabled, false);
// A legacy take with NO click field normalizes to the disabled default (no click gained).
const legacy = normalizeTake({ take: 3, status: 'active', createdAt: 'x', sampleRate: 48000, stems: { stem1: { file: 'a.wav', group: 1, durationSec: 1, vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 }, stem2: null, stem3: null, stem4: null }, bounce: null });
eq('legacy take normalizes click to disabled', legacy.click.enabled, false);
ok('legacy take click has a bpm', typeof legacy.click.bpm === 'number');
// validateTake accepts an absent click and a well-formed one, rejects a malformed one.
ok('validateTake ok with no click', validateTake({ take: 4, status: 'active', createdAt: 'x', durationSec: null, sampleRate: 48000, stems: { stem1: null, stem2: null, stem3: null, stem4: null }, bounce: null }).ok);
ok('validateTake rejects a bad click', !validateTake({ take: 5, status: 'active', createdAt: 'x', durationSec: null, sampleRate: 48000, stems: { stem1: null, stem2: null, stem3: null, stem4: null }, bounce: null, click: { enabled: 'yes', bpm: 'fast' } }).ok);
// Regression: a silent-mix bounce has lufs:null (normalizeBounce emits it); validateTake must
// accept it, else reopening the deck wipes the whole take history.
{
  const silentBounce = { take: 6, status: 'active', createdAt: 'x', durationSec: 1, sampleRate: 48000, stems: { stem1: { file: 'a.wav', group: 1, durationSec: 1, vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 }, stem2: null, stem3: null, stem4: null }, bounce: { file: 'm.wav', bouncedAt: 'x', lufs: null } };
  ok('validateTake accepts a bounce lufs:null', validateTake(silentBounce).ok);
  ok('normalize->validate round-trips a silent bounce', validateManifest(normalizeManifest({ schemaVersion: 2, slug: 's', takes: [silentBounce] })).ok);
}

// ============================================================================
// 21. Meter model (the tape deck's LED-ladder math — peaks, ballistics, clip latch)
// ============================================================================
eq('CLIP_THRESHOLD is 0.98', CLIP_THRESHOLD, 0.98);
// Segment mapping: silence -> 0, full-scale -> all, dB-spaced and monotonic.
eq('peakToSegments(0) is 0', peakToSegments(0, 12), 0);
eq('peakToSegments(1.0) lights all 12', peakToSegments(1, 12), 12);
eq('peakToSegments respects the segment count', peakToSegments(1, 16), 16);
ok('peakToSegments below the floor is 0', peakToSegments(Math.pow(10, (METER_FLOOR_DB - 6) / 20), 12) === 0);
ok('peakToSegments is monotonic non-decreasing', (() => {
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) { const s = peakToSegments(p, 12); if (s < prev) return false; prev = s; }
  return true;
})());
ok('an audible peak above the floor lights at least one segment', peakToSegments(Math.pow(10, (METER_FLOOR_DB + 1) / 20), 12) >= 1);
// peakToLit is the quantized fraction for the CSS var.
eq('peakToLit(1.0) is 1', peakToLit(1, 12), 1);
eq('peakToLit(0) is 0', peakToLit(0, 12), 0);
ok('peakToLit lands on a segment boundary', Math.abs(peakToLit(0.5, 12) * 12 - Math.round(peakToLit(0.5, 12) * 12)) < 1e-9);
// Ballistics: instant attack, decay falls strictly between full and silence over one frame.
eq('decayPeak attack is instant', decayPeak(0.2, 0.9, 50), 0.9);
ok('decayPeak falls between frames', (() => { const d = decayPeak(1.0, 0, 100); return d > 0 && d < 1; })());
ok('decayPeak never drops below the incoming peak', decayPeak(1.0, 0.5, 1000) >= 0.5);
ok('decayPeak fall rate matches FALL_DB_PER_SEC', Math.abs(decayPeak(1.0, 0, 1000) - Math.pow(10, -FALL_DB_PER_SEC / 20)) < 1e-9);
// Clip latch: a clip holds for holdMs, then releases.
{
  const c1 = clipState(null, 1.0, 1000);
  ok('clipState latches on an overload', c1.clipped && c1.until === 1000 + CLIP_HOLD_MS);
  const c2 = clipState(c1, 0.1, 1000 + CLIP_HOLD_MS - 1);
  ok('clipState holds during the latch window', c2.clipped);
  const c3 = clipState(c2, 0.1, 1000 + CLIP_HOLD_MS + 1);
  ok('clipState releases after the hold', !c3.clipped && c3.until === 0);
  ok('clipState stays clear below threshold', !clipState(null, 0.5, 0).clipped);
  ok('a peak exactly at threshold clips', clipState(null, CLIP_THRESHOLD, 0).clipped);
}

// ============================================================================
// 22. OPFS worker append/finalize ordering (the tape-deck "stuck after recording"
//     regression). opfsWorker.js is browser-only (self/navigator/OPFS), so we run
//     the REAL source in a vm sandbox with an in-memory OPFS and the two message
//     channels the worker actually has: the transferred audio port (appends) and
//     the control channel (openTake/finalizeTake). Appends and finalize race across
//     those two unordered ports; a chunk that lands after finalize must be a benign
//     no-op, NOT a writeError — the writeError is what banner-storms the deck and
//     leaves it "crashed until a hard refresh".
{
  const WORKER_SRC = readFileSync(here('./js/tape/opfsWorker.js'), 'utf8');
  const makeSyncHandle = (store, key) => ({
    truncate(n) { store[key] = store[key].slice(0, n); },
    write(buf, opts) {
      const at = (opts && opts.at) || 0;
      const bytes = new Uint8Array(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);
      if (store[key].length < at + bytes.length) { const g = new Uint8Array(at + bytes.length); g.set(store[key]); store[key] = g; }
      store[key].set(bytes, at); return bytes.length;
    },
    read(buf, opts) { const at = (opts && opts.at) || 0; const out = new Uint8Array(buf.buffer); out.set(store[key].subarray(at, at + out.length)); return out.length; },
    getSize() { return store[key].length; }, flush() {}, close() {},
  });
  const makeDir = (store, prefix = '') => ({
    async getDirectoryHandle(name) { return makeDir(store, prefix + name + '/'); },
    async getFileHandle(name) { const k = prefix + name; if (!(k in store)) store[k] = new Uint8Array(0); return { async createSyncAccessHandle() { return makeSyncHandle(store, k); } }; },
    async removeEntry() {},
  });
  function loadWorker() {
    const store = {}, outbound = [];
    const self = { onmessage: null, postMessage: (m) => outbound.push(m) };
    const sandbox = { self, navigator: { storage: { getDirectory: async () => makeDir(store) } }, setInterval: () => 0, clearInterval: () => {}, DataView, ArrayBuffer, Uint8Array, FileSystemFileHandle: function () {}, console };
    sandbox.FileSystemFileHandle.prototype.createSyncAccessHandle = function () {};
    vm.createContext(sandbox);
    vm.runInContext(WORKER_SRC, sandbox, { filename: 'opfsWorker.js' });
    const tick = () => new Promise((r) => setImmediate(r));
    return {
      store, outbound,
      async control(msg) { self.onmessage({ data: msg }); await tick(); },
      bindPort() { const port = { onmessage: null }; self.onmessage({ data: { op: 'bindPort', port } }); return port; },
      portSend(port, msg) { port.onmessage({ data: msg }); },
    };
  }
  const header = new Uint8Array(44).buffer;
  const SF = [{ offset: 4, bias: 36 }, { offset: 40, bias: 0 }];
  const chunk = () => new Uint8Array([1, 2, 3, 4]).buffer;
  const writeErrs = (w) => w.outbound.filter((m) => m && m.type === 'writeError');

  // A straggler append that lands after finalizeTake (the cross-port race) is benign.
  {
    const w = loadWorker(); const p = w.bindPort();
    await w.control({ id: 1, op: 'openTake', dir: 'takes/s/', files: { stem1: 's-1-1.wav' }, header, sizeFields: SF });
    w.portSend(p, { op: 'append', stem: 1, bytes: chunk() });
    await w.control({ id: 2, op: 'finalizeTake' });
    w.portSend(p, { op: 'append', stem: 1, bytes: chunk() });      // stray, post-finalize
    ok('post-finalize append is a benign no-op (no writeError)', writeErrs(w).length === 0);
  }
  // An append that arrives before openTake set the state is also benign (start race).
  {
    const w = loadWorker(); const p = w.bindPort();
    w.portSend(p, { op: 'append', stem: 1, bytes: chunk() });      // before openTake
    await w.control({ id: 1, op: 'openTake', dir: 'takes/s/', files: { stem1: 's-1-1.wav' }, header, sizeFields: SF });
    ok('pre-openTake append is a benign no-op (no writeError)', writeErrs(w).length === 0);
  }
  // The intended in-order path still WRITES the audio (fix didn't silence real writes).
  {
    const w = loadWorker(); const p = w.bindPort();
    await w.control({ id: 1, op: 'openTake', dir: 'takes/s/', files: { stem1: 's-1-1.wav' }, header, sizeFields: SF });
    w.portSend(p, { op: 'append', stem: 1, bytes: chunk() });
    const res = await w.control({ id: 2, op: 'finalizeTake' });
    ok('in-order append is written (44 header + 4 data)', w.store['takes/s/s-1-1.wav'].length === 48);
    ok('in-order finalize reports the data bytes', w.outbound.some((m) => m && m.id === 2 && m.dataBytes && m.dataBytes.stem1 === 4));
    ok('in-order path emits no writeError', writeErrs(w).length === 0);
  }

  // ---- DRAIN BARRIER (sample-perfect tails) ----
  // A drain marker rides the SAME channel as the appends, so the worker processes it
  // AFTER every append is written, then echoes {type:'drained', drainId}. stop() waits
  // for that echo before finalizeTake, so the final flush chunk can never be dropped.
  const drainedIn = (w) => w.outbound.filter((m) => m && m.type === 'drained');
  // R1: drain over the bound AUDIO port -> drained echoed with its id.
  {
    const w = loadWorker(); const p = w.bindPort();
    await w.control({ id: 1, op: 'openTake', dir: 'takes/s/', files: { stem1: 's-1-1.wav' }, header, sizeFields: SF });
    w.portSend(p, { op: 'drain', drainId: 3 });
    const d = drainedIn(w);
    ok('drain over the audio port echoes {type:drained}', d.length === 1);
    ok('drained echoes the drainId (audio port)', d[0] && d[0].drainId === 3);
  }
  // R2 + R2b: drain over the CONTROL channel (fallback relay) -> drained echoed with id.
  {
    const w = loadWorker();
    await w.control({ id: 1, op: 'openTake', dir: 'takes/s/', files: { stem1: 's-1-1.wav' }, header, sizeFields: SF });
    await w.control({ op: 'drain', drainId: 7 });
    const d = drainedIn(w);
    ok('drain over the control channel echoes drained with its id', d.length === 1 && d[0].drainId === 7);
    ok('a relayed drain is not mistaken for an unknown op', !w.outbound.some((m) => m && m.error && /unknown op drain/.test(m.error)));
  }
  // R3 (crux): at the instant drained is emitted, every prior port-append is already written.
  {
    const w = loadWorker(); const p = w.bindPort();
    await w.control({ id: 1, op: 'openTake', dir: 'takes/s/', files: { stem1: 's-1-1.wav' }, header, sizeFields: SF });
    w.portSend(p, { op: 'append', stem: 1, bytes: chunk() });        // -> 48 bytes on disk
    w.portSend(p, { op: 'drain', drainId: 1 });
    ok('drain trails the append: file is 48 bytes AND drained emitted', w.store['takes/s/s-1-1.wav'].length === 48 && drainedIn(w).length === 1);
  }
  // R4: drain is a barrier SIGNAL, not a finalize — the take stays open for more writes.
  {
    const w = loadWorker(); const p = w.bindPort();
    await w.control({ id: 1, op: 'openTake', dir: 'takes/s/', files: { stem1: 's-1-1.wav' }, header, sizeFields: SF });
    w.portSend(p, { op: 'append', stem: 1, bytes: chunk() });
    w.portSend(p, { op: 'drain', drainId: 1 });
    w.portSend(p, { op: 'append', stem: 1, bytes: chunk() });        // still accepted -> 52 bytes
    ok('drain does not finalize: a later append still writes', w.store['takes/s/s-1-1.wav'].length === 52);
    ok('drain emits no writeError', writeErrs(w).length === 0);
  }
}

// ============================================================================
// 23. Fix tripwires — the impure capture/stop layer the node test can't execute.
//     String-level guards so a refactor can't silently revert the "stuck after
//     recording" fixes (all four verified live in Chrome).
// ============================================================================
{
  const capSrc = readFileSync(here('./js/tape/captureProcessor.js'), 'utf8');
  ok('worklet quiesces on flush (this.closed=true)', capSrc.includes('this.closed = true'));
  ok('worklet self-removes from the graph when closed', /if\s*\(this\.closed\)\s*return false/.test(capSrc));
  const owSrc = readFileSync(here('./js/tape/opfsWorker.js'), 'utf8');
  ok('worker no longer errors on a null-state append', !owSrc.includes("append received with no take open"));
  const aeSrc = readFileSync(here('./js/tape/audioEngine.js'), 'utf8');
  ok('stop() guards finalize so teardown/onStatus always run', /catch\s*{[^}]*}\s*\n\s*teardownCaptureGraph\(\)/.test(aeSrc) || aeSrc.includes('fall through so we still tear down'));
  ok('teardown severs the capture source', aeSrc.includes('captureSource.disconnect()'));
  const mainSrc = readFileSync(here('./js/main.js'), 'utf8');
  ok('onStopTake clears deckRecording even if stop() throws', /finally\s*{\s*if \(deckRecording\)\s*{\s*deckRecording = false/.test(mainSrc));

  // ---- drain-barrier wiring (sample-perfect tails) — browser-only paths node can't run ----
  ok('worklet posts a drain barrier on flush', /postMessage\(\s*\{\s*op:\s*['"]drain['"]/.test(capSrc));
  ok('measure flush stays drainless', /if \(this\.measure\) \{\s*this\.postMeasureChunk\(\)/.test(capSrc));
  ok('worker emits the drained ack', /type:\s*['"]drained['"]/.test(owSrc));
  ok('worker handles a drain op', owSrc.includes("msg.op === 'drain'"));
  ok('stop awaits drain BEFORE finalize', aeSrc.indexOf('awaitDrain') > 0 && aeSrc.indexOf('awaitDrain') < aeSrc.indexOf('finalizeTakeFiles'));
  ok('drain wait is bounded by a timeout', aeSrc.includes('setTimeout(resolve, 500)') && /drained\.then/.test(aeSrc));
  ok('fallback relays the drain marker', aeSrc.includes('relayDrain'));
  const tsSrc = readFileSync(here('./js/tape/takeStore.js'), 'utf8');
  ok('takeStore exposes awaitDrain + relayDrain', tsSrc.includes('export function awaitDrain') && tsSrc.includes('export async function relayDrain'));
  ok('takeStore demuxes the drained ack (id-matched)', /type === 'drained'/.test(tsSrc) && tsSrc.includes('drainWaiter.id === msg.drainId'));

  // ---- retake / in-place-overwrite playback-cache invalidation (recordEpoch) ----
  //   A retake re-records the SAME take number over the SAME WAV, and a ping-pong bounce
  //   overwrites the dst WAV in place — both under an unchanged (slug, take). A monotonic
  //   engine-local recordEpoch, bumped on every in-place audio write, is the only reliable
  //   invalidator. Section 14 proves the DECISION (playbackCacheStale); these prove the deck
  //   actually feeds the epoch through it. Browser-only paths node can't execute.
  ok('audioEngine imports playbackCacheStale from the pure model',
     /import\s*\{[^}]*playbackCacheStale[^}]*\}\s*from\s*'\.\/takeModel\.js'/.test(aeSrc));
  ok('engine declares a monotonic recordEpoch counter', /let\s+recordEpoch\s*=\s*0/.test(aeSrc));
  ok('loadTake stamps the epoch onto playChains', /playChains\s*=\s*\{[^}]*epoch:\s*recordEpoch/.test(aeSrc));
  ok('play/replay consult playbackCacheStale with the live epoch',
     aeSrc.includes('epoch: recordEpoch') && (aeSrc.match(/playbackCacheStale\(/g) || []).length >= 2);
  {
    const s = aeSrc.indexOf('async function record('), e = aeSrc.indexOf('async function stop(');
    ok('record() bumps recordEpoch when it opens the take files',
       s > 0 && e > s && aeSrc.slice(s, e).includes('recordEpoch++'));
  }
  {
    const s = aeSrc.indexOf('async function bounceTracks('), e = aeSrc.indexOf('async function calibrateLatency(');
    ok('bounceTracks() bumps recordEpoch on the in-place dst overwrite',
       s > 0 && e > s && aeSrc.slice(s, e).includes('recordEpoch++'));
  }

  // ---- Finding B: deleting the currently-loaded take must DISPOSE (not just stop) playback,
  //   else its decoded buffers + graph nodes linger past the delete. Lifecycle wiring, no pure seam. ----
  ok('engine exposes invalidatePlayback on its public API',
     /return\s*\{[^}]*\binvalidatePlayback\b/.test(aeSrc));
  {
    const s = mainSrc.indexOf('onDeleteTake:'), e = mainSrc.indexOf('onSelectTake:');
    ok('onDeleteTake invalidates playback when the loaded take is deleted',
       s > 0 && e > s && mainSrc.slice(s, e).includes('invalidatePlayback'));
  }

  // ---- Overdub latency auto-estimate (uncalibrated) — resolve/estimate wiring (browser-only path) ----
  const latSrc = readFileSync(here('./js/tape/latency.js'), 'utf8');
  ok('latency.js exports the estimate + resolve helpers',
     /export function estimateMonitorLatencySec/.test(latSrc) && /export function resolveMonitorLatencySec/.test(latSrc));
  ok('the estimate is clamped to the plausible band + carries a comp-lookahead constant',
     latSrc.includes('PLAUSIBLE_RTT_MAX') && latSrc.includes('COMP_LOOKAHEAD_SEC'));
  {
    const s = aeSrc.indexOf('async function record('), e = aeSrc.indexOf('async function stop(');
    ok('record() resolves the gate shift via resolveMonitorLatencySec (not a bare monitorLatencySec||0)',
       s > 0 && e > s && aeSrc.slice(s, e).includes('resolveMonitorLatencySec') &&
       !/const shift = monitorLatencySec \|\| 0/.test(aeSrc.slice(s, e)));
  }
  ok('record() feeds the live context + track latency into the resolver',
     /outputLatency:\s*audioCtx\.outputLatency/.test(aeSrc) && /inputLatency:\s*settings\.latency/.test(aeSrc));
  ok('main.js passes the latency SOURCE to record()', mainSrc.includes('monitorLatencySource'));
  ok('audioEngine exposes getContextLatency on its public API', /return\s*\{[^}]*\bgetContextLatency\b/.test(aeSrc));
  ok('the live estimate is never persisted (writeLatency only for measured/manual)',
     !/writeLatency\([^)]*source:\s*['"](none|estimate)['"]/.test(mainSrc));
}

// ============================================================================
// 23b. Single-source-of-truth wiring — the impure Save / open / dupe / migration glue the node
//      test can't execute. These string tripwires lock in "the song .json is the source of truth
//      for take records, the folder manifest.json is dropped", and guard the dead-code class of
//      bug (a tapeDeck block stranded after toSongFile's early return, which shipped every .json
//      without its takes).
// ============================================================================
{
  const mainSrc = readFileSync(here('./js/main.js'), 'utf8');
  const songsSrc = readFileSync(here('./js/songs.js'), 'utf8');

  // The .json serializer is the pure, node-tested one; main.js no longer carries its own copy.
  ok('main.js imports toSongFile from songs.js', /import\s*\{[\s\S]*?\btoSongFile\b[\s\S]*?\}\s*from\s*'\.\/songs\.js'/.test(mainSrc));
  ok('main.js defines no local toSongFile (the dead-code copy is gone)', !/function\s+toSongFile\s*\(/.test(mainSrc));
  ok('toSongBundle delegates to the pure toSongFile', mainSrc.includes('const base = toSongFile(song)'));
  ok('songs.toSongFile assigns tapeDeck onto the returned object', songsSrc.includes('out.tapeDeck ='));

  // The folder manifest.json is deprecated: never written; read ONCE, only by the legacy migration.
  ok('no folder manifest.json is ever written', !/folderStore\.writeFile\([^)]*manifestPath/.test(mainSrc));
  eq('the folder manifest is read only by the legacy migration', (mainSrc.match(/folderStore\.readFile\([^)]*manifestPath/g) || []).length, 1);
  ok('migrateTapeDeckFromFolder backfills the .json via tapeDeckWithTakes',
     /async function migrateTapeDeckFromFolder/.test(mainSrc) && /migrateTapeDeckFromFolder[\s\S]*?tapeDeckWithTakes/.test(mainSrc));

  // Restore precedence is OPFS -> .json hydrate -> fresh; no 'folder' record source survives.
  ok('restore never selects a folder record source', !/source\s*={1,3}\s*'folder'/.test(mainSrc));
  ok('restore hydrates durable takes from the song record', mainSrc.includes('hydrateSavedTakes(a.id, savedTakes)'));

  // Save writes the durable .json (via the shared writer) and surfaces a write failure.
  ok('a shared writeSongJsonById exists', /async function writeSongJsonById/.test(mainSrc));
  ok('onSaveDeck writes the song .json via writeSongJsonById', mainSrc.includes('const jsonWritten = await writeSongJsonById(a.id)'));
  ok('a failed .json write is surfaced, not swallowed', mainSrc.includes('could not update the song .json'));

  // Re-opening a tapeDeck-less .json can't wipe takes: importOneSong reconciles via the pure helper.
  ok('importOneSong reconciles tapeDeck via resolveOpenedTapeDeck', mainSrc.includes('resolveOpenedTapeDeck(s, existing, mode, reslug)'));

  // Dupe copies the takes listed by the SOURCE song's tapeDeck.takes (SSOT), writing no manifest.
  ok('dupe sources takes from the source song tapeDeck.takes', mainSrc.includes('const durable = (a.tapeDeck && Array.isArray(a.tapeDeck.takes))'));

  // Save must not destroy recovery sources when the durable .json commit failed: OPFS-temp deletion
  // is gated on jsonWritten, and a legacy folder manifest.json is preserved when jsonWritten is false.
  ok('onSaveDeck deletes OPFS temps only after a successful .json write', /if \(jsonWritten\)\s*\{[\s\S]{0,240}deleteTakeAudio\(/.test(mainSrc));
  ok('onSaveDeck keeps a legacy folder manifest when the .json write failed', mainSrc.includes("if (!jsonWritten) referenced.add('manifest.json')"));
}

// ============================================================================
// 24. Capture worklet emits the drain barrier on flush (sample-perfect tails).
//     captureProcessor.js is an AudioWorkletProcessor (browser-only); load the REAL
//     source in a vm sandbox mocking AudioWorkletProcessor / registerProcessor /
//     sampleRate / currentFrame. On flush it must post its final {op:'append'} then a
//     {op:'drain', drainId} over the SAME port the appends use (workerPort if
//     transferred, else the node port), UNCONDITIONALLY (a cursor-0 stop must still
//     drain, else stop()'s awaitDrain eats the full timeout) — but NEVER in measure mode.
// ============================================================================
{
  const CAP_SRC = readFileSync(here('./js/tape/captureProcessor.js'), 'utf8');
  const mkPort = () => { const posted = []; return { posted, postMessage(m) { posted.push(m); }, onmessage: null }; };
  function loadWorklet(opts) {
    let Captured = null;
    const sandbox = {
      sampleRate: 48000, currentFrame: 0,
      Float32Array, Int16Array, Uint8Array, ArrayBuffer, DataView,
      AudioWorkletProcessor: class { constructor() { this.port = mkPort(); } },
      registerProcessor: (name, cls) => { Captured = cls; },
    };
    vm.createContext(sandbox);
    vm.runInContext(CAP_SRC, sandbox, { filename: 'captureProcessor.js' });
    const proc = new Captured({ processorOptions: opts });
    proc._sandbox = sandbox; // lets a test drive the AudioContext sample clock (currentFrame) across process() calls
    return proc;
  }
  const flush = (proc, drainId) => proc.port.onmessage({ data: { op: 'flush', drainId } });
  const fill = (proc, n) => proc.process([[new Float32Array(n)]]); // n<8192 -> cursor=n, no auto-flush
  const opsOf = (posted) => posted.filter((m) => m && m.op).map((m) => m.op);

  // R5 (port path): final append THEN drain over the transferred worker port, in order.
  {
    const proc = loadWorklet({ channelCount: 1, slots: [1], beginFrame: 0 });
    const wp = mkPort(); proc.port.onmessage({ data: { port: wp } }); // transfer the worker port
    fill(proc, 100);
    flush(proc, 5);
    ok('flush posts [append, drain] over the worker port in order', opsOf(wp.posted).join(',') === 'append,drain');
    ok('drain over the worker port carries the drainId', (wp.posted.find((m) => m.op === 'drain') || {}).drainId === 5);
    ok('flushed ack still goes on the node port', proc.port.posted.some((m) => m && m.flushed === true));
  }
  // R6 (fallback path): no worker port -> append, drain, flushed all on the node port, in order.
  {
    const proc = loadWorklet({ channelCount: 1, slots: [1], beginFrame: 0 });
    fill(proc, 100);
    flush(proc, 9);
    const seq = proc.port.posted.filter((m) => m && (m.op || m.flushed)).map((m) => m.op || 'flushed').join(',');
    ok('fallback posts append,drain,flushed on the node port in order', seq === 'append,drain,flushed');
  }
  // R7 (measure guard): measure flush emits a measure chunk + flushed, NEVER a drain.
  {
    const proc = loadWorklet({ channelCount: 1, measure: true });
    flush(proc, 1);
    ok('measure flush emits no drain', !proc.port.posted.some((m) => m && m.op === 'drain'));
    ok('measure flush still acks flushed', proc.port.posted.some((m) => m && m.flushed === true));
  }
  // R8 (F1 — unconditional): a cursor-0 stop STILL drains (else awaitDrain hangs the timeout).
  {
    const proc = loadWorklet({ channelCount: 1, slots: [1], beginFrame: 0 });
    const wp = mkPort(); proc.port.onmessage({ data: { port: wp } });
    flush(proc, 2); // no fill -> cursor 0 -> no append, but a drain must still fire
    ok('cursor-0 flush still posts a drain', wp.posted.some((m) => m && m.op === 'drain'));
    ok('cursor-0 flush posts no append', !wp.posted.some((m) => m && m.op === 'append'));
  }

  // R9 (record/playback ALIGNMENT — proves the drum-vs-DI lag AND its fix). Drive the REAL
  // capture gate with an advancing sample clock and one "downbeat" spike that arrives in the
  // input a full round-trip (RTL) after the drum downbeat (musicStart), i.e. exactly where an
  // on-the-beat DI note lands (heard-late + captured-late). The spike's offset in the recorded
  // stem is (marker - beginFrame) = (RTL - shift): with shift 0 (uncalibrated, the bug) it sits
  // RTL late; with shift = the auto-estimate (the fix) it lands on the downbeat. RTL is derived
  // from resolveMonitorLatencySec, so the assertion is tied to the real estimator.
  {
    const drive = (proc, total, sampleAt, Q = 128) => {
      for (let off = 0; off < total; off += Q) {
        const n = Math.min(Q, total - off);
        const blk = new Float32Array(n);
        for (let i = 0; i < n; i++) blk[i] = sampleAt(off + i);
        proc._sandbox.currentFrame = off;      // absolute context frame of this block's sample 0
        proc.process([[blk]]);
      }
    };
    const reconstructStem = (proc, slot) => {
      const parts = proc.port.posted.filter((m) => m && m.op === 'append' && m.stem === slot);
      let len = 0; for (const p of parts) len += p.bytes.byteLength / 2;
      const out = new Float32Array(len); let o = 0;
      for (const p of parts) { const i16 = new Int16Array(p.bytes); for (let i = 0; i < i16.length; i++) out[o++] = i16[i] / 0x8000; }
      return out;
    };
    const argmax = (a) => { let mi = 0, mv = -1; for (let i = 0; i < a.length; i++) { const v = a[i] < 0 ? -a[i] : a[i]; if (v > mv) { mv = v; mi = i; } } return mi; };

    const sr = 48000;
    const shiftSec = resolveMonitorLatencySec({ source: 'none', outputLatency: 0.012, baseLatency: 0.006, inputLatency: 0.012 });
    const RTL = Math.round(shiftSec * sr);
    ok('a real uncalibrated round-trip estimate is nonzero', RTL > 0);
    const musicStart = 24000;               // the drum downbeat frame
    const marker = musicStart + RTL;        // where the on-the-beat DI note actually lands
    const total = marker + 4000;
    const spike = (f) => (f === marker ? 1 : 0);

    { // BUG: uncompensated gate (shift 0) -> the note is baked RTL late in the stem.
      const proc = loadWorklet({ channelCount: 1, slots: [1], beginFrame: musicStart });
      drive(proc, total, spike); flush(proc, 1);
      ok('uncompensated overdub lags by the full round trip (proves the bug)',
         Math.abs(argmax(reconstructStem(proc, 1)) - RTL) <= 1);
    }
    { // FIX: gate opened at musicStart + estimate -> the note lands on the downbeat (~0).
      const proc = loadWorklet({ channelCount: 1, slots: [1], beginFrame: musicStart + RTL });
      drive(proc, total, spike); flush(proc, 1);
      ok('round-trip-compensated overdub aligns the downbeat to ~0 (proves the fix)',
         argmax(reconstructStem(proc, 1)) <= 1);
    }
  }
}

// ============================================================================
// 25. Drum machine model (voices/GM map, kit/effect enums, swing/step timing math,
//     config clamp/validate, immutable pattern transforms) — all pure.
// ============================================================================
// Voice set + GM note map.
eq('12 drum voices', VOICES.length, 12);
eq('voice ids are unique', new Set(VOICE_IDS).size, 12);
ok('every voice has at least one GM note', VOICES.every((v) => v.gm.length >= 1));
eq('9 kits', KIT_IDS.length, 9);
eq('12 effects (none + 8 IR + 3 biquad)', EFFECT_IDS.length, 12);
eq('GM 36 -> kick', voiceForNote(36), 'kick');
eq('GM 35 -> kick', voiceForNote(35), 'kick');
eq('GM 38 -> snare', voiceForNote(38), 'snare');
eq('GM 42 -> closedHat', voiceForNote(42), 'closedHat');
eq('GM 46 -> openHat', voiceForNote(46), 'openHat');
eq('GM 43 -> lowTom', voiceForNote(43), 'lowTom');
eq('GM 50 -> highTom', voiceForNote(50), 'highTom');
eq('GM 49 -> crash', voiceForNote(49), 'crash');
eq('GM 57 -> crash', voiceForNote(57), 'crash');
eq('GM 51 -> ride', voiceForNote(51), 'ride');
eq('GM 39 -> clap', voiceForNote(39), 'clap');
eq('GM 63 -> hiConga', voiceForNote(63), 'hiConga');
eq('GM 64 -> loConga', voiceForNote(64), 'loConga');
eq('unmapped GM 60 -> null', voiceForNote(60), null);
eq('unmapped GM 100 -> null', voiceForNote(100), null);

// Timing math: 16 equal divisions of the bar; swing delays odd steps; drift-free.
eq('stepSeconds 4/4@120 is 0.125', stepSeconds(120, 2), 0.125);
eq('hitTime(0) is 0', hitTime(0, 120, 2, 0), 0);
eq('hitTime(4) straight is 0.5', hitTime(4, 120, 2, 0), 0.5);
eq('hitTime(16) straight is a full bar (2s)', hitTime(16, 120, 2, 0), 2.0);
eq('swing 0.5 delays step 1 to 0.1875', hitTime(1, 120, 2, 0.5), 0.1875);
eq('swing 0.5 delays step 3 to 0.4375', hitTime(3, 120, 2, 0.5), 0.4375);
eq('swing leaves even step 2 at 0.25', hitTime(2, 120, 2, 0.5), 0.25);
ok('triplet swing 1/3 -> step1 at 1/6', Math.abs(hitTime(1, 120, 2, 1 / 3) - 1 / 6) < 1e-9);
ok('swing clamps above SWING_MAX', hitTime(1, 120, 2, 9) === hitTime(1, 120, 2, SWING_MAX));
// A full bar's swing cancels: hitTime(n+16) - hitTime(n) == barSeconds, any n/swing.
ok('bar-length invariant (odd n, swung)', Math.abs((hitTime(17, 120, 2, 0.5) - hitTime(1, 120, 2, 0.5)) - 2.0) < 1e-9);
ok('bar-length invariant (even n, swung)', Math.abs((hitTime(20, 120, 2, 0.5) - hitTime(4, 120, 2, 0.5)) - 2.0) < 1e-9);
ok('swing is identical across the loop seam', Math.abs((hitTime(17, 120, 2, 0.5) - hitTime(16, 120, 2, 0.5)) - (hitTime(1, 120, 2, 0.5) - hitTime(0, 120, 2, 0.5))) < 1e-12);
ok('stepSeconds*16 == barSeconds across meters', Math.abs(stepSeconds(120, 1) * 16 - barSeconds(120, 1)) < 1e-12);
ok('BPM edge 300 stepSeconds', Math.abs(stepSeconds(300, 2) - 0.05) < 1e-12);
ok('BPM edge 20 stepSeconds is finite/positive', stepSeconds(20, 2) > 0 && isFinite(stepSeconds(20, 2)));
ok('non-4/4 bar wrap: 3/4 @120 bar is 1.5s', Math.abs(hitTime(16, 120, 1, 0) - 1.5) < 1e-12);
// cellOf loops the pattern.
{ const c0 = cellOf(0, 2), c16 = cellOf(16, 2), c32 = cellOf(32, 2), c17 = cellOf(17, 2);
  ok('cellOf(0,2) is bar0 step0', c0.patternBar === 0 && c0.step === 0);
  ok('cellOf(16,2) is bar1 step0', c16.patternBar === 1 && c16.step === 0);
  ok('cellOf(32,2) wraps to bar0 step0', c32.patternBar === 0 && c32.step === 0);
  ok('cellOf(17,2) is bar1 step1', c17.patternBar === 1 && c17.step === 1); }
// Velocity + quantize.
eq('velocityFromMidi(0) is 0', velocityFromMidi(0), 0);
eq('velocityFromMidi(127) is 1', velocityFromMidi(127), 1);
ok('velocityFromMidi(64) ~ 0.504', Math.abs(velocityFromMidi(64) - 0.5039) < 1e-3);
eq('quantizeTick(0,480) is 0', quantizeTick(0, 480), 0);
eq('quantizeTick(119,480) rounds to 1', quantizeTick(119, 480), 1);
eq('quantizeTick(240,480) is 2', quantizeTick(240, 480), 2);
eq('quantizeTick(605,480) rounds to 5', quantizeTick(605, 480), 5);

// drumHitsUntil enumerates + loops the pattern deterministically.
{
  let cfg = defaultDrumConfig();
  cfg = setCellVelocity(cfg, 'kick', 0, 1);
  cfg = setCellVelocity(cfg, 'kick', 8, 1);
  const h2 = drumHitsUntil(cfg, 120, 2, 2);
  eq('drumHitsUntil one bar yields 2 kicks', h2.length, 2);
  eq('first kick at t0', h2[0].timeSec, 0);
  eq('second kick at t1.0 (step 8)', h2[1].timeSec, 1.0);
  ok('hit carries the voice + velocity', h2[0].voice === 'kick' && h2[0].velocity === 1);
  const h4 = drumHitsUntil(cfg, 120, 2, 4);
  eq('drumHitsUntil loops: 4 kicks over 2 bars', h4.length, 4);
}

// Config lifecycle (mirrors clickModel: disabled baseline, clamp everything, idempotent).
eq('defaultDrumConfig is disabled', defaultDrumConfig().enabled, false);
eq('defaultDrumConfig kit is kit4', defaultDrumConfig().kit, 'kit4');
eq('defaultDrumConfig is 1 bar', defaultDrumConfig().pattern.bars, 1);
ok('default grid has all 12 voices at 16 steps', VOICE_IDS.every((id) => defaultDrumConfig().pattern.grid[id].length === 16));
{
  const cd = clampDrumConfig({ swing: 9, kit: 'x', effect: 'y', pattern: { bars: 2, grid: { kick: [2] } } });
  eq('clamp swing to SWING_MAX', cd.swing, SWING_MAX);
  eq('clamp unknown kit to kit4', cd.kit, 'kit4');
  eq('clamp unknown effect to none', cd.effect, 'none');
  eq('grid resized to bars*16', cd.pattern.grid.kick.length, 32);
  eq('clamp cell velocity into 0..1', cd.pattern.grid.kick[0], 1);
  eq('all 12 voices present after clamp', Object.keys(cd.pattern.grid).length, 12);
  ok('clampDrumConfig is idempotent', JSON.stringify(clampDrumConfig(cd)) === JSON.stringify(cd));
}
eq('default drum master vol is unity', defaultDrumConfig().master.vol, 1.0);
eq('drum master vol passes through mid-range', clampDrumConfig({ master: { vol: 0.4 } }).master.vol, 0.4);
eq('drum master vol clamps above 1.5', clampDrumConfig({ master: { vol: 9 } }).master.vol, 1.5);
eq('drum master vol clamps below 0', clampDrumConfig({ master: { vol: -3 } }).master.vol, 0);
ok('validateDrumConfig ok on default', validateDrumConfig(defaultDrumConfig()).ok);
ok('validateDrumConfig rejects non-boolean enabled', !validateDrumConfig({ enabled: 'yes' }).ok);
ok('validateDrumConfig rejects an unknown kit', !validateDrumConfig({ enabled: true, kit: 'nope' }).ok);

// Immutable pattern transforms.
{
  const base = defaultDrumConfig();
  const on = toggleCell(base, 'snare', 4);
  ok('toggleCell sets a velocity > 0', on.pattern.grid.snare[4] > 0);
  ok('toggleCell is immutable (new object)', on !== base && on.pattern.grid.snare !== base.pattern.grid.snare);
  const off = toggleCell(on, 'snare', 4);
  eq('toggleCell again clears the cell', off.pattern.grid.snare[4], 0);
  const v = setCellVelocity(base, 'kick', 0, 1.5);
  eq('setCellVelocity clamps to 1', v.pattern.grid.kick[0], 1);
  eq('setCellVelocity clamps negatives to 0', setCellVelocity(base, 'kick', 0, -1).pattern.grid.kick[0], 0);
  const grown = setBars(v, 3);
  eq('setBars grows to bars*16', grown.pattern.grid.kick.length, 48);
  eq('setBars grow preserves existing cells', grown.pattern.grid.kick[0], 1);
  const shrunk = setBars(grown, 1);
  eq('setBars shrinks back to 16', shrunk.pattern.grid.kick.length, 16);
  eq('setBars shrink preserves bar-1 cells', shrunk.pattern.grid.kick[0], 1);
}

// ============================================================================
// 26. MIDI import — the pure SMF parser (readVarLen / parseSMF / notesFromSMF) and
//     smfToPattern (GM-map + quantize onto the grid, unmapped notes discarded).
// ============================================================================
// Byte-array builders for minimal hand-authored SMFs.
const u32b = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const mThd = (format, ntrks, ppq) => [0x4d, 0x54, 0x68, 0x64, ...u32b(6), (format >> 8) & 255, format & 255, (ntrks >> 8) & 255, ntrks & 255, (ppq >> 8) & 255, ppq & 255];
const mTrk = (data) => [0x4d, 0x54, 0x72, 0x6b, ...u32b(data.length), ...data];
const smf = (format, ppq, tracks) => new Uint8Array([...mThd(format, tracks.length, ppq), ...tracks.flatMap(mTrk)]);

// Variable-length quantity.
eq('readVarLen 0x00 -> 0', readVarLen([0x00], 0).value, 0);
eq('readVarLen 0x7f -> 127', readVarLen([0x7f], 0).value, 127);
eq('readVarLen 0x81 0x00 -> 128', readVarLen([0x81, 0x00], 0).value, 128);
eq('readVarLen advances next past the VLQ', readVarLen([0x81, 0x00], 0).next, 2);
eq('readVarLen 0xff 0x7f -> 16383', readVarLen([0xff, 0x7f], 0).value, 16383);
eq('readVarLen 0x81 0x80 0x00 -> 16384', readVarLen([0x81, 0x80, 0x00], 0).value, 16384);

// Format-0 header + note extraction (kick@0, unmapped C@0, snare@240).
{
  const trk0 = [0x00, 0x90, 0x24, 0x64, 0x00, 0x90, 0x3c, 0x64, 0x81, 0x70, 0x90, 0x26, 0x5a, 0x00, 0xff, 0x2f, 0x00];
  const file0 = smf(0, 480, [trk0]);
  const h = parseSMF(file0);
  eq('parseSMF format', h.format, 0);
  eq('parseSMF ntrks', h.ntrks, 1);
  eq('parseSMF ppq', h.ppq, 480);
  const notes = notesFromSMF(file0);
  eq('notesFromSMF returns 3 note-ons', notes.length, 3);
  ok('kick @0 vel100 present', notes.some((n) => n.note === 36 && n.tick === 0 && n.velocity === 100));
  ok('snare @240 vel90 present', notes.some((n) => n.note === 38 && n.tick === 240 && n.velocity === 90));

  // smfToPattern maps + quantizes, discards the unmapped C.
  const r = smfToPattern(file0);
  eq('smfToPattern mapped 2 notes', r.mappedCount, 2);
  eq('smfToPattern discarded the unmapped note', r.discarded.length, 1);
  eq('discarded note is the middle C', r.discarded[0].note, 60);
  eq('smfToPattern derives 1 bar', r.pattern.bars, 1);
  ok('kick lands on step 0', r.pattern.grid.kick[0] > 0);
  ok('snare quantized to step 2 (240/120)', r.pattern.grid.snare[2] > 0);
  eq('snare not on step 0', r.pattern.grid.snare[0], 0);
}
// Running status: two note-ons share one 0x90 status byte.
{
  const trkRun = [0x00, 0x90, 0x24, 0x64, 0x00, 0x26, 0x5a, 0x00, 0xff, 0x2f, 0x00];
  const notes = notesFromSMF(smf(0, 480, [trkRun]));
  eq('running status parses both note-ons', notes.length, 2);
  ok('running-status snare present', notes.some((n) => n.note === 38 && n.velocity === 90));
}
// Note-on velocity 0 is a note-off (dropped).
{
  const trkOff = [0x00, 0x90, 0x24, 0x64, 0x30, 0x90, 0x24, 0x00, 0x00, 0xff, 0x2f, 0x00];
  eq('note-on vel 0 is dropped as a note-off', notesFromSMF(smf(0, 480, [trkOff])).length, 1);
}
// Meta (tempo + text) and EOT are skipped without derailing following notes.
{
  const trkMeta = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xff, 0x01, 0x02, 0x41, 0x42, 0x00, 0x90, 0x24, 0x64, 0x00, 0xff, 0x2f, 0x00];
  const file = smf(0, 480, [trkMeta]);
  const notes = notesFromSMF(file);
  eq('note after meta events still parses', notes.length, 1);
  eq('the surviving note is the kick', notes[0].note, 36);
  ok('tempo meta is captured', parseSMF(file).tracks[0].some((e) => e.type === 'meta' && e.metaType === 0x51 && e.usPerQuarter === 500000));
}
// Format 1: notes merged across tracks by absolute tick.
{
  const t1a = [0x00, 0x90, 0x24, 0x64, 0x00, 0xff, 0x2f, 0x00];
  const t1b = [0x40, 0x90, 0x26, 0x64, 0x00, 0xff, 0x2f, 0x00];
  const notes = notesFromSMF(smf(1, 480, [t1a, t1b]));
  eq('format-1 merges two tracks', notes.length, 2);
  ok('merged notes sorted by tick', notes[0].tick === 0 && notes[1].tick === 64);
}
// Multi-bar import: a kick in bar 2 grows the pattern to 2 bars.
{
  const trkMulti = [0x00, 0x90, 0x24, 0x64, 0x8f, 0x00, 0x90, 0x24, 0x64, 0x00, 0xff, 0x2f, 0x00]; // kick@0, kick@1920
  const r = smfToPattern(smf(0, 480, [trkMulti]));
  eq('multi-bar import derives 2 bars', r.pattern.bars, 2);
  eq('grid resized to 32 steps', r.pattern.grid.kick.length, 32);
  ok('kick on bar-2 downbeat (step 16)', r.pattern.grid.kick[16] > 0);
}
// Errors: not a MIDI file, and SMPTE (frame-based) division.
{
  let threw = false; try { parseSMF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])); } catch { threw = true; }
  ok('parseSMF throws on a non-MThd header', threw);
  let threw2 = false; try { parseSMF(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe0, 0x78])); } catch { threw2 = true; }
  ok('parseSMF rejects SMPTE division', threw2);
}

// ============================================================================
// 27. Take schema carries the per-take drums config (additive, defaulted on read).
// ============================================================================
const drumTake = makeTake({ take: 1, sampleRate: 48000, drums: { enabled: true, kit: 'jazzfunk', swing: 0.5 } }, '2026-07-25T00:00:00Z');
eq('makeTake stores drums enabled', drumTake.drums.enabled, true);
eq('makeTake stores the drums kit', drumTake.drums.kit, 'jazzfunk');
eq('makeTake clamps drums swing', drumTake.drums.swing, 0.5);
eq('makeTake without drums defaults to disabled', makeTake({ take: 2, sampleRate: 48000 }, 'x').drums.enabled, false);
// A legacy take with NO drums field normalizes to the disabled default (no drums gained).
const legacyDrums = normalizeTake({ take: 3, status: 'active', createdAt: 'x', sampleRate: 48000, stems: { stem1: null, stem2: null, stem3: null, stem4: null }, bounce: null });
eq('legacy take normalizes drums to disabled', legacyDrums.drums.enabled, false);
ok('legacy take drums has a kit', typeof legacyDrums.drums.kit === 'string');
ok('validateTake ok with no drums', validateTake({ take: 4, status: 'active', createdAt: 'x', durationSec: null, sampleRate: 48000, stems: { stem1: null, stem2: null, stem3: null, stem4: null }, bounce: null }).ok);
ok('validateTake rejects a bad drums', !validateTake({ take: 5, status: 'active', createdAt: 'x', durationSec: null, sampleRate: 48000, stems: { stem1: null, stem2: null, stem3: null, stem4: null }, bounce: null, drums: { enabled: 'yes' } }).ok);

// ============================================================================
// 28. Drum-loop sequencer — pure ruleset realization + pattern flatten (Phase 0).
//     realizeSequence is TOTAL, injected-rng (no Math.random), indices in 1..N.
// ============================================================================
// A scripted rng returns a fixed cycle of values, so a roll is reproducible in-test.
const scriptedRng = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
// Minimal pattern builder (bars of empty 16-step voices).
const mkPat = (bars) => { const grid = {}; for (const id of VOICE_IDS) grid[id] = new Array(bars * 16).fill(0); return { bars, steps: 16, grid }; };

// ---- concatPatterns: glue grids end-to-end, bars = SUM ----
{
  const p1 = mkPat(1); p1.grid.kick[0] = 1;
  const p2 = mkPat(2); p2.grid.snare[0] = 0.5; p2.grid.kick[16] = 1;
  const c = concatPatterns([p1, p2, p1]);
  eq('concat bars = 1+2+1', c.bars, 4);
  eq('concat kick grid length = 4*16', c.grid.kick.length, 64);
  eq('concat p1 kick at global 0', c.grid.kick[0], 1);
  eq('concat p2 snare at offset 16', c.grid.snare[16], 0.5);
  eq('concat p2 kick at 16+16', c.grid.kick[32], 1);
  eq('concat second p1 kick at offset 48', c.grid.kick[48], 1);
  eq('concat empty list -> 1-bar default', concatPatterns([]).bars, 1);
  eq('concat drops nulls', concatPatterns([null, p1, null]).bars, 1);
}

// ---- realizeSequence: sequential is rng-free and cycles ----
{
  const rr = { type: 'sequential', order: [1, 2, 3] };
  eq('sequential cycles to count', realizeSequence(3, rr, 7, scriptedRng([0])).order.join(''), '1231231');
  eq('sequential filters out-of-range then cycles', realizeSequence(2, rr, 5, scriptedRng([0])).order.join(''), '12121');
  eq('sequential empty-after-filter -> [1]', realizeSequence(1, { type: 'sequential', order: [5, 6] }, 3, scriptedRng([0])).order.join(''), '111');
}

// ---- realizeSequence: weighted bag, deterministic when one weight dominates ----
{
  eq('weighted single loop always 1', realizeSequence(3, { type: 'weighted', weights: { 1: 1 } }, 4, scriptedRng([0.9])).order.join(''), '1111');
  eq('weighted zero-vs-nonzero always picks nonzero', realizeSequence(3, { type: 'weighted', weights: { 1: 0, 2: 5 } }, 4, scriptedRng([0.1, 0.9])).order.join(''), '2222');
  const w = realizeSequence(3, { type: 'weighted', weights: { 1: 1, 2: 1, 3: 1 } }, 20, scriptedRng([0.05, 0.4, 0.8]));
  eq('weighted respects count', w.order.length, 20);
  ok('weighted stays in 1..N', w.order.every((x) => x >= 1 && x <= 3));
}

// ---- realizeSequence: markov ----
{
  // Fully deterministic ring (single-entry transitions, no wildcard): 1->2->3->1...
  const ring = { type: 'markov', start: 1, transitions: { 1: [{ to: 2, w: 1 }], 2: [{ to: 3, w: 1 }], 3: [{ to: 1, w: 1 }] } };
  eq('markov deterministic ring', realizeSequence(3, ring, 5, scriptedRng([0.5])).order.join(''), '12312');
  // default covers unlisted states.
  const dflt = { type: 'markov', start: 1, transitions: { default: [{ to: 2, w: 1 }] } };
  eq('markov default drives unlisted states', realizeSequence(3, dflt, 3, scriptedRng([0.5])).order.join(''), '122');
  // out-of-range `to` dropped, valid one kept.
  const drop = { type: 'markov', start: 1, transitions: { 1: [{ to: 5, w: 1 }, { to: 2, w: 1 }], 2: [{ to: 2, w: 1 }] } };
  eq('markov drops to>N', realizeSequence(3, drop, 2, scriptedRng([0.9])).order.join(''), '12');
  // any-other never repeats the current state.
  const other = { type: 'markov', start: 1, transitions: { default: [{ to: 'any-other', w: 1 }] } };
  const oo = realizeSequence(4, other, 12, scriptedRng([0.1, 0.37, 0.62, 0.88, 0.5]));
  let noRepeat = true; for (let i = 1; i < oo.order.length; i++) if (oo.order[i] === oo.order[i - 1]) noRepeat = false;
  ok('markov any-other never repeats consecutively', noRepeat);
  ok('markov any-other stays in 1..N', oo.order.every((x) => x >= 1 && x <= 4));
  // any-other with a single loop degrades to that loop (no infinite exclusion).
  eq('markov any-other w/ 1 loop degrades', realizeSequence(1, other, 3, scriptedRng([0.5])).order.join(''), '111');
  // Determinism: same rng values -> identical order (the wander-65 example).
  const wander = { name: 'wander-65', type: 'markov', start: 1, transitions: { 1: [{ to: 1, w: 0.325 }, { to: 2, w: 0.325 }, { to: 'any-other', w: 0.35 }], 2: [{ to: 1, w: 0.65 }, { to: 'any-other', w: 0.35 }], default: [{ to: 'any', w: 1 }] } };
  const seedVals = [0.11, 0.73, 0.42, 0.9, 0.05, 0.66, 0.31, 0.58];
  const a = realizeSequence(3, wander, 8, scriptedRng(seedVals)).order.join('');
  const b = realizeSequence(3, wander, 8, scriptedRng(seedVals)).order.join('');
  eq('markov is deterministic for a fixed rng', a, b);
  eq('markov respects count', a.length, 8);
}

// ---- totality: never throws even with a garbage / rng-less ruleset ----
{
  let threw = false;
  try { realizeSequence(3, { type: 'markov' }, 5); } catch { threw = true; }   // no rng, no transitions
  ok('realizeSequence total without rng or transitions', !threw);
  eq('rng-less markov falls to start', realizeSequence(3, { type: 'markov', start: 2, transitions: {} }, 3).order[0], 2);
}

// ---- flatten + sequenceBars ----
{
  const intro = mkPat(1), l1 = mkPat(2), l2 = mkPat(1), outro = mkPat(1);
  intro.grid.crash[0] = 1;
  const parts = { introPattern: intro, loopPatterns: { 1: l1, 2: l2 }, outroPattern: outro };
  eq('sequenceBars sums intro + chosen loops + outro', sequenceBars([1, 2, 1], parts), 7);
  const flat = flattenRealizedSequence([1, 2], parts);
  eq('flatten bars = 1 + 2 + 1 + 1', flat.bars, 5);
  eq('flatten keeps intro crash at step 0', flat.grid.crash[0], 1);
  eq('flatten w/o intro/outro is just the loops', flattenRealizedSequence([1, 1], { loopPatterns: { 1: l1 } }).bars, 4);
}

// ---- validate + normalize ----
{
  const markov = { name: 'wander-65', type: 'markov', start: 1, transitions: { 1: [{ to: 1, w: 0.325 }, { to: 2, w: 0.325 }, { to: 'any-other', w: 0.35 }], default: [{ to: 'any', w: 1 }] } };
  const bag = { name: 'even-bag', type: 'weighted', weights: { 1: 3, 2: 1 } };
  const rr = { name: 'round-robin', type: 'sequential', order: [1, 2, 3] };
  ok('validateRuleset accepts the markov example', validateRuleset(markov).ok);
  ok('validateRuleset accepts the weighted example', validateRuleset(bag).ok);
  ok('validateRuleset accepts the sequential example', validateRuleset(rr).ok);
  ok('validateRuleset rejects an unknown type', !validateRuleset({ name: 'x', type: 'nope' }).ok);
  ok('validateRuleset rejects markov without start', !validateRuleset({ name: 'x', type: 'markov', transitions: { 1: [{ to: 1, w: 1 }] } }).ok);
  ok('validateRuleset rejects a non-object', !validateRuleset(null).ok);
  eq('RULESET_TYPES are the three families', RULESET_TYPES.join(','), 'markov,weighted,sequential');
  eq('normalizeRuleset defaults name from id', normalizeRuleset({ id: 'foo', type: 'sequential', order: [1] }).name, 'foo');
  eq('normalizeRuleset coerces string weights to numbers', normalizeRuleset({ id: 'x', type: 'weighted', weights: { 1: '3' } }).weights['1'], 3);
}

// ============================================================================
// 29. Drum sequencer — meter-aware import, MAX_FLAT_BARS decoupling, sequence schema
//     + loop archival helpers (Phase 1). Reuses the section-26 smf() byte-builder.
// ============================================================================
// ---- barTicks per meter ----
eq('barTicks 4/4 @960 = 4*ppq', barTicks(2, 960), 3840);
eq('barTicks 3/4 @960 = 3*ppq', barTicks(1, 960), 2880);
eq('barTicks 6/8 @960 = 3*ppq', barTicks(5, 960), 2880);
eq('barTicks 2/4 @480 = 2*ppq', barTicks(0, 480), 960);
ok('barTicks positive for every meter', TIME_SIGS.every((_, i) => barTicks(i, 480) > 0));

// ---- meter-aware smfToPattern: a note at the start of 3/4 bar 2 (tick 1440 @ppq480) ----
{
  // kick@0, kick@1440 (VLQ 0x8B 0x20 = 1440).
  const trk = [0x00, 0x90, 0x24, 0x64, 0x8b, 0x20, 0x90, 0x24, 0x64, 0x00, 0xff, 0x2f, 0x00];
  const bytes = smf(0, 480, [trk]);
  const in34 = smfToPattern(bytes, 1);   // 3/4: barTicks 1440 -> the note IS bar 2
  eq('3/4 import derives 2 bars', in34.pattern.bars, 2);
  ok('3/4 kick on bar-2 downbeat (step 16)', in34.pattern.grid.kick[16] > 0);
  ok('3/4 kick on step 0', in34.pattern.grid.kick[0] > 0);
  const in44 = smfToPattern(bytes);      // 4/4 default: the same tick is 3/4 through bar 1
  eq('4/4 default import derives 1 bar', in44.pattern.bars, 1);
  ok('4/4 kick quantized to step 12 (1440/120)', in44.pattern.grid.kick[12] > 0);
}

// ---- MAX_FLAT_BARS decoupling: a flattened pattern survives clamp; setBars stays 64-capped ----
{
  ok('MAX_FLAT_BARS well above 64', MAX_FLAT_BARS >= 128);
  const big = clampDrumConfig({ pattern: { bars: 100, steps: 16, grid: {} } });
  eq('clampDrumConfig preserves a 100-bar pattern', big.pattern.bars, 100);
  eq('clamped 100-bar grid length', big.pattern.grid.kick.length, 100 * 16);
  eq('setBars still caps the manual grid at 64', setBars(defaultDrumConfig(), 100).pattern.bars, 64);
}

// ---- sequence schema: default null, clamp round-trips, source 'sequence', idempotent ----
{
  eq('defaultDrumConfig sequence is null', defaultDrumConfig().sequence, null);
  const seq = { folderName: 'verse', loopFiles: ['001.mid', '002.mid'], algorithmId: 'wander-65', count: 8, intro: 'in.mid', outro: 'out.mid', timeSigIndex: 2, realizedOrder: [1, 2, 1], realizedBars: 24 };
  const cfg = clampDrumConfig({ enabled: true, source: { type: 'sequence' }, sequence: seq });
  eq('clamp keeps source.type sequence', cfg.source.type, 'sequence');
  eq('clamp keeps folderName', cfg.sequence.folderName, 'verse');
  eq('clamp keeps loopFiles', cfg.sequence.loopFiles.join(','), '001.mid,002.mid');
  eq('clamp keeps realizedOrder', cfg.sequence.realizedOrder.join(''), '121');
  eq('clamp keeps count', cfg.sequence.count, 8);
  const twice = clampDrumConfig(cfg);
  eq('clampDrumConfig is idempotent on a sequence', JSON.stringify(twice), JSON.stringify(cfg));
  eq('an unknown source type falls back to grid', clampDrumConfig({ source: { type: 'bogus' } }).source.type, 'grid');
  ok('validateDrumConfig ok with a sequence', validateDrumConfig(cfg).ok);
  ok('validateDrumConfig rejects a bad sequence.count', !validateDrumConfig({ enabled: true, sequence: { count: 0 } }).ok);
  ok('validateDrumConfig still ok with null sequence', validateDrumConfig(defaultDrumConfig()).ok);
}

// ---- loop archival helpers ----
{
  eq('loopsRef path', loopsRef('my-song'), 'loops/my-song/');
  const seqA = { folderName: 'verse', loopFiles: ['001.mid', '002.mid'], intro: 'in.mid', outro: null, algorithmId: 'x', count: 2, timeSigIndex: 2, realizedOrder: [1], realizedBars: 4 };
  const m = { schemaVersion: 2, slug: 's', takes: [
    makeTake({ take: 1, sampleRate: 48000, drums: { enabled: true, source: { type: 'sequence' }, sequence: seqA } }, 'x'),
    makeTake({ take: 2, sampleRate: 48000 }, 'x'),
  ] };
  const refs = referencedLoopFiles(m);
  ok('referencedLoopFiles includes folder-prefixed main loops', refs.has('verse/001.mid') && refs.has('verse/002.mid'));
  ok('referencedLoopFiles includes the intro', refs.has('in.mid'));
  ok('referencedLoopFiles omits a null outro', !refs.has(null) && refs.size === 3);
  // setDrumSequence freezes a pattern + spec onto a take.
  const flat = concatPatterns([mkPat(2), mkPat(2)]);
  const m2 = setDrumSequence(m, 2, seqA, flat);
  const t2 = m2.takes.find((t) => t.take === 2);
  eq('setDrumSequence enables drums', t2.drums.enabled, true);
  eq('setDrumSequence sets source sequence', t2.drums.source.type, 'sequence');
  eq('setDrumSequence stores the flattened bars', t2.drums.pattern.bars, 4);
  ok('setDrumSequence round-trips through validate', validateTake(t2).ok);
}

// ============================================================================
// 30. Drum sequencer — the NNN.mid loop-folder gate (Phase 2) + picker tripwires.
// ============================================================================
ok('LOOP_NAME_RE matches 001.mid', LOOP_NAME_RE.test('001.mid'));
ok('isLoopName 001.mid', isLoopName('001.mid'));
ok('isLoopName 010.midi', isLoopName('010.midi'));
ok('isLoopName rejects 2-digit', !isLoopName('01.mid'));
ok('isLoopName rejects 4-digit', !isLoopName('0001.mid'));
ok('isLoopName rejects a word name', !isLoopName('kick.mid'));
ok('isLoopName rejects a .wav', !isLoopName('001.wav'));
eq('loopNumber 010.mid = 10', loopNumber('010.mid'), 10);
eq('loopNumber of a bad name is null', loopNumber('x.mid'), null);
eq('sortLoopNames numeric order', sortLoopNames(['010.mid', '002.mid', '001.mid']).join(','), '001.mid,002.mid,010.mid');
{
  const good = validateLoopFolderNames(['002.mid', '001.mid', '003.mid']);
  ok('valid contiguous folder ok', good.ok && good.count === 3);
  const bad = validateLoopFolderNames(['001.mid', 'kick.mid']);
  ok('non-NNN name rejected', !bad.ok && bad.reason === 'names' && bad.offenders.join() === 'kick.mid');
  const gap = validateLoopFolderNames(['001.mid', '003.mid']);
  ok('a gap is rejected', !gap.ok && gap.reason === 'gaps');
  eq('gap reports the expected contiguous range', gap.expected, '001..002');
  ok('empty folder rejected', !validateLoopFolderNames([]).ok && validateLoopFolderNames([]).reason === 'empty');
  ok('two-digit name rejected', !validateLoopFolderNames(['10.mid']).ok);
}
// Picker + store tripwires (impure paths node can't execute).
{
  const lpSrc = readFileSync(here('./js/tape/loopPicker.js'), 'utf8');
  ok('loopPicker runs the pure NNN gate', lpSrc.includes('validateLoopFolderNames'));
  ok('loopPicker is NON-recursive (no directory descent)', !/handle\.kind === 'directory'/.test(lpSrc) && !lpSrc.includes('walkDir'));
  ok('loopPicker uses showDirectoryPicker with the sn-loops id', lpSrc.includes("showDirectoryPicker") && lpSrc.includes("id: 'sn-loops'"));
  ok('loopPicker filters the <input> fallback to the folder root', lpSrc.includes("rel.split('/').length <= 2"));
  const tsSrc = readFileSync(here('./js/tape/takeStore.js'), 'utf8');
  ok('takeStore exposes deleteSongLoops', tsSrc.includes('export async function deleteSongLoops'));
}

// ============================================================================
// 31. Drum sequencer — bundled starter rulesets load, validate, and are cached (Phase 6).
// ============================================================================
{
  const RS_IDS = readJSON('./assets/rulesets/index.json');
  eq('three starter rulesets shipped', RS_IDS.length, 3);
  for (const id of RS_IDS) {
    const r = readJSON('./assets/rulesets/' + id + '.json');
    ok('starter ruleset ' + id + ' validates', validateRuleset(r).ok);
    ok('starter ruleset ' + id + ' cached in sw', sw.includes('"./assets/rulesets/' + id + '.json"'));
    eq('starter ' + id + ' normalizes to a stable id', normalizeRuleset(r).id, id);
  }
  ok('one starter per family shipped', ['markov', 'weighted', 'sequential'].every((t) => RS_IDS.some((id) => readJSON('./assets/rulesets/' + id + '.json').type === t)));
  ok('rulesets index cached in sw', sw.includes('"./assets/rulesets/index.json"'));
  const rsSrc = readFileSync(here('./js/tape/rulesetStore.js'), 'utf8');
  ok('rulesetStore uses the sn_rulesets localStorage key', rsSrc.includes("'sn_rulesets'"));
  ok('rulesetStore validates before normalizing', rsSrc.includes('validateRuleset') && rsSrc.includes('normalizeRuleset'));
}

// ============================================================================
// 32. Drum sequencer — model-level locking of a recorded take (Phase 5, fixes M1).
// ============================================================================
{
  // click: bpm + timeSigIndex locked; the rest still editable.
  const storedClick = clampClickConfig({ enabled: true, bpm: 120, timeSigIndex: 2, subdivision: 1, accentIndex: 1 });
  const lockedClick = lockClickEdit(storedClick, { enabled: true, bpm: 200, timeSigIndex: 5, subdivision: 3, accentIndex: 0 });
  eq('lockClickEdit keeps the recorded bpm', lockedClick.bpm, 120);
  eq('lockClickEdit keeps the recorded timeSig', lockedClick.timeSigIndex, 2);
  eq('lockClickEdit still lets subdivision change', lockedClick.subdivision, 3);
  // drums: swing + pattern + source + sequence locked; kit/effect/master/voices editable.
  const seq = { folderName: 'v', loopFiles: ['001.mid'], algorithmId: 'x', count: 4, intro: null, outro: null, timeSigIndex: 2, realizedOrder: [1, 1, 1, 1], realizedBars: 8 };
  const storedDrums = clampDrumConfig({ enabled: true, kit: 'kit4', swing: 0.3, pattern: concatPatterns([mkPat(2)]), source: { type: 'sequence' }, sequence: seq });
  const lockedDrums = lockDrumEdit(storedDrums, { enabled: true, kit: 'jazzfunk', effect: 'room1', swing: 0.6, pattern: mkPat(1), source: { type: 'grid' }, sequence: null });
  eq('lockDrumEdit keeps the recorded swing', lockedDrums.swing, 0.3);
  eq('lockDrumEdit keeps the recorded pattern bars', lockedDrums.pattern.bars, 2);
  eq('lockDrumEdit keeps the frozen sequence', lockedDrums.sequence.realizedOrder.join(''), '1111');
  eq('lockDrumEdit keeps source sequence', lockedDrums.source.type, 'sequence');
  eq('lockDrumEdit still lets the kit change', lockedDrums.kit, 'jazzfunk');
  eq('lockDrumEdit still lets the effect change', lockedDrums.effect, 'room1');
}

// ============================================================================
// 33. Drum sequencer — wiring tripwires (impure record/playback/UI paths node can't run).
//     String-level guards so a refactor can't silently revert the integration.
// ============================================================================
{
  const capSrc = readFileSync(here('./js/tape/captureProcessor.js'), 'utf8');
  ok('capture worklet has an endFrame auto-stop gate', capSrc.includes('this.endFrame') && /currentFrame \+ i >= this\.endFrame/.test(capSrc));
  ok('capture worklet posts {op:ended} once at the gate', capSrc.includes("op: 'ended'") && capSrc.includes('this.endedPosted'));

  const aeSrc = readFileSync(here('./js/tape/audioEngine.js'), 'utf8');
  ok('record() accepts autoStopSec', /record\(\{[^}]*autoStopSec/.test(aeSrc));
  ok('record() sends endFrame in the begin message', /op: 'begin', beginFrame, endFrame/.test(aeSrc));
  ok('record() starts drums finite for a sequence (not always Infinity)', aeSrc.includes('autoStopSec != null ? autoStopSec : Infinity'));
  ok('engine auto-stops on the worklet ended signal', aeSrc.includes("op === 'ended'") && aeSrc.includes("stop('sequence-end')"));
  ok('play/bounce drive drums off the EXACT sequence length', aeSrc.includes('drumSequenceSeconds') && /seqSec > 0 \? seqSec/.test(aeSrc));
  ok('engine exposes previewPattern', /return\s*\{[^}]*\bpreviewPattern\b/.test(aeSrc));

  const mainSrc = readFileSync(here('./js/main.js'), 'utf8');
  ok('the roll is built BEFORE record() runs onPassOpen', mainSrc.indexOf('buildFrozenSequence(clickCfg)') > 0 && mainSrc.indexOf('buildFrozenSequence(clickCfg)') < mainSrc.indexOf('ensureTapeDeck().record('));
  ok('the roll injects Math.random into the pure realizer', /realizeSequence\([^)]*Math\.random\)/.test(mainSrc));
  ok('commit applies the model-level drum lock', mainSrc.includes('lockDrumEdit(t.drums'));
  ok('commit applies the model-level click lock', mainSrc.includes('lockClickEdit(t.click'));
  ok('Save copies referenced loop files', mainSrc.includes('referencedLoopFiles(next)') && mainSrc.includes('loopsRef(slug)'));
  ok('song delete cleans the loops dir', mainSrc.includes('deleteSongLoops'));

  const dpSrc = readFileSync(here('./js/tape/drumPanel.js'), 'utf8');
  ok('drum panel branches on sequence mode', dpSrc.includes("mode === 'sequence'") && dpSrc.includes('buildSequenceSection'));
  ok('drum panel exposes folder + algorithm + preview controls', dpSrc.includes('onPickLoopFolder') && dpSrc.includes('onSetAlgorithm') && dpSrc.includes('onPreviewSequence'));
  ok('drum panel exposes a time-signature selector', dpSrc.includes('onSetClick({ timeSigIndex'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
