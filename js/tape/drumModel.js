// js/tape/drumModel.js — PURE model for the tape deck's drum machine (drumbit-inspired,
// mono). No AudioContext, no DOM, no Date: the voice list + GM note map, the kit/effect
// enums, the multi-bar step-pattern schema + immutable transforms, the swing/step TIMING
// math, and the per-take drum-config clamp/validate. The audible engine
// (js/tape/drumMachine.js) and the sample loader (js/tape/drumKits.js) are impure; this
// file is node-importable so engine.test.js covers the math headlessly (mirrors
// clickModel.js / takeModel.js).
//
// It shares ONE bar-length source of truth with the click (barSeconds), so a drum bar-N
// downbeat coincides with the click/count-in bar-N downbeat — the record/playback/bounce
// sync depends on it. It must NOT import takeModel.js (takeModel imports THIS for the
// per-take `drums` field, so importing back would be a cycle); the master-strip settings
// clamp is therefore defined locally here and mirrors takeModel's clampStemSettings shape.

import { barSeconds } from './clickModel.js';
import { parseSMF } from './midiParse.js';

const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

export const STEPS_PER_BAR = 16;
export const MIN_BARS = 1;
export const MAX_BARS = 64;             // import cap: bounds a runaway file (64 bars is plenty)
export const SWING_MAX = 0.75;          // 1/3 = triplet feel; -> 1 collides the odd 16th with the next even
export const ON_VELOCITY = 100 / 127;   // default gain when hand-toggling a cell on

// The ~12 voices (drumbit's 8 + ride + clap + 2 congas). `gm` = the General-MIDI percussion
// note numbers that map to this voice on import. Any note not listed here is discarded (the
// user's stated responsibility to map their files to this kit). First match wins on overlap.
export const VOICES = [
  { id: 'kick', label: 'Kick', gm: [35, 36] },
  { id: 'snare', label: 'Snare', gm: [38, 40] },
  { id: 'closedHat', label: 'Closed Hat', gm: [42, 44] },
  { id: 'openHat', label: 'Open Hat', gm: [46] },
  { id: 'lowTom', label: 'Low Tom', gm: [41, 43, 45] },
  { id: 'midTom', label: 'Mid Tom', gm: [47, 48] },
  { id: 'highTom', label: 'High Tom', gm: [50] },
  { id: 'crash', label: 'Crash', gm: [49, 57] },
  { id: 'ride', label: 'Ride', gm: [51, 59, 53] },
  { id: 'clap', label: 'Clap', gm: [39] },
  { id: 'hiConga', label: 'Hi Conga', gm: [62, 63] },
  { id: 'loConga', label: 'Lo Conga', gm: [64] },
];
export const VOICE_IDS = VOICES.map((v) => v.id);

export const GM_NOTE_TO_VOICE = (() => {
  const m = {};
  for (const v of VOICES) for (const n of v.gm) if (!(n in m)) m[n] = v.id;
  return m;
})();
export function voiceForNote(note) {
  const v = GM_NOTE_TO_VOICE[note];
  return v === undefined ? null : v;
}

export const KITS = [
  { id: 'kit4', label: 'Kit 4' },
  { id: 'jazzfunk', label: 'Jazz Funk Kit' },
  { id: 'abeyroad', label: 'Abey Road Drums' },
  { id: 'currentz', label: 'Currentz Drums Vol2' },
  { id: 'demarco', label: 'Demarco Drums 3' },
  { id: 'fleetwood', label: 'Fleetwood Drums Vol2' },
  { id: 'harvest', label: 'Harvest Drums Vol 2' },
  { id: 'seachange', label: 'Sea Change Drums' },
  { id: 'wreckingcrew', label: '60s Wrecking Crew Drums' },
];
export const KIT_IDS = KITS.map((k) => k.id);

