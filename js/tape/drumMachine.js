// js/tape/drumMachine.js — IMPURE drum voice graph + step scheduler (mirrors click.js).
// Browser-only; never imported by engine.test.js. Plays a per-take drum PATTERN as
// monitor/backing during record and take playback, and renders it into the offline bounce.
//
// Signal path (one bus, MONO like the rest of the app):
//   per hit: BufferSource(playbackRate = voice.pitch) -> Gain(velocity * voice.vol)
//     -> inBus -> vol -> lowshelf/peaking/highshelf EQ -> DynamicsCompressor -> makeup
//     -> effect insert (dry + wet: convolver reverb | biquad lo-fi) -> AnalyserNode tap
//     -> dest   (the deck's monitor/sum bus, supplied by audioEngine)
//
// Timing is drift-free: every hit time is the pure absolute-ordinal hitTime(n, …) from
// drumModel.js, scheduled on the Web Audio clock with a Chris-Wilson lookahead (same idiom
// as click.js). The offline variant (renderDrumsOffline) pre-schedules every hit via the
// pure drumHitsUntil, so the bounce is deterministic. The compressor is ALWAYS in circuit
// (compressorParams(0) neutral at detent 0, D17) so the drum bus carries the same fixed
// latency as the recorded stems and stays sample-locked in the bounce.

import { VOICE_IDS, hitTime, drumHitsUntil, STEPS_PER_BAR, EFFECTS } from './drumModel.js';
import { compressorParams, EQ_BANDS } from './takeModel.js';

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

// The lo-fi "effect" voicings (telephone/intercom/muffler) as biquad chains (no IR file).
function buildBiquadEffect(actx, effectId) {
  const input = actx.createGain(), output = actx.createGain();
  const mk = (type, freq, q, gain) => {
    const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    if (q != null) f.Q.value = q; if (gain != null) f.gain.value = gain; return f;
  };
  let chain;
  if (effectId === 'telephone') chain = [mk('highpass', 500, 0.7), mk('lowpass', 3000, 0.7), mk('peaking', 1700, 2, 6)];
  else if (effectId === 'intercom') chain = [mk('highpass', 700, 0.9), mk('lowpass', 2200, 0.9), mk('peaking', 1400, 3, 8)];
  else if (effectId === 'muffler') chain = [mk('highpass', 120, 0.7), mk('lowpass', 1400, 0.7)];
  else chain = [actx.createGain()];
  let node = input;
  for (const f of chain) { node.connect(f); node = f; }
  node.connect(output);
  return { input, output };
}

function applyCompNode(comp, makeup, actx, compAmt, live) {
  const cp = compressorParams(compAmt || 0);
  comp.threshold.value = cp.threshold; comp.ratio.value = cp.ratio; comp.knee.value = cp.knee;
  comp.attack.value = cp.attack; comp.release.value = cp.release;
  const g = Math.pow(10, cp.makeupDb / 20);
  if (live) makeup.gain.setTargetAtTime(g, actx.currentTime, 0.01); else makeup.gain.value = g;
}

function scheduleVoice(actx, buffers, voices, voiceId, velocity, when, dest) {
  const buf = buffers[voiceId];
  if (!buf || !(velocity > 0)) return;
  const v = voices[voiceId] || {};
  const src = actx.createBufferSource();
  src.buffer = buf; src.playbackRate.value = v.pitch != null ? v.pitch : 1;
  const g = actx.createGain();
  g.gain.value = Math.max(0, Math.min(1.5, velocity * (v.vol != null ? v.vol : 1)));
  src.connect(g); g.connect(dest); src.start(when);
}

// Build the master strip + effect insert into `actx`, connect to `dest`, return the input
// bus + the live-control node handles (used by the realtime machine; offline ignores them).
function buildStrip(actx, dest) {
  const inBus = actx.createGain();
  const volGain = actx.createGain();
  const eqNodes = EQ_BANDS.map((b) => {
    const f = actx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.freq;
    if (b.Q != null) f.Q.value = b.Q; f.gain.value = 0; return f;
  });
  const comp = actx.createDynamicsCompressor();
  const makeup = actx.createGain();
  const effectIn = actx.createGain();
  const dryGain = actx.createGain();
  const effectOut = actx.createGain();
  const tap = actx.createAnalyser(); tap.fftSize = 2048;
  inBus.connect(volGain);
  let node = volGain;
  for (const f of eqNodes) { node.connect(f); node = f; }
  node.connect(comp); comp.connect(makeup); makeup.connect(effectIn);
  effectIn.connect(dryGain); dryGain.connect(effectOut);
  effectOut.connect(tap); effectOut.connect(dest);
  return { inBus, volGain, eqNodes, comp, makeup, effectIn, dryGain, effectOut, tap };
}

// Wire an effect's wet path onto a strip's effectIn/dryGain/effectOut (rebuilds each call).
function wireEffect(actx, strip, effectId, irBuffer, mix, wetStore) {
  const prev = wetStore.node, prevWet = wetStore.wetGain;
  try { if (prevWet) prevWet.disconnect(); } catch { /* ignore */ }
  try { if (prev && prev.disconnect) prev.disconnect(); } catch { /* ignore */ }
  const eff = EFFECTS.find((e) => e.id === effectId) || EFFECTS[0];
  const m = Math.max(0, Math.min(1, mix != null ? mix : 0));
  if (eff.kind === 'ir' && irBuffer) {
    const wetGain = actx.createGain(); wetGain.gain.value = m;
    const conv = actx.createConvolver(); conv.buffer = irBuffer; conv.normalize = true;
    strip.effectIn.connect(wetGain); wetGain.connect(conv); conv.connect(strip.effectOut);
    strip.dryGain.gain.value = 1;                    // reverb send: dry stays full
    wetStore.node = conv; wetStore.wetGain = wetGain;
  } else if (eff.kind === 'biquad') {
    const wetGain = actx.createGain(); wetGain.gain.value = m;
    const chain = buildBiquadEffect(actx, eff.id);
    strip.effectIn.connect(wetGain); wetGain.connect(chain.input); chain.output.connect(strip.effectOut);
    strip.dryGain.gain.value = 1 - m;                // insert crossfade: clean <-> filtered
    wetStore.node = chain; wetStore.wetGain = wetGain;
  } else {
    strip.dryGain.gain.value = 1;                    // 'none'
    wetStore.node = null; wetStore.wetGain = null;
  }
}

