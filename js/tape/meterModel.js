// js/tape/meterModel.js — PURE metering math for the tape deck's LED ladders:
// peak→segment mapping, meter ballistics (fall/decay), and the clip-latch state
// machine. No DOM, no audio, no Date, no crypto — node-importable, so
// engine.test.js loads it directly (the same pure-core discipline as takeModel.js).
//
// The ladders are driven from raw linear peaks: the capture worklet's per-batch
// peaks while recording, AnalyserNode time-domain peaks while playing. The display
// layer (js/tape/deckControls.js buildLedMeter) is deliberately dumb — it just sets
// a --lit fraction and toggles a clip class. All the shaping lives here so it is
// testable and shared by BOTH the capture and playback paths:
//   - peakToSegments / peakToLit: linear 0..1 peak -> dB-spaced lit-segment count
//   - decayPeak: meter ballistics — instant attack, smooth fall between frames
//   - clipState: a hold-latch so a momentary overload stays visibly red

// Clip threshold — a sample at or above this is "clipping". Shared verbatim by the
// capture meter (js/main.js) and the playback taps (js/tape/audioEngine.js) so the
// red flip means the same thing no matter which path feeds the meter.
export const CLIP_THRESHOLD = 0.98;

// The number of LED segments per ladder — shared by the display (deckControls.js
// buildLedMeter) and the peak→lit math (js/main.js merge layer) so they agree.
export const METER_SEGMENTS = 12;

// The ladder spans METER_TOP_DB (near full-scale) down to METER_FLOOR_DB. dB-spaced
// so the quiet end has resolution like a real LED meter, not a linear bar.
export const METER_TOP_DB = -1;
export const METER_FLOOR_DB = -40;

// Meter ballistics: a louder peak shows instantly; a quieter one is approached by
// falling this many dB per second (classic peak-meter decay).
export const FALL_DB_PER_SEC = 20;

// Clip latch hold — once a clip is seen, hold the red state this long so a
// single-frame overload can't flicker past unseen.
export const CLIP_HOLD_MS = 400;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A linear peak (0..1, time-domain abs max) -> number of lit segments (0..count) on
// a dB-spaced ladder. 0/negative -> 0; >= METER_TOP_DB -> count; in between maps
// linearly in dB across the segments (ceil so any audible signal lights >= 1).
export function peakToSegments(peak, count) {
  const n = Math.max(1, Math.round(count) || 12);
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, peak)); // <= 0 dBFS
  if (db <= METER_FLOOR_DB) return 0;
  if (db >= METER_TOP_DB) return n;
  const frac = (db - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB); // 0..1
  return clamp(Math.ceil(frac * n), 1, n);
}

// The lit FRACTION (0..1) for the CSS --lit variable — dB-spaced and quantized to
// segment boundaries, so the ladder steps like LEDs rather than sliding.
export function peakToLit(peak, count) {
  const n = Math.max(1, Math.round(count) || 12);
  return peakToSegments(peak, n) / n;
}

// Meter ballistics: INSTANT attack (a louder incoming peak shows immediately), smooth
// fall (the displayed value decays toward a quieter incoming peak at FALL_DB_PER_SEC).
// `displayed`/`incoming` are linear 0..1; dtMs is ms since the last update.
export function decayPeak(displayed, incoming, dtMs) {
  const inc = clamp(incoming || 0, 0, 1);
  const cur = clamp(displayed || 0, 0, 1);
  if (inc >= cur) return inc;         // instant attack
  if (cur <= 0) return 0;
  const fallDb = FALL_DB_PER_SEC * (Math.max(0, dtMs) / 1000);
  const floor = cur * Math.pow(10, -fallDb / 20); // fall by fallDb from the current level
  return Math.max(inc, floor);
}

// Clip latch: once a clipping peak arrives, hold the clip state until nowMs + holdMs so
// a single-frame overload doesn't flicker past. `prev` is the previous {clipped, until}
// (or null); nowMs is a monotonic clock the CALLER supplies (this module stays
// Date-free). Returns the next {clipped, until}.
export function clipState(prev, peak, nowMs, holdMs = CLIP_HOLD_MS) {
  const clipping = (peak || 0) >= CLIP_THRESHOLD;
  const until = prev && prev.until ? prev.until : 0;
  if (clipping) return { clipped: true, until: nowMs + holdMs };
  if (nowMs < until) return { clipped: true, until };
  return { clipped: false, until: 0 };
}