// The "effects" pulldown (drumbit's convolution reverbs + lo-fi voicings) as a master
// insert. kind 'ir' = ConvolverNode with a bundled impulse WAV; kind 'biquad' = a filter
// chain (telephone/intercom/muffler need no IR file); 'none' = dry.
export const EFFECTS = [
  { id: 'none', label: 'No Effect', kind: 'none' },
  { id: 'room1', label: 'Room 1', kind: 'ir', file: 'room1.wav' },
  { id: 'room2', label: 'Room 2', kind: 'ir', file: 'room2.wav' },
  { id: 'mediumHall1', label: 'Medium Hall 1', kind: 'ir', file: 'mediumhall1.wav' },
  { id: 'mediumHall2', label: 'Medium Hall 2', kind: 'ir', file: 'mediumhall2.wav' },
  { id: 'largeHall', label: 'Large Hall', kind: 'ir', file: 'largehall.wav' },
  { id: 'spring', label: 'Spring Reverb', kind: 'ir', file: 'spring.wav' },
  { id: 'studio', label: 'Studio', kind: 'ir', file: 'studio.wav' },
  { id: 'underground', label: 'Underground', kind: 'ir', file: 'underground.wav' },
  { id: 'telephone', label: 'Telephone', kind: 'biquad' },
  { id: 'intercom', label: 'Intercom', kind: 'biquad' },
  { id: 'muffler', label: 'Muffler', kind: 'biquad' },
];
export const EFFECT_IDS = EFFECTS.map((e) => e.id);

// ---- timing math (drift-free: everything is a function of the absolute step ordinal n) ----

// One of 16 EQUAL divisions of the bar (NOT a literal sixteenth): keeps the drum bar exactly
// one click bar in any meter, so downbeats coincide. In 4/4 it IS a sixteenth.
export function stepSeconds(bpm, timeSigIndex) {
  return barSeconds(bpm, timeSigIndex) / STEPS_PER_BAR;
}

// Absolute time (s) of step ordinal n from pattern t0. 16th swing DELAYS odd steps only —
// even steps stay dead-on the click grid, so sample-lock to the click holds by construction.
// Because 16 is even, n's parity == the in-bar step parity, so swing is identical every bar
// and a full bar's swing cancels: hitTime(n+16) - hitTime(n) === barSeconds exactly.
export function hitTime(n, bpm, timeSigIndex, swing) {
  const s = stepSeconds(bpm, timeSigIndex);
  const sw = clampNum(swing, 0, SWING_MAX, 0);
  return n * s + ((n % 2 === 1) ? sw * s : 0);
}

// The pattern cell an absolute ordinal maps to (the pattern loops every barCount bars).
export function cellOf(n, barCount) {
  const bc = Math.max(1, Math.floor(barCount) || 1);
  return { patternBar: Math.floor(n / STEPS_PER_BAR) % bc, step: n % STEPS_PER_BAR };
}

export function velocityFromMidi(v) {
  return clampNum(v, 0, 127, 0) / 127;
}

// Quantize an absolute MIDI tick to the nearest global 16th-step index (tempo-independent).
export function quantizeTick(tick, ppq) {
  const per16 = ppq / 4;
  return per16 > 0 ? Math.round(tick / per16) : 0;
}

// Enumerate every drum hit in [0, durationSec) as {voice, timeSec, velocity}. Finite +
// deterministic (loops the pattern), so the offline bounce and the unit tests share it.
export function drumHitsUntil(config, bpm, timeSigIndex, durationSec) {
  const cfg = clampDrumConfig(config);
  const total = cfg.pattern.bars * STEPS_PER_BAR;
  const grid = cfg.pattern.grid;
  const s = stepSeconds(bpm, timeSigIndex);
  const hits = [];
  if (!(durationSec > 0) || !(s > 0)) return hits;
  for (let n = 0; ; n++) {
    const t = hitTime(n, bpm, timeSigIndex, cfg.swing);
    if (t >= durationSec) break;
    const idx = n % total;
    for (const id of VOICE_IDS) {
      const vel = grid[id] ? grid[id][idx] : 0;
      if (vel > 0) hits.push({ voice: id, timeSec: t, velocity: vel });
    }
  }
  return hits;
}

// ---- per-take drum config: default / clamp / validate (mirrors clickModel's trio) ----

