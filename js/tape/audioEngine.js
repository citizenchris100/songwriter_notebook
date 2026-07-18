// js/tape/audioEngine.js — IMPURE: AudioContext lifecycle, the capture graph
// (worklet -> worker, meters/timer, wake lock), the playback graph (live
// vol/EQ/comp, D17 always-in-circuit compressor), and the 48 kHz
// OfflineAudioContext bounce render. Owns loading the worklet + worker via the
// D21 fetch->Blob rule. One controller, one AudioContext, per deck mount.
// Browser-only — never imported by the node engine test.
import * as takeStore from './takeStore.js';
import * as devices from './devices.js';
import { wavHeader, floatToInt16, interleave, parseWav, SIZE_FIELDS } from './wav.js';
import { integratedLoudness } from './lufs.js';
import { limit } from './limiter.js';
import {
  STEM_KEYS, MAX_TRACKS, stemFileName, mixFileName, compressorParams, bounceGainDb,
  EQ_BANDS, LIMITER_CEILING_DB,
} from './takeModel.js';

const BOUNCE_RATE = 48000;

// D21: worklet module fetches bypass the service worker — load the module
// source via fetch (SW-cache-served offline) into a Blob URL, exactly as
// takeStore.js does for the worker. Falls back to the plain URL online.
async function addWorkletModule(ctx) {
  const url = new URL('./captureProcessor.js', import.meta.url).href;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('captureProcessor fetch failed: ' + res.status);
    const text = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(blobUrl);
  } catch {
    await ctx.audioWorklet.addModule(url); // fine online; may not work offline
  }
}

// The persistent, non-destructive effect chain for one stem (D12): Gain(vol) ->
// 3-band EQ -> DynamicsCompressor (always in circuit, D17) -> Gain(makeup).
// Shared by playback AND bounce so the two topologies cannot diverge.
function buildEffectChain(ctx, settings) {
  const gainVol = ctx.createGain(); gainVol.gain.value = settings.vol;
  const eqBass = ctx.createBiquadFilter(); eqBass.type = EQ_BANDS[0].type; eqBass.frequency.value = EQ_BANDS[0].freq; eqBass.gain.value = settings.eq.bass;
  const eqMid = ctx.createBiquadFilter(); eqMid.type = EQ_BANDS[1].type; eqMid.frequency.value = EQ_BANDS[1].freq; eqMid.Q.value = EQ_BANDS[1].Q; eqMid.gain.value = settings.eq.mid;
  const eqTreble = ctx.createBiquadFilter(); eqTreble.type = EQ_BANDS[2].type; eqTreble.frequency.value = EQ_BANDS[2].freq; eqTreble.gain.value = settings.eq.treble;
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  const cp = compressorParams(settings.comp);
  comp.threshold.value = cp.threshold; comp.ratio.value = cp.ratio; comp.knee.value = cp.knee;
  comp.attack.value = cp.attack; comp.release.value = cp.release;
  makeup.gain.value = Math.pow(10, cp.makeupDb / 20);
  gainVol.connect(eqBass); eqBass.connect(eqMid); eqMid.connect(eqTreble); eqTreble.connect(comp); comp.connect(makeup);
  return { input: gainVol, output: makeup, gainVol, eqBass, eqMid, eqTreble, comp, makeup };
}

// Knob turns are click-free ramps, never a graph rebuild (D32's live-audio twin).
function applyChainSettings(chain, settings) {
  const now = chain.gainVol.context.currentTime;
  const RAMP = 0.01;
  chain.gainVol.gain.setTargetAtTime(settings.vol, now, RAMP);
  chain.eqBass.gain.setTargetAtTime(settings.eq.bass, now, RAMP);
  chain.eqMid.gain.setTargetAtTime(settings.eq.mid, now, RAMP);
  chain.eqTreble.gain.setTargetAtTime(settings.eq.treble, now, RAMP);
  const cp = compressorParams(settings.comp);
  chain.comp.threshold.setTargetAtTime(cp.threshold, now, RAMP);
  chain.comp.ratio.setTargetAtTime(cp.ratio, now, RAMP);
  chain.comp.knee.setTargetAtTime(cp.knee, now, RAMP);
  chain.comp.attack.setTargetAtTime(cp.attack, now, RAMP);
  chain.comp.release.setTargetAtTime(cp.release, now, RAMP);
  chain.makeup.gain.setTargetAtTime(Math.pow(10, cp.makeupDb / 20), now, RAMP);
}

