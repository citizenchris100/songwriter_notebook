// js/tape/captureProcessor.js — AudioWorkletProcessor, dependency-free (loaded
// via audioWorklet.addModule() from a Blob URL, D21 — worklet module fetches
// bypass the service worker, so this file must not `import` anything).
//
// Batches input into ~8192-frame per-channel chunks, converts float->int16 IN
// the worklet (same asymmetric clamp formula as wav.js floatToInt16 — duplicated
// by necessity so this file has zero imports; keep the two in sync if either
// changes), and posts:
//   - audio chunks to the transferred worker port (D33) — one
//     {op:'append', stem, bytes} per channel per flush, so each channel streams
//     straight to its own mono stem file without touching the main thread.
//   - small {frames, peaks:[...]} meter/clock messages on its own node port at
//     ~10 Hz, for the main thread's elapsed timer + level meters.
// this.port carries three message kinds, all on the single node<->processor
// pair: inbound one-time {port} (the transferred worker port, D33), inbound
// {op:'flush'} (Stop — flush any partial chunk and ack so the caller can
// finalize safely), and outbound {frames, peaks} meter ticks. If no worker port
// was ever transferred (D33 fallback), audio chunks are posted on this.port too
// (tagged {op:'append', ...}) and the main thread relays them itself.
const CHUNK_FRAMES = 8192;
const METER_HZ = 10;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const channelCount = (options && options.processorOptions && options.processorOptions.channelCount) || 2;
    this.channelCount = channelCount;
    this.buffers = Array.from({ length: channelCount }, () => new Float32Array(CHUNK_FRAMES));
    this.cursor = 0;
    this.totalFrames = 0;
    this.peaks = new Array(channelCount).fill(0);
    this.workerPort = null;
    this.meterEveryFrames = Math.max(1, Math.round(sampleRate / METER_HZ));
    this.framesSinceMeter = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.port) { this.workerPort = data.port; return; }
      if (data.op === 'flush') {
        if (this.cursor > 0) this.flushChunk(this.cursor);
        this.port.postMessage({ flushed: true });
      }
    };
  }

  // Duplicated from wav.js floatToInt16 by necessity (this file has zero imports).
  floatToInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  flushChunk(frames) {
    for (let c = 0; c < this.channelCount; c++) {
      const i16 = this.floatToInt16(this.buffers[c].subarray(0, frames));
      const msg = { op: 'append', stem: c + 1, bytes: i16.buffer };
      if (this.workerPort) this.workerPort.postMessage(msg, [i16.buffer]);
      else this.port.postMessage(msg, [i16.buffer]);
    }
    this.cursor = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0] || !input[0].length) return true; // no signal yet — stay alive
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channelCount; c++) {
        const src = input[c] || input[0]; // a route that dropped a channel falls back to ch0
        const v = src[i];
        this.buffers[c][this.cursor] = v;
        const a = Math.abs(v);
        if (a > this.peaks[c]) this.peaks[c] = a;
      }
      this.cursor++;
      this.totalFrames++;
      this.framesSinceMeter++;
      if (this.cursor >= CHUNK_FRAMES) this.flushChunk(CHUNK_FRAMES);
    }
    if (this.framesSinceMeter >= this.meterEveryFrames) {
      this.port.postMessage({ frames: this.totalFrames, peaks: this.peaks.slice() });
      this.peaks.fill(0);
      this.framesSinceMeter = 0;
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
