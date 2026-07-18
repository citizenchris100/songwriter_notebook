// js/tape/latency.js — PURE round-trip-latency detection + statistics for the
// overdub calibration (§ measured, not guessed). No DOM / audio / storage, so
// engine.test.js loads it directly and it is the correctness gate for the feature.
//
// The calibration (js/tape/audioEngine.js calibrateLatency) plays a sharp click
// through the real playback chain at a known context-clock frame and captures the
// input; these helpers find the returning click in the captured samples and reduce
// several noisy trials to one robust number. Round trip is measured, never read
// from AudioContext.outputLatency (unreliable / absent on iPadOS < 18.4) — see the
// research in the plan. RTL is applied verbatim as the capture-gate offset
// (monitorLatencySec): a note played with backing sample N lands at capture sample N.

const isNum = (x) => typeof x === 'number' && isFinite(x);

// Plausible round-trip band for a USB interface in a browser (§: browsers add
// ~20-40 ms typical, sub-5 ms only with pro drivers). Anything outside this is a
// mis-detection (a noise blip, or the loopback isn't connected).
export const PLAUSIBLE_RTT_MIN = 0.001; // 1 ms
export const PLAUSIBLE_RTT_MAX = 0.5;   // 500 ms
export const MIN_GOOD_TRIALS = 3;

export function isPlausibleRtt(sec) {
  return isNum(sec) && sec >= PLAUSIBLE_RTT_MIN && sec <= PLAUSIBLE_RTT_MAX;
}

// A low-percentile of |samples| — a robust noise-floor estimate (the buffer is
// mostly silence, so the median absolute value tracks the floor, not the click).
function percentileAbs(samples, p) {
  const n = samples.length;
  if (!n) return 0;
  const abs = new Float64Array(n);
  for (let i = 0; i < n; i++) abs[i] = Math.abs(samples[i]);
  abs.sort();
  const idx = Math.max(0, Math.min(n - 1, Math.floor(p * (n - 1))));
  return abs[idx];
}

// Find the returning click's ONSET sample in a captured buffer, or -1 if no click
// is present (peak below `minPeak`). Strategy: locate the global peak (the click),
// estimate the noise floor from the median |sample|, then walk FORWARD to the first
// sample that crosses a threshold set to the larger of (floor · factor) and
// (peak · onsetFrac) — so neither room noise nor a soft pre-echo false-triggers, and
// the returned index is the leading edge (better timing than the peak itself).
export function detectClickSample(samples, opts = {}) {
  const n = samples.length;
  if (!n) return -1;
  const minPeak = opts.minPeak != null ? opts.minPeak : 0.02;
  const factor = opts.factor != null ? opts.factor : 8;
  const onsetFrac = opts.onsetFrac != null ? opts.onsetFrac : 0.25;

  let peak = 0, peakIdx = -1;
  for (let i = 0; i < n; i++) { const a = Math.abs(samples[i]); if (a > peak) { peak = a; peakIdx = i; } }
  if (peak < minPeak) return -1; // nothing loud enough came back — loopback/level problem

  const floor = percentileAbs(samples, 0.5);
  const thresh = Math.max(floor * factor, peak * onsetFrac);
  for (let i = 0; i <= peakIdx; i++) if (Math.abs(samples[i]) >= thresh) return i;
  return peakIdx;
}

// Round trip in seconds: the captured onset's absolute context frame minus the
// frame the click was emitted at, over the sample rate. Both frames are on the one
// AudioContext sample clock, so no output/input-latency API is involved.
export function rttSeconds(onsetAbsFrame, emitFrame, rate) {
  if (!isNum(onsetAbsFrame) || !isNum(emitFrame) || !isNum(rate) || rate <= 0) return NaN;
  return (onsetAbsFrame - emitFrame) / rate;
}

export function median(nums) {
  const xs = nums.filter(isNum).slice().sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Reduce per-trial RTTs (nulls = failed detections) to one robust result: keep only
// plausible values, require a quorum, report the median plus the min-max spread as a
// confidence hint. The median rejects GC/scheduling-jitter outliers a mean wouldn't.
export function summarizeTrials(trials) {
  const good = (trials || []).filter(isPlausibleRtt);
  if (good.length < MIN_GOOD_TRIALS) {
    return { ok: false, medianSec: null, spreadMs: null, count: good.length, reason: 'Not enough clean measurements — check the loopback and turn the input up a little.' };
  }
  const medianSec = median(good);
  const spreadMs = (Math.max.apply(null, good) - Math.min.apply(null, good)) * 1000;
  return { ok: true, medianSec, spreadMs, count: good.length, reason: null };
}
