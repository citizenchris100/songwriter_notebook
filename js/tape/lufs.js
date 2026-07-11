// js/tape/lufs.js — PURE ITU-R BS.1770 integrated loudness measurement, fixed to
// 48 kHz coefficients (bounce always renders at 48 kHz, D27 — this module never
// needs a per-rate coefficient branch). Two cascaded biquads (K-weighting: a
// high-shelf "head" pre-filter, then a high-pass "RLB" filter), 400 ms blocks at
// 75% overlap, absolute (−70 LUFS) + relative (−10 LU) gating. No DOM/Worker —
// node-importable so engine.test.js can assert a synthesized tone lands near its
// target LUFS and silence measures −Infinity.

// BS.1770-4 Annex 1 K-weighting coefficients at 48 kHz.
const PRE = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const RLB = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };

// Direct Form I biquad, in place over a copy (does not mutate the input).
function biquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

function kWeight(x) {
  return biquad(biquad(x, PRE), RLB);
}

const BLOCK_SEC = 0.400;
const HOP_SEC = 0.100;   // 400 ms blocks at 75% overlap

// Integrated loudness (LKFS/LUFS) of same-length Float32 channel arrays (mono or
// stereo; both get channel weight 1.0 — BS.1770's surround weights don't apply
// here). Returns -Infinity for a signal with no block above the absolute gate
// (i.e. silence). Callers (the bounce pipeline) clamp/skip per LUFS_FLOOR (D25).
export function integratedLoudness(channels, rate) {
  if (!channels.length || !channels[0].length) return -Infinity;
  const weighted = channels.map(kWeight);
  const blockLen = Math.round(BLOCK_SEC * rate);
  const hopLen = Math.round(HOP_SEC * rate);
  const frames = channels[0].length;

  const blockMeanSquares = [];
  for (let start = 0; start + blockLen <= frames; start += hopLen) {
    let sum = 0;
    for (const ch of weighted) {
      let s = 0;
      for (let i = start; i < start + blockLen; i++) s += ch[i] * ch[i];
      sum += s / blockLen;   // channel weight 1.0 for L/R (no surround channels here)
    }
    blockMeanSquares.push(sum);
  }
  if (!blockMeanSquares.length) return -Infinity;

  const loudnessOf = (ms) => -0.691 + 10 * Math.log10(ms);
  const ABSOLUTE_GATE = -70;

  const absPass = blockMeanSquares.filter((ms) => ms > 0 && loudnessOf(ms) > ABSOLUTE_GATE);
  if (!absPass.length) return -Infinity;

  const relativeThreshold = (absPass.reduce((a, b) => a + b, 0) / absPass.length);
  const relativeGate = loudnessOf(relativeThreshold) - 10;
  const relPass = absPass.filter((ms) => loudnessOf(ms) > relativeGate);
  if (!relPass.length) return -Infinity;

  const meanMs = relPass.reduce((a, b) => a + b, 0) / relPass.length;
  return loudnessOf(meanMs);
}
