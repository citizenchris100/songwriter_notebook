// js/tape/limiter.js — PURE brick-wall lookahead limiter over Float32 channel
// arrays, in place. A true lookahead design: gain is computed from the minimum
// target-gain over a forward window, then applied to the SAME signal delayed by
// that window (a per-channel circular delay line) so the reduction is already
// ramped in by the time the loud sample itself is emitted. A final hard clamp
// is the actual brick wall — it catches whatever the attack/release smoothing
// didn't fully anticipate. No DOM/Worker — node-importable.
//
// D25: this exists because "limiter" was previously just a name with no design —
// a second DynamicsCompressorNode would overshoot. This module is deterministic
// and unit-testable (encoder-independent of the live audio graph).
export const LOOKAHEAD_SEC = 0.005;
export const ATTACK_SEC = 0.001;
export const RELEASE_SEC = 0.050;

const dbToLinear = (db) => Math.pow(10, db / 20);

// Mutates `channels` (an array of equal-length Float32Array, one per channel) in
// place. `ceilingDb` defaults to −1 dBFS (LIMITER_CEILING_DB in takeModel.js).
export function limit(channels, rate, ceilingDb) {
  const ceiling = dbToLinear(typeof ceilingDb === 'number' ? ceilingDb : -1);
  const n = channels[0].length;
  const nCh = channels.length;
  const lookahead = Math.max(1, Math.round(LOOKAHEAD_SEC * rate));
  // One-pole time-constant smoothing: fast attack (gain dropping), slow release
  // (gain recovering) — asymmetric so the limiter reacts quickly to a new peak
  // but doesn't pump on every quiet passage.
  const attackCoeff = 1 - Math.exp(-1 / Math.max(1, ATTACK_SEC * rate));
  const releaseCoeff = 1 - Math.exp(-1 / Math.max(1, RELEASE_SEC * rate));

  // Per-sample instantaneous target gain from the peak across all channels.
  const target = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let c = 0; c < nCh; c++) { const a = Math.abs(channels[c][i]); if (a > peak) peak = a; }
    target[i] = peak > ceiling ? ceiling / peak : 1;
  }

  const delay = channels.map(() => new Float32Array(lookahead));
  const outputs = channels.map(() => new Float32Array(n));
  let gain = 1;

  for (let i = 0; i < n; i++) {
    let minGain = 1;
    const end = Math.min(n, i + lookahead);
    for (let k = i; k < end; k++) if (target[k] < minGain) minGain = target[k];
    gain += (minGain - gain) * (minGain < gain ? attackCoeff : releaseCoeff);

    const pos = i % lookahead;
    for (let c = 0; c < nCh; c++) {
      const buf = delay[c];
      const delayed = buf[pos];
      buf[pos] = channels[c][i];
      outputs[c][i] = delayed * gain;
    }
  }

  for (let c = 0; c < nCh; c++) {
    const out = outputs[c];
    for (let i = 0; i < n; i++) out[i] = Math.max(-ceiling, Math.min(ceiling, out[i]));
    channels[c].set(out);
  }
}