async function loadStemBuffer(ctx, slug, stemMeta) {
  const bytes = await takeStore.readFile('takes/' + slug + '/' + stemMeta.file);
  const parsed = parseWav(bytes);
  const buffer = ctx.createBuffer(1, parsed.samples[0].length, parsed.rate);
  buffer.copyToChannel(parsed.samples[0], 0);
  return buffer;
}

// makeTapeDeck({ onMeter, onStatus, onWriteError }) -> the persistent per-deck
// controller. Public: { probe, record, stop, play, replay, stopPlay, bounce,
// applySettings, dispose }.
export function makeTapeDeck({ onMeter, onStatus, onWriteError } = {}) {
  let ctx = null;
  let workletNode = null;
  let mediaStream = null;
  let wakeLock = null;
  let recording = false;
  let recordMeta = null;      // { slug, take, sampleRate, slotKeys, overdub, cleanup }
  let playChains = null;      // { slug, take, sumBus, stems: { stem1: {buffer, chain, activeSource}|null, ... } }
  let monitorGraph = null;    // overdub backing playback during a pass: { sumBus, sources: [] }

  if (onWriteError) {
    takeStore.onWriteError((message) => {
      if (recording) stop('storage-error');
      onWriteError(message);
    });
  }

  async function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* resumed by the next gesture */ } }
    return ctx;
  }

  function probe(deviceId) {
    return devices.probe(deviceId);
  }

  // Play the take's already-recorded tracks (given as [{ meta }]) so the performer
  // overdubs in time. Buffers are pre-loaded by the caller and started together at
  // `startAt` (ctx time); the capture gate opens `monitorLatencySec` later so the
  // new track's sample 0 lines up with the backing at t=0 on playback.
  function startMonitorFromBuffers(items, startAt) {
    const audioCtx = ctx;
    const sumBus = audioCtx.createGain();
    sumBus.gain.value = 1;
    sumBus.connect(audioCtx.destination);
    const sources = [];
    for (const it of items) {
      const chain = buildEffectChain(audioCtx, it.meta);
      chain.output.connect(sumBus);
      const source = audioCtx.createBufferSource();
      source.buffer = it.buffer;
      source.connect(chain.input);
      source.start(startAt);
      sources.push(source);
    }
    monitorGraph = { sumBus, sources };
  }

  function stopMonitor() {
    if (!monitorGraph) return;
    for (const s of monitorGraph.sources) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    try { monitorGraph.sumBus.disconnect(); } catch { /* already disconnected */ }
    monitorGraph = null;
  }

  // `onPassOpen(capture, sampleRate)` is called the instant the capture channel
  // count (and context sample rate) is known — BEFORE any OPFS file is opened — so
  // the caller can arm this pass's slots in the manifest and write it first (D22
  // crash-consistent ordering). It must resolve to { take, slotKeys } (the take
  // number and the resolved destination slot keys for this pass, length === capture).
  //
  // routing: array of destination slot keys indexed by capture channel (input i ->
  // routing[i]); capture = min(device channels, routing length, MAX_TRACKS).
  // existingTracks: [{ meta }] of the take's already-recorded slots to monitor (empty
  // for a take's first pass). monitorLatencySec: the measured round-trip to align
  // the overdub (0 disables the gate — a first pass records from sample 0).
  async function record({ slug, deviceId, routing, monitorLatencySec = 0, existingTracks = [], onPassOpen }) {
    const acquired = await devices.acquireForRecording(deviceId);
    if (!acquired.ok) { onStatus && onStatus({ type: 'blocked' }); return { ok: false, denied: true }; }
    mediaStream = acquired.stream;
    const track = mediaStream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    const deviceChannels = Math.min(MAX_TRACKS, Math.max(1, settings.channelCount || 1));
    const routeKeys = (routing || []).slice();
    const capture = Math.min(deviceChannels, routeKeys.length);
    if (capture < 1) { teardownCaptureGraph(); onStatus && onStatus({ type: 'no-free-slots' }); return { ok: false, error: 'no free slots' }; }

    const audioCtx = await ensureContext();
    await addWorkletModule(audioCtx);

    // Manifest-at-start: the caller arms exactly this pass's slots and writes the
    // manifest before any OPFS file is opened. sampleRate is already known.
    const passInfo = await onPassOpen(capture, audioCtx.sampleRate);
    const take = passInfo.take;
    const slotKeys = (passInfo.slotKeys && passInfo.slotKeys.length ? passInfo.slotKeys : routeKeys).slice(0, capture);
    const overdub = !!(existingTracks && existingTracks.length);

    // Pre-load the backing buffers BEFORE choosing startAt, so the scheduled start
    // is always in the future no matter how long the OPFS reads take.
    const monitorItems = [];
    if (overdub) {
      for (const t of existingTracks) monitorItems.push({ meta: t.meta, buffer: await loadStemBuffer(audioCtx, slug, t.meta) });
    }

    const source = audioCtx.createMediaStreamSource(mediaStream);
    const slotNums = slotKeys.map((k) => Number(String(k).slice(4))); // 'stem3' -> 3
    const node = new AudioWorkletNode(audioCtx, 'capture-processor', {
      numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: capture, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      // beginFrame Infinity for an overdub: the gate stays shut until we send the
      // real begin frame AFTER the backing playback is scheduled (below), so setup
      // latency can never desync the two. A first pass records from frame 0.
      processorOptions: { channelCount: capture, slots: slotNums, beginFrame: overdub ? Number.MAX_SAFE_INTEGER : 0 },
    });
    workletNode = node;

    // Port plumbing (D33): a MessageChannel, one port transferred into the
    // worklet, the other bound to the OPFS worker — audio flows without
    // touching the main thread. Fallback: relay 'append' ourselves.
    let portTransferOk = true;
    try {
      const channel = new MessageChannel();
      node.port.postMessage({ port: channel.port1 }, [channel.port1]);
      await takeStore.bindAudioPort(channel.port2);
    } catch { portTransferOk = false; }

    node.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (typeof msg.frames === 'number') { onMeter && onMeter({ frames: msg.frames, peaks: msg.peaks, sampleRate: audioCtx.sampleRate, slotKeys }); return; }
      if (msg.op === 'append' && !portTransferOk) takeStore.relayAppend(msg.stem, msg.bytes);
    };

    // A silent sink so the worklet is reliably pulled even though its own
    // output is never actually monitored (D5 — hardware-monitor-only).
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(audioCtx.destination);

    const header = wavHeader(1, audioCtx.sampleRate, 0);
    const files = {};
    for (const key of slotKeys) files[key] = stemFileName(slug, take, key);
    await takeStore.openTakeFiles('takes/' + slug + '/', files, header, SIZE_FIELDS);

    // Everything is wired; NOW pick a common t=0 in the near future, start the
    // backing playback there, and open the capture gate one round-trip later.
    if (overdub) {
      const startAt = audioCtx.currentTime + 0.15;
      startMonitorFromBuffers(monitorItems, startAt);
      const beginFrame = Math.round((startAt + (monitorLatencySec || 0)) * audioCtx.sampleRate);
      node.port.postMessage({ op: 'begin', beginFrame });
    }

    recording = true;
    recordMeta = { slug, take, sampleRate: audioCtx.sampleRate, slotKeys, overdub };

    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); }
    catch { onStatus && onStatus({ type: 'no-wake-lock' }); } // AC-24: hint, not a blocker

    const visHandler = () => { if (document.hidden && recording) stop('interrupted'); };
    const ctxStateHandler = () => { if (recording && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) stop('interrupted'); };
    const trackEndedHandler = () => { if (recording) stop('interrupted'); };
    document.addEventListener('visibilitychange', visHandler);
    audioCtx.addEventListener('statechange', ctxStateHandler);
    track.addEventListener('ended', trackEndedHandler);
    recordMeta.cleanup = () => {
      document.removeEventListener('visibilitychange', visHandler);
      audioCtx.removeEventListener('statechange', ctxStateHandler);
      track.removeEventListener('ended', trackEndedHandler);
    };

    return { ok: true, capture, sampleRate: audioCtx.sampleRate, take, slotKeys };
  }

  // Clean stop: flush the worklet's partial chunk (with an ack handshake so the
  // very last bytes are guaranteed written before we ask the worker to
  // finalize), patch+close the stem files, release the wake lock, then AWAIT
  // the caller's onStatus (it finalizes the manifest) before resolving — so a
  // caller that awaits stop() sees fully-settled state, not a promise that
  // resolves before its own side effects have landed. Returns
  // { slug, take, sampleRate, channels, durationSec, dataBytes } or null.
  async function stop(reason) {
    if (!recording) return null;
    recording = false;
    if (recordMeta && recordMeta.cleanup) recordMeta.cleanup();

    // Snapshot the node: a stray late ack must never touch whatever `workletNode`
    // the outer closure points at BY THEN (a subsequent record() may have
    // already replaced it, or teardownCaptureGraph() may have nulled it).
    const node = workletNode;
    if (node) {
      await new Promise((resolve) => {
        const prevHandler = node.port.onmessage;
        let settled = false;
        const finish = () => { if (settled) return; settled = true; node.port.onmessage = prevHandler; resolve(); };
        const timeout = setTimeout(finish, 500); // safety net if the ack is ever lost
        node.port.onmessage = (e) => {
          if (e.data && e.data.flushed) { clearTimeout(timeout); finish(); return; }
          prevHandler && prevHandler(e);
        };
        node.port.postMessage({ op: 'flush' });
      });
    }

    const dataBytes = await takeStore.finalizeTakeFiles();
    teardownCaptureGraph();
    if (wakeLock) { try { await wakeLock.release(); } catch { /* already released */ } wakeLock = null; }

    const rc = recordMeta; recordMeta = null;
    if (!rc) return null;
    // Per-slot durations for exactly the slots this pass wrote (2 bytes/sample, mono
    // per track); the pass "length" is its longest slot.
    const slotDurations = {};
    for (const key of rc.slotKeys) slotDurations[key] = (dataBytes[key] || 0) / (2 * rc.sampleRate);
    const durs = Object.keys(slotDurations).map((k) => slotDurations[k]);
    const durationSec = durs.length ? Math.max.apply(null, durs) : 0;
    if (onStatus) await onStatus({ type: reason === 'interrupted' ? 'stopped-interrupted' : reason === 'storage-error' ? 'stopped-storage-error' : 'stopped', slug: rc.slug, take: rc.take, sampleRate: rc.sampleRate, slotKeys: rc.slotKeys, slotDurations, durationSec });
    return { slug: rc.slug, take: rc.take, sampleRate: rc.sampleRate, slotKeys: rc.slotKeys, slotDurations, durationSec, dataBytes };
  }

  function teardownCaptureGraph() {
    stopMonitor();
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    if (workletNode) { try { workletNode.disconnect(); } catch { /* already disconnected */ } workletNode = null; }
  }

  // ---- playback (lazy-loads the take if it isn't already the loaded one) ----
  async function loadTake(take, slug) {
    disposePlayback();
    const audioCtx = await ensureContext();
    const sumBus = audioCtx.createGain();
    sumBus.gain.value = 1;
    sumBus.connect(audioCtx.destination);
    const stems = {};
    for (const key of STEM_KEYS) {
      const stemMeta = take.stems && take.stems[key];
      if (!stemMeta || !stemMeta.file) { stems[key] = null; continue; }
      const buffer = await loadStemBuffer(audioCtx, slug, stemMeta);
      const chain = buildEffectChain(audioCtx, stemMeta);
      chain.output.connect(sumBus);
      stems[key] = { buffer, chain, activeSource: null };
    }
    playChains = { slug, take: take.take, sumBus, stems };
  }

  function disposePlayback() {
    stopPlaySources();
    if (playChains) { try { playChains.sumBus.disconnect(); } catch { /* already disconnected */ } }
    playChains = null;
  }

  function stopPlaySources() {
    if (!playChains) return;
    for (const key of STEM_KEYS) {
      const s = playChains.stems[key];
      if (s && s.activeSource) { try { s.activeSource.onended = null; s.activeSource.stop(); } catch { /* already stopped */ } s.activeSource = null; }
    }
  }

  async function play(take, slug) {
    if (!playChains || playChains.slug !== slug || playChains.take !== take.take) await loadTake(take, slug);
    stopPlaySources();
    const audioCtx = ctx;
    const startAt = audioCtx.currentTime + 0.1; // all stems start together -> sample-locked
    let any = false, primary = null;
    for (const key of STEM_KEYS) {
      const s = playChains.stems[key];
      if (!s) continue;
      const source = audioCtx.createBufferSource();
      source.buffer = s.buffer;
      source.connect(s.chain.input);
      source.start(startAt);
      s.activeSource = source;
      any = true;
      if (!primary) primary = source;
    }
    if (primary) primary.onended = () => { onStatus && onStatus({ type: 'ended' }); };
    return any;
  }

  async function replay(take, slug) {
    if (playChains && playChains.slug === slug && playChains.take === take.take) stopPlaySources();
    return play(take, slug);
  }

  function stopPlay() { stopPlaySources(); }

  // Live, non-destructive: updates the CURRENTLY LOADED take's stem chain.
  // Capture-only callers (tapeView's dial `input` handler, D32) call this on
  // every tick with no render; persistence is the caller's separate concern.
  function applySettings(stemKey, settings) {
    if (!playChains || !playChains.stems[stemKey]) return;
    applyChainSettings(playChains.stems[stemKey].chain, settings);
  }

  // Render all present tracks of a take (each through its own effect chain) summed
  // into ONE mono channel at 48 kHz — the shared render used by both the master
  // bounce and the per-track ping-pong bounce. Returns a Float32Array (mono) or
  // null if the take has no audio. Mono forever: no stereo/panning anywhere.
  async function renderMonoMix(keys, take, slug) {
    const durationSec = maxKeyDuration(keys, take);
    const frames = Math.max(1, Math.ceil((durationSec + 0.05) * BOUNCE_RATE)); // +50ms pad for comp tail
    const offlineCtx = new OfflineAudioContext(1, frames, BOUNCE_RATE);
    const sumBus = offlineCtx.createGain();
    sumBus.gain.value = 1;
    sumBus.connect(offlineCtx.destination);
    let any = false;
    for (const key of keys) {
      const stemMeta = take.stems && take.stems[key];
      if (!stemMeta || !stemMeta.file) continue;
      const buffer = await loadStemBuffer(offlineCtx, slug, stemMeta);
      const chain = buildEffectChain(offlineCtx, stemMeta);
      chain.output.connect(sumBus);
      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(chain.input);
      source.start(0);
      any = true;
    }
    if (!any) return { mono: null, durationSec };
    const rendered = await offlineCtx.startRendering();
    return { mono: rendered.getChannelData(0).slice(), durationSec };
  }

  function maxKeyDuration(keys, take) {
    let max = 0;
    for (const key of keys) { const s = take.stems && take.stems[key]; if (s && s.file && s.durationSec) max = Math.max(max, s.durationSec); }
    return max;
  }

  function encodeMonoWav(mono) {
    const i16 = floatToInt16(mono);
    const header = wavHeader(1, BOUNCE_RATE, i16.byteLength);
    const full = new Uint8Array(header.byteLength + i16.byteLength);
    full.set(new Uint8Array(header), 0);
    full.set(new Uint8Array(i16.buffer), header.byteLength);
    return full.buffer;
  }

  // ---- master bounce (AC-13/14): sum ALL tracks -> one mono _mix.wav with the
  // fixed LUFS-target + brick-wall-limiter mastering ----
  async function bounce(take, slug) {
    const { mono } = await renderMonoMix(STEM_KEYS, take, slug);
    if (!mono) return { ok: false, error: 'take has no tracks to bounce' };
    const measured = integratedLoudness([mono], BOUNCE_RATE);
    const gainDb = bounceGainDb(measured);
    if (gainDb !== 0) { const g = Math.pow(10, gainDb / 20); for (let i = 0; i < mono.length; i++) mono[i] *= g; }
    limit([mono], BOUNCE_RATE, LIMITER_CEILING_DB);
    const filename = mixFileName(slug, take.take);
    await takeStore.writeFile('takes/' + slug + '/' + filename, encodeMonoWav(mono));
    return { ok: true, file: filename, lufs: measured === -Infinity ? null : measured };
  }

  // ---- ping-pong bounce: sum ONE source track + the destination track (both
  // effected) into the destination's mono file, freeing the source slot. No LUFS
  // normalization (an internal sub-mix — normalizing would corrupt inter-track
  // balance); a brick-wall limiter guards the two-track sum from clipping. The
  // caller updates the manifest (free src, reset dst to neutral) + deletes the src. ----
  async function bounceTracks(take, srcKey, dstKey, slug) {
    const src = take.stems && take.stems[srcKey];
    const dst = take.stems && take.stems[dstKey];
    if (!src || !src.file || !dst || !dst.file) return { ok: false, error: 'both tracks must have audio' };
    const { mono, durationSec } = await renderMonoMix([srcKey, dstKey], take, slug);
    if (!mono) return { ok: false, error: 'nothing to bounce' };
    limit([mono], BOUNCE_RATE, LIMITER_CEILING_DB);
    await takeStore.writeFile('takes/' + slug + '/' + dst.file, encodeMonoWav(mono));
    return { ok: true, srcKey, dstKey, durationSec };
  }

  function dispose() {
    if (recording) stop('interrupted');
    stopMonitor();
    disposePlayback();
    if (wakeLock) { try { wakeLock.release(); } catch { /* already released */ } wakeLock = null; }
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } ctx = null; }
  }

  return { probe, record, stop, play, replay, stopPlay, bounce, bounceTracks, applySettings, dispose };
}
