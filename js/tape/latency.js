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

// The DynamicsCompressor's fixed lookahead (~6 ms), present on the monitored drum/overdub
// backing bus during record (it adds to how late the performer hears the beat). Counted ONCE —
// the backing passes through exactly one compressor before the output.
export const COMP_LOOKAHEAD_SEC = 0.006;

// A latency figure is usable only if finite, POSITIVE, and below the plausible-round-trip ceiling
// — so an undefined / 0 / absurd device report degrades to a fallback instead of corrupting the sum.
const usableLatency = (x) => isNum(x) && x > 0 && x < PLAUSIBLE_RTT_MAX;

// Best-effort round trip from the LIVE context, for an UNCALIBRATED overdub / drum-backed take.
// `outputLatency` (AudioContext.outputLatency — the OS+device output path) is the drums-to-ears
// proxy; `baseLatency` is only a floor fallback when outputLatency is unusable. `inputLatency`
// (MediaTrackSettings.latency, often absent/coarse) is the DI-to-worklet proxy; when unusable we
// assume input ≈ output (matched USB buffering) — this symmetric term is the dominant residual
// uncertainty. Plus one compressor lookahead. Returns 0 when there is NO usable data, so a
// data-less context records uncompensated (deterministic) rather than guessing a full default and
// risking pulling the take EARLY. Clamped to the plausible round-trip band.
export function estimateMonitorLatencySec({ outputLatency, baseLatency, inputLatency } = {}) {
  const out = usableLatency(outputLatency) ? outputLatency : (usableLatency(baseLatency) ? baseLatency : 0);
  if (out <= 0) return 0;                                        // no usable output-path latency -> no compensation
  const inp = usableLatency(inputLatency) ? inputLatency : out; // symmetric fallback (the weakest term)
  const rtt = out + COMP_LOOKAHEAD_SEC + inp;
  return Math.max(PLAUSIBLE_RTT_MIN, Math.min(PLAUSIBLE_RTT_MAX, rtt));
}

// The single capture-gate-offset resolution point. A measured (loopback) or manual value is
// AUTHORITATIVE and returned verbatim (the user's own number wins, even 0); otherwise fall back
// to the live estimate; otherwise 0. Called by audioEngine.record() with the live ctx + track.
export function resolveMonitorLatencySec({ source, storedSec, outputLatency, baseLatency, inputLatency } = {}) {
  if ((source === 'measured' || source === 'manual') && isNum(storedSec)) return storedSec;
  return estimateMonitorLatencySec({ outputLatency, baseLatency, inputLatency });
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
