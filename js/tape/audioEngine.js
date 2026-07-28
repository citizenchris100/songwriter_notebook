// js/tape/audioEngine.js — IMPURE: AudioContext lifecycle, the capture graph
// (worklet -> worker, meters/timer, wake lock), the playback graph (live
// vol/EQ/comp, D17 always-in-circuit compressor), and the 48 kHz
// OfflineAudioContext bounce render. Owns loading the worklet + worker via the
// D21 fetch->Blob rule. One controller, one AudioContext, per deck mount.
// Browser-only — never imported by the node engine test.
import * as takeStore from './takeStore.js';
import * as folderStore from './folderStore.js';
import * as devices from './devices.js';
import { wavHeader, floatToInt16, interleave, parseWav, SIZE_FIELDS } from './wav.js';
import { integratedLoudness } from './lufs.js';
import { limit } from './limiter.js';
import {
  STEM_KEYS, MAX_TRACKS, stemFileName, mixFileName, compressorParams, bounceGainDb,
  EQ_BANDS, LIMITER_CEILING_DB, defaultStemSettings, playbackCacheStale,
} from './takeModel.js';
import { detectClickSample, rttSeconds, summarizeTrials, resolveMonitorLatencySec } from './latency.js';
import { makeClick } from './click.js';
import { makeDrumMachine, renderDrumsOffline } from './drumMachine.js';
import { loadKit, loadEffect } from './drumKits.js';
import { CLIP_THRESHOLD } from './meterModel.js';
import { barSeconds } from './clickModel.js';

// The exact seconds a FLATTENED drum SEQUENCE take plays (its frozen intro+main+outro pattern,
// once). 0 for a non-sequence take (single loop / grid), which loops for the take instead. This
// is what makes a sequence play ONCE and stop, in both live playback and the offline bounce.
function drumSequenceSeconds(take) {
  const d = take && take.drums;
  if (!d || !d.enabled || !(d.source && d.source.type === 'sequence')) return 0;
  const bpm = (take.click && take.click.bpm) || 120;
  const tsi = (take.click && take.click.timeSigIndex != null) ? take.click.timeSigIndex : 2;
  return ((d.pattern && d.pattern.bars) || 0) * barSeconds(bpm, tsi);
}

const BOUNCE_RATE = 48000;
const METER_INTERVAL_MS = 83; // ~12 Hz playback/monitor metering (setInterval, not rAF — PWA-throttle-proof)
const TAP_FFT = 4096;         // AnalyserNode time-domain window (~85 ms @48k): near-gapless peak coverage