const EQ_MIN = -12, EQ_MAX = 12;
// Local master-strip clamp — the SAME {vol,eq,comp} shape as takeModel.clampStemSettings,
// duplicated (not imported) to avoid a takeModel <-> drumModel import cycle.
function clampMaster(m) {
  const s = m || {}, eq = s.eq || {};
  return {
    vol: clampNum(s.vol, 0, 1.5, 1.0),
    eq: {
      bass: clampNum(eq.bass, EQ_MIN, EQ_MAX, 0),
      mid: clampNum(eq.mid, EQ_MIN, EQ_MAX, 0),
      treble: clampNum(eq.treble, EQ_MIN, EQ_MAX, 0),
    },
    comp: clampNum(s.comp, 0, 1, 0),
  };
}
export function defaultMaster() { return clampMaster({}); }

function defaultVoiceSettings() {
  const v = {};
  for (const id of VOICE_IDS) v[id] = { vol: 1.0, pitch: 1.0 };
  return v;
}
function clampVoices(vsrc) {
  const src = vsrc || {};
  const out = {};
  for (const id of VOICE_IDS) {
    const v = src[id] || {};
    out[id] = { vol: clampNum(v.vol, 0, 1.5, 1.0), pitch: clampNum(v.pitch, 0.25, 4, 1.0) };
  }
  return out;
}

export function emptyGrid(bars) {
  const b = clampInt(bars, MIN_BARS, MAX_BARS, MIN_BARS);
  const g = {};
  for (const id of VOICE_IDS) g[id] = new Array(b * STEPS_PER_BAR).fill(0);
  return g;
}

function clampGrid(gsrc, bars) {
  const len = bars * STEPS_PER_BAR;
  const src = gsrc || {};
  const g = {};
  for (const id of VOICE_IDS) {
    const arr = Array.isArray(src[id]) ? src[id] : [];
    const out = new Array(len).fill(0);
    for (let i = 0; i < len; i++) out[i] = clampNum(arr[i], 0, 1, 0);
    g[id] = out;
  }
  return g;
}

// The DISABLED schema baseline (like defaultClickConfig): a legacy take with no `drums`
// normalizes to this (no drums silently gained). "Default ON" is a UI default in main.js.
export function defaultDrumConfig() {
  return {
    enabled: false,
    kit: 'kit4',
    effect: 'none',
    effectMix: 0,
    swing: 0,
    master: defaultMaster(),
    voices: defaultVoiceSettings(),
    pattern: { bars: 1, steps: STEPS_PER_BAR, grid: emptyGrid(1) },
    source: { type: 'grid' },
  };
}

export function clampDrumConfig(c) {
  const src = c || {};
  const p = src.pattern || {};
  const bars = clampInt(p.bars, MIN_BARS, MAX_BARS, 1);
  const isMidi = !!(src.source && src.source.type === 'midi');
  const source = isMidi
    ? { type: 'midi', ...(src.source && typeof src.source.midiFile === 'string' ? { midiFile: src.source.midiFile } : {}) }
    : { type: 'grid' };
  return {
    enabled: !!src.enabled,
    kit: KIT_IDS.includes(src.kit) ? src.kit : 'kit4',
    effect: EFFECT_IDS.includes(src.effect) ? src.effect : 'none',
    effectMix: clampNum(src.effectMix, 0, 1, 0),
    swing: clampNum(src.swing, 0, SWING_MAX, 0),
    master: clampMaster(src.master),
    voices: clampVoices(src.voices),
    pattern: { bars, steps: STEPS_PER_BAR, grid: clampGrid(p.grid, bars) },
    source,
  };
}

// Lightweight additive validation (like the click block in takeModel.validateTake): a
// present `drums` must be an object with a boolean `enabled`; known enums when supplied.
export function validateDrumConfig(c) {
  if (c == null || typeof c !== 'object' || Array.isArray(c)) return { ok: false, errors: ['drums must be an object'] };
  const errors = [];
  if (typeof c.enabled !== 'boolean') errors.push('drums enabled must be a boolean');
  if ('kit' in c && !KIT_IDS.includes(c.kit)) errors.push('drums kit must be a known kit');
  if ('effect' in c && !EFFECT_IDS.includes(c.effect)) errors.push('drums effect must be a known effect');
  if ('swing' in c && !(typeof c.swing === 'number' && isFinite(c.swing))) errors.push('drums swing must be a number');
  if (c.pattern != null) {
    if (typeof c.pattern !== 'object') errors.push('drums pattern must be an object');
    else if (!(typeof c.pattern.bars === 'number' && c.pattern.bars >= 1)) errors.push('drums pattern.bars must be >= 1');
  }
  return { ok: errors.length === 0, errors };
}