// A live drum machine bound to one AudioContext + monitor bus.
export function makeDrumMachine({ ctx, dest }) {
  const strip = buildStrip(ctx, dest);
  const wetStore = { node: null, wetGain: null };
  let buffers = {}, voices = {};
  let bpm = 120, timeSigIndex = 2, swing = 0, pattern = { bars: 1, grid: {} };
  let timer = null, running = false;

  function applyMaster(m) {
    const s = m || {};
    strip.volGain.gain.setTargetAtTime(s.vol != null ? s.vol : 1, ctx.currentTime, 0.01);
    const eq = s.eq || {};
    strip.eqNodes[0].gain.setTargetAtTime(eq.bass || 0, ctx.currentTime, 0.01);
    strip.eqNodes[1].gain.setTargetAtTime(eq.mid || 0, ctx.currentTime, 0.01);
    strip.eqNodes[2].gain.setTargetAtTime(eq.treble || 0, ctx.currentTime, 0.01);
    applyCompNode(strip.comp, strip.makeup, ctx, s.comp || 0, true);
  }
  function setEffect(effectId, irBuffer, mix) { wireEffect(ctx, strip, effectId, irBuffer, mix, wetStore); }
  function applyVoice(id, patch) { voices[id] = { ...(voices[id] || {}), ...(patch || {}) }; }

  // load a take's drum config + its decoded kit buffers + (optional) effect IR.
  function load(opts) {
    buffers = opts.buffers || {};
    const cfg = opts.config || {};
    voices = cfg.voices || {};
    bpm = opts.bpm || 120;
    timeSigIndex = opts.timeSigIndex != null ? opts.timeSigIndex : 2;
    swing = cfg.swing || 0;
    pattern = cfg.pattern || { bars: 1, grid: {} };
    applyMaster(cfg.master);
    setEffect(cfg.effect || 'none', opts.irBuffer || null, cfg.effectMix || 0);
  }

  const totalSteps = () => Math.max(1, pattern.bars || 1) * STEPS_PER_BAR;

  // Realtime lookahead: schedule from pattern t0 = startAt for durationSec (Infinity while
  // recording). Every hit lands on startAt + hitTime(n) (drift-free); the loop keeps counting
  // n, so the pattern seam never skips or duplicates a step.
  function start(startAt, durationSec) {
    stop();
    running = true;
    const total = totalSteps(), grid = pattern.grid || {};
    const end = isFinite(durationSec) ? startAt + durationSec : Infinity;
    let n = 0;
    const tick = () => {
      if (!running) return;
      while (true) {
        const t = startAt + hitTime(n, bpm, timeSigIndex, swing);
        if (t >= ctx.currentTime + SCHEDULE_AHEAD) break;
        if (t >= end) { running = false; return; }
        const idx = n % total;
        for (const id of VOICE_IDS) { const vel = grid[id] ? grid[id][idx] : 0; if (vel > 0) scheduleVoice(ctx, buffers, voices, id, vel, t, strip.inBus); }
        n++;
      }
      timer = setTimeout(tick, LOOKAHEAD_MS);
    };
    tick();
  }

  function stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } }
  function dispose() { stop(); try { strip.inBus.disconnect(); strip.effectOut.disconnect(); } catch { /* ignore */ } }

  return { load, applyMaster, setEffect, applyVoice, start, stop, dispose, tap: strip.tap, inBus: strip.inBus };
}

// Offline bounce: build a static strip in `offlineCtx`, pre-schedule EVERY hit up front
// (no wall clock), summing into `dest`. Deterministic because all hits come from the pure
// drumHitsUntil. opts: { config, buffers, irBuffer, bpm, timeSigIndex, startAt, durationSec }.
export function renderDrumsOffline(offlineCtx, dest, opts) {
  const cfg = opts.config || {};
  const strip = buildStrip(offlineCtx, dest);
  const eq = (cfg.master && cfg.master.eq) || {};
  strip.volGain.gain.value = (cfg.master && cfg.master.vol != null) ? cfg.master.vol : 1;
  strip.eqNodes[0].gain.value = eq.bass || 0;
  strip.eqNodes[1].gain.value = eq.mid || 0;
  strip.eqNodes[2].gain.value = eq.treble || 0;
  applyCompNode(strip.comp, strip.makeup, offlineCtx, (cfg.master && cfg.master.comp) || 0, false);
  wireEffect(offlineCtx, strip, cfg.effect || 'none', opts.irBuffer || null, cfg.effectMix || 0, { node: null, wetGain: null });
  const bpm = opts.bpm || 120, ts = opts.timeSigIndex != null ? opts.timeSigIndex : 2;
  const startAt = opts.startAt || 0;
  const buffers = opts.buffers || {}, voices = cfg.voices || {};
  for (const h of drumHitsUntil(cfg, bpm, ts, opts.durationSec || 0)) {
    scheduleVoice(offlineCtx, buffers, voices, h.voice, h.velocity, startAt + h.timeSec, strip.inBus);
  }
}
