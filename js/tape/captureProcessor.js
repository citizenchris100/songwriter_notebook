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
    const opts = (options && options.processorOptions) || {};
    const channelCount = opts.channelCount || 2;
    this.channelCount = channelCount;
    // slots[c] = the DESTINATION slot number (1..4) capture channel c is routed to
    // (input->track routing), or 0 to DISCARD that channel (an interface input the
    // user didn't arm to any track). Defaults to positional 1..N when no routing is
    // given. A discarded channel is still peaked (for its input meter) but never
    // opens or writes a stem file.
    this.slots = (opts.slots && opts.slots.length === channelCount) ? opts.slots.slice() : Array.from({ length: channelCount }, (_, c) => c + 1);
    // Latency gate: frames before beginFrame are discarded (an overdub's pre-roll,
    // so the new track's sample 0 lines up with the backing at t=0). 0 = record from
    // the first sample (a take's first pass, no monitoring). `currentFrame` is the
    // AudioContext sample clock, shared with the main thread that computes beginFrame.
    this.beginFrame = opts.beginFrame || 0;
    this.buffers = Array.from({ length: channelCount }, () => new Float32Array(CHUNK_FRAMES));
    this.cursor = 0;
    // Set true by {op:'flush'} on Stop. Once closed, process() returns FALSE so the
    // browser removes this processor from the render graph — the ONLY reliable way to
    // make it stop. workletNode.disconnect() alone does NOT halt a processor that
    // returns true (it keeps being pulled while a live input source is connected), so
    // without this the worklet outlives the take: it keeps posting meter/clock ticks
    // (the "glitchy counter") and keeps flushing chunks into the already-finalized
    // take (the repeating "append received with no take open" storm).
    this.closed = false;
    this.totalFrames = 0;
    this.peaks = new Array(channelCount).fill(0);
    this.workerPort = null;
    this.meterEveryFrames = Math.max(1, Math.round(sampleRate / METER_HZ));
    this.framesSinceMeter = 0;

    // Measure mode (latency calibration, js/tape/latency.js): stream raw mono capture
    // back to the main thread tagged with the absolute context frame of each chunk's
    // first sample, so a returning click can be located on the one sample clock. No
    // gate, no int16, no OPFS worker.
    this.measure = !!opts.measure;
    this.mChunk = this.measure ? new Float32Array(CHUNK_FRAMES) : null;
    this.mCursor = 0;
    this.mChunkStart = -1;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.port) { this.workerPort = data.port; return; }
      if (data.op === 'begin' && typeof data.beginFrame === 'number') { this.beginFrame = data.beginFrame; return; }
      if (data.op === 'flush') {
        if (this.measure) {
          this.postMeasureChunk();
        } else {
          if (this.cursor > 0) this.flushChunk(this.cursor);
          // Drain barrier (sample-perfect tails): post an end-of-stream marker on the
          // SAME port the appends use (workerPort in the D33 path, else this.port for the
          // main-thread relay), AFTER the final chunk and UNCONDITIONALLY — a cursor-0
          // Stop must still drain, else the main thread's awaitDrain waits out its whole
          // timeout. Never in measure mode (calibration has no take and no worker port).
          (this.workerPort || this.port).postMessage({ op: 'drain', drainId: data.drainId });
        }
        this.closed = true;                       // stop capturing (process() self-removes next quantum)
        this.port.postMessage({ flushed: true });
        return;
      }
    };
  }

  postMeasureChunk() {
    if (this.mCursor === 0) return;
    const out = this.mChunk.slice(0, this.mCursor);
    this.port.postMessage({ measure: out, startFrame: this.mChunkStart }, [out.buffer]);
    this.mCursor = 0;
    this.mChunkStart = -1;
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
      if (this.slots[c] === 0) continue; // unrouted input — discard, no stem file
      const i16 = this.floatToInt16(this.buffers[c].subarray(0, frames));
      const msg = { op: 'append', stem: this.slots[c], bytes: i16.buffer }; // route channel c -> its destination slot
      if (this.workerPort) this.workerPort.postMessage(msg, [i16.buffer]);
      else this.port.postMessage(msg, [i16.buffer]);
    }
    this.cursor = 0;
  }

  process(inputs) {
    if (this.closed) return false; // flushed on Stop: leave the graph so we never post stray appends/meters again
    const input = inputs[0];
    if (!input || !input.length || !input[0] || !input[0].length) return true; // no signal yet — stay alive
    const frames = input[0].length;

    // Measure mode: stream channel 0 straight back, anchored to the sample clock.
    if (this.measure) {
      const ch = input[0];
      for (let i = 0; i < frames; i++) {
        if (this.mCursor === 0) this.mChunkStart = currentFrame + i; // absolute frame of this chunk's sample 0
        this.mChunk[this.mCursor++] = ch[i];
        if (this.mCursor >= CHUNK_FRAMES) this.postMeasureChunk();
      }
      return true;
    }

    for (let i = 0; i < frames; i++) {
      // Peaks track the LIVE input every frame (so the meter shows level even during
      // an overdub's pre-roll count-in, before the gate opens).
      for (let c = 0; c < this.channelCount; c++) {
        const src = input[c] || input[0]; // a route that dropped a channel falls back to ch0
        const a = Math.abs(src[i]);
        if (a > this.peaks[c]) this.peaks[c] = a;
      }
      // Gate: don't commit to disk until the shared-timeline begin frame.
      if (currentFrame + i < this.beginFrame) continue;
      for (let c = 0; c < this.channelCount; c++) {
        const src = input[c] || input[0];
        this.buffers[c][this.cursor] = src[i];
      }
      this.cursor++;
      this.totalFrames++;
      if (this.cursor >= CHUNK_FRAMES) this.flushChunk(CHUNK_FRAMES);
    }
    // Meter cadence tracks wall frames (not gated frames) so meters tick during the
    // pre-roll too; totalFrames (the elapsed-time source) only advances post-gate.
    this.framesSinceMeter += frames;
    if (this.framesSinceMeter >= this.meterEveryFrames) {
      this.port.postMessage({ frames: this.totalFrames, peaks: this.peaks.slice() });
      this.peaks.fill(0);
      this.framesSinceMeter = 0;
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