// D21: worklet module fetches bypass the service worker — load the module
// source via fetch (SW-cache-served offline) into a Blob URL, exactly as
// takeStore.js does for the worker. Falls back to the plain URL online.
// Idempotent per context: adding the module twice would re-run registerProcessor
// ('capture-processor' already registered → throws), and both record() and
// calibrateLatency() call this, so guard on a per-ctx flag.
async function addWorkletModule(ctx) {
  if (ctx.__captureWorkletLoaded) return;
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
  ctx.__captureWorkletLoaded = true;
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

// The one decode entry point, location-aware: a slot marked loc:'folder' reads from
// the song's on-disk folder via folderStore (needs the granted, permitted dir handle);
// any other slot reads from OPFS via takeStore. A folder slot with no usable handle
// throws FOLDER_UNAVAILABLE so the caller can surface "grant folder access" — never a
// silent fallback to OPFS, whose copy was deleted on Save.
async function loadStemBuffer(ctx, slug, stemMeta, folderHandle) {
  const rel = 'takes/' + slug + '/' + stemMeta.file;
  let bytes;
  if (stemMeta.loc === 'folder') {
    if (!folderHandle) throw Object.assign(new Error('saved audio needs folder access'), { code: 'FOLDER_UNAVAILABLE' });
    bytes = await folderStore.readFile(folderHandle, rel);
  } else {
    bytes = await takeStore.readFile(rel);
  }
  const parsed = parseWav(bytes);
  const buffer = ctx.createBuffer(1, parsed.samples[0].length, parsed.rate);
  buffer.copyToChannel(parsed.samples[0], 0);
  return buffer;
}

// makeTapeDeck({ onLevels, onClock, onStatus, onWriteError }) -> the persistent
// per-deck controller. Public: { probe, record, stop, play, replay, stopPlay,
// bounce, applySettings, setMasterVol, dispose }.
//
// Metering is unified across capture and playback into ONE callback shape:
//   onLevels({ source: 'capture'|'playback'|'monitor',
//              levels: { stem1:{peak,clip}, ... only present keys ... },
//              master: {peak,clip} | null })
// Capture levels come from the capture worklet's per-batch peaks (D28); playback +
// overdub-monitor levels come from passive AnalyserNode taps polled by one interval
// loop (D34). A separate onClock({ mode:'record'|'play', elapsedSec, durationSec })
// drives the LED counter.
export function makeTapeDeck({ onLevels, onClock, onStatus, onWriteError } = {}) {
  let ctx = null;
  let masterBus = null;       // master MONITOR gain (D35): the last node before ctx.destination for
                              // playback + overdub backing + click. Monitor-only — the bounce path
                              // (renderMonoMix's OfflineAudioContext) never routes through it, and
                              // calibration wires around it, so it can't affect exports or loopback.
  let masterVol = 1;          // 0..1.5, applied to masterBus; survives ctx (re)creation
  let workletNode = null;
  let captureSource = null;   // MediaStreamAudioSourceNode feeding the worklet (severed on teardown)
  let captureSink = null;     // silent gain that pulls the worklet (severed on teardown)
  let mediaStream = null;
  let wakeLock = null;
  let recording = false;
  let recordMeta = null;      // { slug, take, sampleRate, slotKeys, overdub, cleanup }
  let playChains = null;      // { slug, take, epoch, sumBus, stems: { stem1: {buffer, chain, activeSource}|null, ... } }
  let recordEpoch = 0;        // monotonic; bumped on every in-place audio write (a record pass truncating/
                              // overwriting a take's WAVs, or a ping-pong bounce overwriting the dst WAV) so
                              // play()/replay() drop the decoded-buffer cache when a take's audio changes
                              // under a FIXED take number (retake, overdub, bounce). Content fields can't tell.
  let monitorGraph = null;    // overdub backing playback during a pass: { sumBus, sources: [] }
  let clickEngine = null;     // the record-only count-in cue, null when off
  let drumMachine = null;     // the record-only drum BACKING (monitor bus), null when off. Playback
                              // drums live on playChains.drum instead (their own graph/dest).
  let autoStopping = false;   // guards the sequence auto-stop so the worklet's {op:'ended'} and a
                              // concurrent manual Stop can't both fire stop() for the same take.
  let previewMachine = null;  // a throwaway drum machine for pre-record audition (no capture/take)
  let previewTimer = null;

  // Stop + tear down the metronome count-in. Idempotent; called on Stop AND every teardown
  // path (interruption/dispose) so the cue can never outlive a recording pass.
  function stopClick() {
    if (!clickEngine) return;
    try { clickEngine.stop(); } catch { /* already stopped */ }
    clickEngine = null;
  }

  // Stop + tear down the record-time drum backing. Idempotent; same teardown discipline as
  // stopClick — the drums must never outlive their recording pass.
  function stopDrums() {
    if (!drumMachine) return;
    try { drumMachine.dispose(); } catch { /* already stopped */ }
    drumMachine = null;
  }

  if (onWriteError) {
    takeStore.onWriteError((message) => {
      if (recording) stop('storage-error');
      onWriteError(message);
    });
  }

  async function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterBus = ctx.createGain();
      masterBus.gain.value = masterVol;
      masterBus.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* resumed by the next gesture */ } }
    return ctx;
  }

  // The master MONITOR volume (D35): live, non-destructive, persisted app-level by the
  // caller (localStorage sn_tape_master), NEVER in the take/manifest and never seen by
  // the bounce. D32-style: preview-caller sets it live every tick, persistence is the
  // caller's separate concern.
  function setMasterVol(v) {
    masterVol = Math.max(0, Math.min(1.5, isFinite(v) ? v : 1));
    if (masterBus) masterBus.gain.setTargetAtTime(masterVol, ctx.currentTime, 0.01);
  }

  // ---- playback / overdub-monitor metering (D34): passive AnalyserNode taps polled by
  // one interval loop. `playState` also drives the playback clock. ----
  let meterTimer = null;
  let playState = null;         // { startAt, durationSec } while a take is playing (else null)
  const meterScratch = new Float32Array(TAP_FFT);
  const lv = (peak) => ({ peak, clip: peak >= CLIP_THRESHOLD });

  function makeTap(audioCtx) { const a = audioCtx.createAnalyser(); a.fftSize = TAP_FFT; return a; }
  function tapPeak(analyser) {
    analyser.getFloatTimeDomainData(meterScratch);
    let p = 0;
    for (let i = 0; i < meterScratch.length; i++) { const a = meterScratch[i] < 0 ? -meterScratch[i] : meterScratch[i]; if (a > p) p = a; }
    return p;
  }

  function anyActiveSource() {
    return !!(playChains && STEM_KEYS.some((k) => playChains.stems[k] && playChains.stems[k].activeSource));
  }
  function startMeterLoop() { if (!meterTimer) meterTimer = setInterval(meterTick, METER_INTERVAL_MS); }
  function stopMeterLoop() { if (meterTimer) { clearInterval(meterTimer); meterTimer = null; } }
  function maybeStopMeterLoop() { if (!anyActiveSource() && !monitorGraph) stopMeterLoop(); }

  function meterTick() {
    if (!ctx || ctx.state !== 'running') return; // suspended/interrupted -> nothing to read
    if (playChains && anyActiveSource()) {
      const levels = {};
      for (const key of STEM_KEYS) {
        const s = playChains.stems[key];
        if (s && s.tap && s.activeSource) levels[key] = lv(tapPeak(s.tap));
      }
      if (playChains.drum && playChains.drum.tap) levels.drum = lv(tapPeak(playChains.drum.tap)); // drum-bus meter
      const master = playChains.masterTap ? lv(tapPeak(playChains.masterTap)) : null;
      onLevels && onLevels({ source: 'playback', levels, master });
      if (playState) {
        const elapsed = Math.max(0, Math.min(playState.durationSec, ctx.currentTime - playState.startAt));
        onClock && onClock({ mode: 'play', elapsedSec: elapsed, durationSec: playState.durationSec });
      }
    }
    if (monitorGraph && monitorGraph.taps) {
      const levels = {};
      for (const key of Object.keys(monitorGraph.taps)) levels[key] = lv(tapPeak(monitorGraph.taps[key]));
      onLevels && onLevels({ source: 'monitor', levels, master: null });
    }
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
    sumBus.connect(masterBus); // overdub backing follows the monitor fader (D35)
    const sources = [];
    const taps = {};
    for (const it of items) {
      const chain = buildEffectChain(audioCtx, it.meta);
      chain.output.connect(sumBus);
      if (it.key) { const tap = makeTap(audioCtx); chain.output.connect(tap); taps[it.key] = tap; } // per-backing-track meter (D34)
      const source = audioCtx.createBufferSource();
      source.buffer = it.buffer;
      source.connect(chain.input);
      source.start(startAt);
      sources.push(source);
    }
    monitorGraph = { sumBus, sources, taps };
    startMeterLoop();
  }

  function stopMonitor() {
    if (!monitorGraph) return;
    for (const s of monitorGraph.sources) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    try { monitorGraph.sumBus.disconnect(); } catch { /* already disconnected */ }
    monitorGraph = null;
    maybeStopMeterLoop();
  }

  // `onPassOpen(capture, sampleRate)` is called the instant the capture channel
  // count (and context sample rate) is known — BEFORE any OPFS file is opened — so
  // the caller can arm this pass's slots in the manifest and write it first (D22
  // crash-consistent ordering). It must resolve to { take, slotKeys } (the take
  // number and the resolved destination slot keys for this pass, length === capture).
  //
  // routing: array indexed by capture channel (input i -> routing[i]); each entry is a
  // destination slot key ('stem1'..'stem4') OR null for an interface input the user did
  // not arm (that channel is captured for its input meter but written to no file).
  // capture = min(device channels, routing length). existingTracks: [{ key, meta }] of
  // the take's already-recorded slots to monitor (empty for a first pass).
  // monitorLatencySec/monitorLatencySource: the stored calibration (seconds) and its provenance
  // ('measured'|'manual'|'none'). A measured/manual value aligns the overdub verbatim; when
  // uncalibrated ('none') the gate offset is AUTO-ESTIMATED from the live context + input track
  // (resolveMonitorLatencySec) instead of defaulting to 0 — see the shift computation below.
  async function record({ slug, deviceId, routing, monitorLatencySec = 0, monitorLatencySource = 'none', existingTracks = [], clickConfig = null, drumConfig = null, autoStopSec = null, folderHandle = null, onPassOpen }) {
    autoStopping = false;
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
    // channelKeys: per-capture-channel slot key or null (discard) — drives the worklet's
    // per-channel routing AND the input-meter mapping, so a sparse arm (e.g. only input 2
    // -> Track 2) can't be positionally mis-read. slotKeys: the COMPACT non-null list, for
    // finalize/recordMeta (the slots that actually got a file).
    const channelKeys = routeKeys.slice(0, capture);
    const slotKeys = (passInfo.slotKeys && passInfo.slotKeys.length)
      ? passInfo.slotKeys.slice(0, capture)
      : channelKeys.filter(Boolean);
    const overdub = !!(existingTracks && existingTracks.length);
    const countInEnabled = !!(clickConfig && clickConfig.countIn); // the 2-bar cue (decoupled from any click)
    const drumsEnabled = !!(drumConfig && drumConfig.enabled);     // the drum machine is the take's backing now
    const scheduled = overdub || countInEnabled || drumsEnabled;   // any of these needs a scheduled common t=0
    const bpm = (clickConfig && clickConfig.bpm) || 120;
    const timeSigIndex = (clickConfig && clickConfig.timeSigIndex != null) ? clickConfig.timeSigIndex : 2;

    // Pre-load the backing buffers BEFORE choosing startAt, so the scheduled start
    // is always in the future no matter how long the OPFS reads / sample decodes take.
    const monitorItems = [];
    if (overdub) {
      for (const t of existingTracks) monitorItems.push({ key: t.key, meta: t.meta, buffer: await loadStemBuffer(audioCtx, slug, t.meta, folderHandle) });
    }
    let kitBuffers = null, drumIr = null;
    if (drumsEnabled) { kitBuffers = await loadKit(audioCtx, drumConfig.kit); drumIr = await loadEffect(audioCtx, drumConfig.effect); }

    const source = audioCtx.createMediaStreamSource(mediaStream);
    const slotNums = channelKeys.map((k) => (k ? Number(String(k).slice(4)) : 0)); // 'stem3' -> 3, null -> 0 (discard)
    const node = new AudioWorkletNode(audioCtx, 'capture-processor', {
      numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: capture, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      // beginFrame Infinity keeps the gate shut until we send the real begin frame AFTER
      // the count-in / drum backing / overdub playback is scheduled (below), so setup
      // latency can never desync them. Needed whenever anything is scheduled (overdub,
      // count-in, or drums); a bare first pass (none enabled) records from frame 0.
      processorOptions: { channelCount: capture, slots: slotNums, beginFrame: scheduled ? Number.MAX_SAFE_INTEGER : 0 },
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
      if (typeof msg.frames === 'number') {
        // Capture meter tick: map each channel's peak to its destination slot key
        // (peaks[c] <-> channelKeys[c], positional; null channels are discards and skipped)
        // and drive the record clock.
        const levels = {};
        const pk = msg.peaks || [];
        for (let c = 0; c < channelKeys.length; c++) { if (channelKeys[c]) levels[channelKeys[c]] = lv(pk[c] || 0); }
        onLevels && onLevels({ source: 'capture', levels, master: null });
        onClock && onClock({ mode: 'record', elapsedSec: msg.frames / audioCtx.sampleRate, durationSec: null });
        return;
      }
      // Sequence auto-stop: the worklet's endFrame gate reached the sequence end — run the
      // NORMAL stop path (flush -> drain -> finalize -> onStatus('stopped')) so main.js
      // finalizes the take with no extra plumbing. Guarded so a manual Stop can't double-fire.
      if (msg.op === 'ended') { if (recording && !autoStopping) { autoStopping = true; stop('sequence-end'); } return; }
      if (!portTransferOk) {
        if (msg.op === 'append') takeStore.relayAppend(msg.stem, msg.bytes);
        else if (msg.op === 'drain') takeStore.relayDrain(msg.drainId); // relay the end-of-stream barrier too
      }
    };

    // Open this pass's stem files BEFORE the capture graph is connected, so the
    // worker's openTakeState is set before any audio can flow. A click-off first pass
    // has beginFrame 0 and records from the instant source->node connects; opening the
    // files afterward left a window where the first chunks reached the worker with no
    // take open. (Click-on/overdub keep the gate shut until 'begin', so they were never
    // exposed, but opening first is correct for every path.)
    const header = wavHeader(1, audioCtx.sampleRate, 0);
    const files = {};
    for (const key of slotKeys) files[key] = stemFileName(slug, take, key);
    await takeStore.openTakeFiles('takes/' + slug + '/', files, header, SIZE_FIELDS);
    recordEpoch++; // this take's WAV(s) were just truncated/overwritten — invalidate any cached playback buffers

    // A silent sink so the worklet is reliably pulled even though its own
    // output is never actually monitored (D5 — hardware-monitor-only).
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(audioCtx.destination);
    captureSource = source; captureSink = sink; // kept so teardownCaptureGraph can sever the whole path

    // Everything is wired; NOW pick a common t=0 in the near future. If a click is on,
    // run a 2-bar count-in from there and treat its first recorded downbeat as the
    // musical t=0; the backing (overdub) starts at that downbeat and the capture gate
    // opens one round-trip later. Click-off keeps today's behavior exactly (a click-off
    // first pass took the beginFrame:0 immediate path above and skips this block).
    if (scheduled) {
      const startAt = audioCtx.currentTime + 0.15;
      let musicStart = startAt; // ctx time of the first RECORDED bar's downbeat

      if (countInEnabled) {
        // The 2-bar count-in CUE only (countInOnly) — the drums, not a recording click, are
        // the take's backing. The cue establishes the downbeat, then stops.
        clickEngine = makeClick(audioCtx, masterBus); // cue follows the monitor fader (D35)
        const info = clickEngine.start({
          bpm, timeSigIndex,
          subdivision: (clickConfig && clickConfig.subdivision) || 1,
          accentIndex: (clickConfig && clickConfig.accentIndex) || 1,
          startAt, countInBars: 2, countInOnly: true,
        });
        musicStart = info.musicStartTime;
      }

      if (drumsEnabled) {
        // Drum backing from the downbeat on the monitor bus — heard by the performer, NEVER
        // captured (the worklet records only the mic source). Loops for the whole take.
        drumMachine = makeDrumMachine({ ctx: audioCtx, dest: masterBus });
        drumMachine.load({ config: drumConfig, buffers: kitBuffers, irBuffer: drumIr, bpm, timeSigIndex });
        // A sequence take plays its flattened pattern ONCE for autoStopSec then stops; a
        // single-loop/grid take loops for the whole take (Infinity).
        drumMachine.start(musicStart, autoStopSec != null ? autoStopSec : Infinity);
      }

      if (overdub) startMonitorFromBuffers(monitorItems, musicStart);
      // Compensate the capture gate by the monitor round-trip so the DI's sample 0 aligns with the
      // count-in downbeat + backing at t=0 on later playback. A measured/manual calibration is used
      // verbatim; UNCALIBRATED, the round-trip is AUTO-ESTIMATED from the live context output
      // latency + the input track's reported latency + the comp lookahead (never a bare 0, which
      // left every uncalibrated take lagging the drums by the full round-trip). Monitor-only
      // sources (drums/count-in) are heard but never captured.
      const shift = resolveMonitorLatencySec({
        source: monitorLatencySource,
        storedSec: monitorLatencySec,
        outputLatency: audioCtx.outputLatency,
        baseLatency: audioCtx.baseLatency,
        inputLatency: settings.latency, // MediaTrackSettings.latency (seconds), may be undefined
      });
      const beginFrame = Math.round((musicStart + shift) * audioCtx.sampleRate);
      // Sequence auto-stop: close the capture gate exactly autoStopSec after it opens, so the
      // stem is EXACTLY the sequence length (sample-accurate), aligned to the drums. The worklet
      // posts {op:'ended'} when it crosses endFrame; 0 = no auto-stop (record until manual Stop).
      const endFrame = autoStopSec != null ? beginFrame + Math.round(autoStopSec * audioCtx.sampleRate) : 0;
      node.port.postMessage({ op: 'begin', beginFrame, endFrame });
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
    stopClick(); // silence the metronome the instant Stop is hit, before the flush wait

    // Snapshot the node: a stray late message must never touch whatever `workletNode`
    // the outer closure points at BY THEN (a subsequent record() may have already
    // replaced it, or teardownCaptureGraph() may have nulled it).
    const node = workletNode;
    if (node) {
      // Drain barrier (sample-perfect tails): register a drainId-correlated waiter, tell
      // the worklet to flush AND emit its end-of-stream marker stamped with that id, then
      // wait for the worker to confirm every append (including the final flush chunk) is
      // written BEFORE finalizing. The marker rides the SAME channel as the appends (the
      // worker port, or the main-thread relay), so it can't overtake them. The 500 ms race
      // is the liveness net for a lost/late drain (suspended context / wedged worker) — the
      // same bound the old flush-ack had, with the same worst case (finalize anyway). The
      // persistent node.port handler stays active: it relays the drain in the fallback and
      // harmlessly ignores the {flushed:true} ack.
      const { id: drainId, promise: drained } = takeStore.awaitDrain();
      node.port.postMessage({ op: 'flush', drainId });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        drained.then(() => { clearTimeout(timer); resolve(); });
      });
    }

    // finalize -> teardown -> report is a strict sequence, but the deck UI is fully
    // gated on the caller's `deckRecording`, which only clears when onStatus('stopped')
    // runs at the end of this function. So teardown and the onStatus report MUST run
    // even if finalize ever rejects — otherwise a single failed finalize would strand
    // the deck (every control disabled, only a refresh recovers). Guard accordingly.
    let dataBytes = {};
    try {
      dataBytes = await takeStore.finalizeTakeFiles();
    } catch { /* finalize failed — fall through so we still tear down + report */ }
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
    stopClick();
    stopDrums();
    stopMonitor();
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    // Sever the whole capture path. The worklet self-removes on its flush (process()
    // returns false once closed); disconnecting the source and sink too guarantees it
    // is out of the render graph even on a teardown that skipped the flush (an abrupt
    // interruption/dispose), so it can never keep posting meters or appends.
    if (captureSource) { try { captureSource.disconnect(); } catch { /* already disconnected */ } captureSource = null; }
    if (workletNode) { try { workletNode.disconnect(); } catch { /* already disconnected */ } workletNode = null; }
    if (captureSink) { try { captureSink.disconnect(); } catch { /* already disconnected */ } captureSink = null; }
  }

  // ---- playback (lazy-loads the take if it isn't already the loaded one) ----
  async function loadTake(take, slug, folderHandle) {
    disposePlayback();
    const audioCtx = await ensureContext();
    const sumBus = audioCtx.createGain();
    sumBus.gain.value = 1;
    sumBus.connect(masterBus); // playback mix follows the monitor fader (D35)
    const masterTap = makeTap(audioCtx);
    sumBus.connect(masterTap);  // master meter taps PRE-fader (D34): "is the mix clipping", not headphone loudness
    const stems = {};
    for (const key of STEM_KEYS) {
      const stemMeta = take.stems && take.stems[key];
      if (!stemMeta || !stemMeta.file) { stems[key] = null; continue; }
      const buffer = await loadStemBuffer(audioCtx, slug, stemMeta, folderHandle);
      const chain = buildEffectChain(audioCtx, stemMeta);
      chain.output.connect(sumBus);
      const tap = makeTap(audioCtx); chain.output.connect(tap); // per-track playback meter (D34)
      stems[key] = { buffer, chain, tap, activeSource: null };
    }
    // Drum backing (if the take has drums): its own graph -> sumBus (so it follows the monitor
    // fader + master meter with the stems). Started in play() off the SAME startAt as the stems.
    let drum = null;
    if (take.drums && take.drums.enabled) {
      const kitBuffers = await loadKit(audioCtx, take.drums.kit);
      const irBuffer = await loadEffect(audioCtx, take.drums.effect);
      drum = makeDrumMachine({ ctx: audioCtx, dest: sumBus });
      const dbpm = (take.click && take.click.bpm) || 120;
      const dtsi = (take.click && take.click.timeSigIndex != null) ? take.click.timeSigIndex : 2;
      drum.load({ config: take.drums, buffers: kitBuffers, irBuffer, bpm: dbpm, timeSigIndex: dtsi });
    }
    playChains = { slug, take: take.take, epoch: recordEpoch, sumBus, masterTap, stems, drum };
  }

  function disposePlayback() {
    stopPlaySources();
    if (playChains) {
      if (playChains.drum) { try { playChains.drum.dispose(); } catch { /* already disposed */ } }
      try { playChains.sumBus.disconnect(); } catch { /* already disconnected */ }
    }
    playChains = null;
  }

  function stopPlaySources() {
    if (playChains) {
      for (const key of STEM_KEYS) {
        const s = playChains.stems[key];
        if (s && s.activeSource) { try { s.activeSource.onended = null; s.activeSource.stop(); } catch { /* already stopped */ } s.activeSource = null; }
      }
      if (playChains.drum) { try { playChains.drum.stop(); } catch { /* already stopped */ } }
    }
    playState = null;
    maybeStopMeterLoop();
  }

  async function play(take, slug, folderHandle) {
    const want = { slug, take: take.take, epoch: recordEpoch };
    if (playbackCacheStale(playChains, want)) await loadTake(take, slug, folderHandle);
    stopPlaySources();
    const audioCtx = ctx;
    const startAt = audioCtx.currentTime + 0.1; // all stems start together -> sample-locked
    const stemDur = maxKeyDuration(STEM_KEYS, take) || take.durationSec || 0;
    const seqSec = drumSequenceSeconds(take);   // >0 only for a sequence take (else it loops)
    const durationSec = Math.max(stemDur, seqSec);
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
    if (any) {
      playState = { startAt, durationSec };
      startMeterLoop();
      // Sequence take: drums play their EXACT flattened length once (n%total never wraps, so no
      // end-of-take stutter and the outro isn't cut). Single-loop/grid take: loop for the stems.
      if (playChains.drum) playChains.drum.start(startAt, seqSec > 0 ? seqSec : stemDur);
    }
    if (primary) primary.onended = () => {
      onClock && onClock({ mode: 'play', elapsedSec: durationSec, durationSec }); // land the counter on the exact end
      stopPlaySources();                                                          // clears activeSource/playState, stops the loop
      onStatus && onStatus({ type: 'ended' });
    };
    return any;
  }

  async function replay(take, slug, folderHandle) {
    const want = { slug, take: take.take, epoch: recordEpoch };
    if (!playbackCacheStale(playChains, want)) stopPlaySources();
    return play(take, slug, folderHandle);
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
  async function renderMonoMix(keys, take, slug, opts = {}, folderHandle = null) {
    const stemDur = maxKeyDuration(keys, take);
    // A sequence take's flattened pattern defines the arrangement length; extend the render to
    // cover it (in case the outro rings past the stems) but only when drums are included.
    const seqSec = opts.drums ? drumSequenceSeconds(take) : 0;
    const durationSec = Math.max(stemDur, seqSec);
    const includeDrums = !!(opts.drums && take.drums && take.drums.enabled && durationSec > 0);
    const pad = includeDrums ? 0.5 : 0.05; // a late drum hit (crash) can ring past durationSec; comp tail otherwise
    const frames = Math.max(1, Math.ceil((durationSec + pad) * BOUNCE_RATE));
    const offlineCtx = new OfflineAudioContext(1, frames, BOUNCE_RATE);
    const sumBus = offlineCtx.createGain();
    sumBus.gain.value = 1;
    sumBus.connect(offlineCtx.destination);
    let any = false;
    for (const key of keys) {
      const stemMeta = take.stems && take.stems[key];
      if (!stemMeta || !stemMeta.file) continue;
      const buffer = await loadStemBuffer(offlineCtx, slug, stemMeta, folderHandle);
      const chain = buildEffectChain(offlineCtx, stemMeta);
      chain.output.connect(sumBus);
      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(chain.input);
      source.start(0);
      any = true;
    }
    // Drums printed into the mix (opt-in per bounce). Pre-scheduled deterministically into the
    // SAME sumBus, so they sum + master exactly like a stem. Only the master bounce passes this;
    // the ping-pong sub-mix (bounceTracks) never does.
    if (includeDrums) {
      const kitBuffers = await loadKit(offlineCtx, take.drums.kit);
      const irBuffer = await loadEffect(offlineCtx, take.drums.effect);
      const dbpm = (take.click && take.click.bpm) || 120;
      const dtsi = (take.click && take.click.timeSigIndex != null) ? take.click.timeSigIndex : 2;
      // Sequence: render the drums for their EXACT length (play once); else the stem length (loop).
      renderDrumsOffline(offlineCtx, sumBus, { config: take.drums, buffers: kitBuffers, irBuffer, bpm: dbpm, timeSigIndex: dtsi, startAt: 0, durationSec: seqSec > 0 ? seqSec : durationSec });
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
  // Render + master a take to one mono WAV WITHOUT persisting it — the shared core of
  // both MIX (bounce, which then writes it) and EXPORT (onExportDeck, which shares/
  // downloads the bytes). Returns { ok, bytes, lufs } so the two paths cannot diverge.
  async function renderMaster(take, slug, opts = {}, folderHandle = null) {
    const { mono } = await renderMonoMix(STEM_KEYS, take, slug, { drums: !!opts.includeDrums }, folderHandle);
    if (!mono) return { ok: false, error: 'take has no tracks to bounce' };
    const measured = integratedLoudness([mono], BOUNCE_RATE);
    const gainDb = bounceGainDb(measured);
    if (gainDb !== 0) { const g = Math.pow(10, gainDb / 20); for (let i = 0; i < mono.length; i++) mono[i] *= g; }
    limit([mono], BOUNCE_RATE, LIMITER_CEILING_DB);
    return { ok: true, bytes: encodeMonoWav(mono), lufs: measured === -Infinity ? null : measured };
  }

  // ---- master bounce (AC-13/14): render + persist the mastered mix to OPFS. The
  // caller records the bounce in the manifest with loc:'opfs' (a re-Save migrates it). ----
  async function bounce(take, slug, opts = {}, folderHandle = null) {
    const r = await renderMaster(take, slug, opts, folderHandle);
    if (!r.ok) return r;
    const filename = mixFileName(slug, take.take);
    await takeStore.writeFile('takes/' + slug + '/' + filename, r.bytes);
    return { ok: true, file: filename, lufs: r.lufs };
  }

  // ---- ping-pong bounce: sum ONE source track + the destination track (both
  // effected) into the destination's mono file, freeing the source slot. No LUFS
  // normalization (an internal sub-mix — normalizing would corrupt inter-track
  // balance); a brick-wall limiter guards the two-track sum from clipping. The
  // caller updates the manifest (free src, reset dst to neutral) + deletes the src. ----
  async function bounceTracks(take, srcKey, dstKey, slug, folderHandle = null) {
    const src = take.stems && take.stems[srcKey];
    const dst = take.stems && take.stems[dstKey];
    if (!src || !src.file || !dst || !dst.file) return { ok: false, error: 'both tracks must have audio' };
    const { mono, durationSec } = await renderMonoMix([srcKey, dstKey], take, slug, {}, folderHandle);
    if (!mono) return { ok: false, error: 'nothing to bounce' };
    limit([mono], BOUNCE_RATE, LIMITER_CEILING_DB);
    await takeStore.writeFile('takes/' + slug + '/' + dst.file, encodeMonoWav(mono));
    recordEpoch++; // dst WAV overwritten in place under the same take number — invalidate cached playback buffers
    return { ok: true, srcKey, dstKey, durationSec };
  }

  // ---- overdub latency calibration (§ measured, not guessed) ----
  // Fire a series of clicks THROUGH the real playback chain (so the compressor's
  // fixed latency is included, exactly as the backing experiences it) and capture
  // the input via the worklet's measure mode. The user provides the loopback (a
  // cable EVO out->in, or acoustically mic-to-headphones). Each click's return is
  // located on the AudioContext sample clock, so the measured round trip needs no
  // outputLatency/getOutputTimestamp (unreliable / absent on iPadOS < 18.4). The
  // median of several trials, applied verbatim as monitorLatencySec, aligns an
  // overdub to the backing.
  async function calibrateLatency({ deviceId, onProgress } = {}) {
    const N = 7, SPACING = 0.6, LEAD = 0.4, SEARCH = 0.5, TAIL = 0.25;
    const acquired = await devices.acquireForRecording(deviceId);
    if (!acquired.ok) return { ok: false, reason: 'Microphone access is blocked.' };
    const stream = acquired.stream;
    const audioCtx = await ensureContext();
    await addWorkletModule(audioCtx);
    const sr = audioCtx.sampleRate;

    const source = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, 'capture-processor', {
      numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      processorOptions: { channelCount: 1, measure: true },
    });
    const sink = audioCtx.createGain(); sink.gain.value = 0;
    source.connect(node); node.connect(sink); sink.connect(audioCtx.destination);

    // Position-anchored capture buffer: each chunk is written at its absolute frame
    // (robust to a dropped quantum) relative to the first chunk's frame.
    const totalSec = LEAD + N * SPACING + SEARCH + TAIL;
    const cap = new Float32Array(Math.ceil((totalSec + 0.5) * sr));
    let firstFrame = -1;
    node.port.onmessage = (e) => {
      const m = e.data; if (!m || !m.measure) return;
      if (firstFrame < 0) firstFrame = m.startFrame;
      const off = m.startFrame - firstFrame;
      if (off >= 0 && off < cap.length) cap.set(m.measure.subarray(0, Math.min(m.measure.length, cap.length - off)), off);
    };

    // A 2 ms windowed 2 kHz click, played through the real chain (comp latency incl.).
    const clickLen = Math.round(0.002 * sr);
    const clickBuf = audioCtx.createBuffer(1, clickLen, sr);
    const cd = clickBuf.getChannelData(0);
    for (let i = 0; i < clickLen; i++) cd[i] = 0.9 * Math.sin((2 * Math.PI * 2000 * i) / sr) * (1 - i / clickLen);
    const chain = buildEffectChain(audioCtx, defaultStemSettings());
    chain.output.connect(audioCtx.destination);

    const startAt = audioCtx.currentTime + LEAD;
    const emitFrames = [];
    for (let k = 0; k < N; k++) {
      const at = startAt + k * SPACING;
      emitFrames.push(Math.round(at * sr));
      const s = audioCtx.createBufferSource();
      s.buffer = clickBuf; s.connect(chain.input); s.start(at);
      if (onProgress) onProgress((k + 1) / N);
    }

    await new Promise((resolve) => setTimeout(resolve, (totalSec + 0.2) * 1000));
    await new Promise((resolve) => {
      const prev = node.port.onmessage;
      node.port.onmessage = (e) => { if (e.data && e.data.flushed) { resolve(); return; } prev && prev(e); };
      node.port.postMessage({ op: 'flush' });
      setTimeout(resolve, 300);
    });

    try { source.disconnect(); node.disconnect(); sink.disconnect(); chain.output.disconnect(); } catch { /* already disconnected */ }
    stream.getTracks().forEach((t) => t.stop());

    if (firstFrame < 0) return { ok: false, reason: 'No audio captured — check the input.' };

    // For each click, search its own window [emit, emit+SEARCH]; the detected onset
    // index (from the window start = the emit frame) IS the round trip in samples.
    const searchLen = Math.round(SEARCH * sr);
    const rtts = [];
    for (let k = 0; k < N; k++) {
      const winStart = emitFrames[k] - firstFrame;
      if (winStart < 0 || winStart >= cap.length) { rtts.push(null); continue; }
      const win = cap.subarray(winStart, Math.min(cap.length, winStart + searchLen));
      const onset = detectClickSample(win);
      rtts.push(onset < 0 ? null : rttSeconds(emitFrames[k] + onset, emitFrames[k], sr));
    }
    // Drop the first (graph warm-up), then median the rest.
    const summary = summarizeTrials(rtts.slice(1));
    return { ok: summary.ok, rttSec: summary.medianSec, spreadMs: summary.spreadMs, reason: summary.reason };
  }

  // The live AudioContext latency figures, so the CAL panel can DISPLAY the uncalibrated
  // auto-estimate (nulls before a context exists). Never persisted — recomputed each render.
  function getContextLatency() {
    return ctx ? { outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency } : { outputLatency: null, baseLatency: null };
  }

  // ---- pre-record audition (Phase 8): play a config's pattern ONCE, no capture, no take ----
  // Used by the DRUMS panel's ←/→ loop audition and the "preview sequence" button. Re-rolls are
  // the CALLER's concern (it builds a fresh flattened config); this just sounds whatever it's given.
  function stopPreview() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    if (previewMachine) { try { previewMachine.dispose(); } catch { /* already disposed */ } previewMachine = null; }
  }
  async function previewPattern({ config, bpm, timeSigIndex, durationSec }) {
    const audioCtx = await ensureContext();
    try { if (audioCtx.state !== 'running') await audioCtx.resume(); } catch { /* gesture-gated elsewhere */ }
    const kitBuffers = await loadKit(audioCtx, config.kit);
    const irBuffer = await loadEffect(audioCtx, config.effect);
    stopPreview();
    const machine = makeDrumMachine({ ctx: audioCtx, dest: masterBus });
    machine.load({ config, buffers: kitBuffers, irBuffer, bpm, timeSigIndex });
    const at = audioCtx.currentTime + 0.08;
    machine.start(at, durationSec);
    previewMachine = machine;
    previewTimer = setTimeout(stopPreview, Math.max(200, (durationSec + 0.5) * 1000));
  }

  function dispose() {
    if (recording) stop('interrupted');
    stopMeterLoop();
    stopClick();
    stopDrums();
    stopMonitor();
    stopPreview();
    disposePlayback();
    if (wakeLock) { try { wakeLock.release(); } catch { /* already released */ } wakeLock = null; }
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } ctx = null; masterBus = null; }
  }

  return { probe, record, stop, play, replay, stopPlay, invalidatePlayback: disposePlayback, renderMaster, bounce, bounceTracks, applySettings, setMasterVol, calibrateLatency, getContextLatency, previewPattern, stopPreview, dispose };
}