// ---- immutable pattern transforms (index-keyed edits, like songs.js) ----

export function toggleCell(config, voiceId, globalStep) {
  const cfg = clampDrumConfig(config);
  const arr = cfg.pattern.grid[voiceId];
  if (!arr || globalStep < 0 || globalStep >= arr.length) return cfg;
  const next = arr.slice();
  next[globalStep] = next[globalStep] > 0 ? 0 : ON_VELOCITY;
  return { ...cfg, pattern: { ...cfg.pattern, grid: { ...cfg.pattern.grid, [voiceId]: next } } };
}

export function setCellVelocity(config, voiceId, globalStep, vel) {
  const cfg = clampDrumConfig(config);
  const arr = cfg.pattern.grid[voiceId];
  if (!arr || globalStep < 0 || globalStep >= arr.length) return cfg;
  const next = arr.slice();
  next[globalStep] = clampNum(vel, 0, 1, 0);
  return { ...cfg, pattern: { ...cfg.pattern, grid: { ...cfg.pattern.grid, [voiceId]: next } } };
}

// Grow/shrink the pattern to `bars` bars, preserving existing cells (pad with 0 / truncate).
export function setBars(config, bars) {
  const cfg = clampDrumConfig(config);
  const nb = clampInt(bars, MIN_BARS, MAX_BARS, cfg.pattern.bars);
  const len = nb * STEPS_PER_BAR;
  const grid = {};
  for (const id of VOICE_IDS) {
    const old = cfg.pattern.grid[id] || [];
    const out = new Array(len).fill(0);
    for (let i = 0, m = Math.min(len, old.length); i < m; i++) out[i] = old[i];
    grid[id] = out;
  }
  return { ...cfg, pattern: { bars: nb, steps: STEPS_PER_BAR, grid } };
}

// ---- MIDI import: SMF bytes -> a drum pattern on THIS kit's voices ----
// Maps GM note-ons to voices, quantizes ticks to 16th steps, keeps the LOUDEST hit per cell,
// and derives the bar count. Unmapped notes (and notes beyond the import cap) are collected
// in `discarded` (surfaced in the UI). Returns { pattern, ppq, mappedCount, discarded }.
export function smfToPattern(bytes) {
  const { ppq, tracks } = parseSMF(bytes);
  const per16 = ppq / 4;
  const cap = MAX_BARS * STEPS_PER_BAR;
  const cells = {};            // voiceId -> Map(globalStep -> gain)
  const discarded = [];
  let mapped = 0, maxStep = 0;
  for (const events of tracks) {
    for (const e of events) {
      if (e.type !== 'noteOn') continue;
      const voice = voiceForNote(e.note);
      if (!voice) { discarded.push({ note: e.note, tick: e.tick }); continue; }
      const step = per16 > 0 ? Math.round(e.tick / per16) : 0;
      if (step >= cap) { discarded.push({ note: e.note, tick: e.tick }); continue; }
      mapped++;
      if (step > maxStep) maxStep = step;
      const g = velocityFromMidi(e.velocity);
      const m = cells[voice] || (cells[voice] = new Map());
      if (!m.has(step) || g > m.get(step)) m.set(step, g);
    }
  }
  const bars = Math.max(MIN_BARS, Math.min(MAX_BARS, Math.floor(maxStep / STEPS_PER_BAR) + 1));
  const len = bars * STEPS_PER_BAR;
  const grid = {};
  for (const id of VOICE_IDS) {
    const out = new Array(len).fill(0);
    const m = cells[id];
    if (m) for (const [step, g] of m) if (step < len) out[step] = g;
    grid[id] = out;
  }
  return { pattern: { bars, steps: STEPS_PER_BAR, grid }, ppq, mappedCount: mapped, discarded };
}
