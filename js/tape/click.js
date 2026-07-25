// js/tape/click.js — IMPURE metronome click engine for the tape deck (browser only,
// never imported by the node engine test). A count-in + recording click scheduled on the
// SAME AudioContext the capture graph uses, so its beat grid is sample-phase-locked to
// the capture gate (captureProcessor.js's `currentFrame` IS ctx.currentTime*sampleRate,
// and the gate's beginFrame is computed off the same ctx clock).
//
// Monitor-only: output goes to the passed destination (ctx.destination), exactly like the
// overdub backing (audioEngine.startMonitorFromBuffers). The capture worklet records the
// mic MediaStreamSource, never the destination, so the click is heard by the performer but
// never captured — and it exists ONLY inside record() (playback/bounce never build it).
//
// One continuous lookahead scheduler (Chris Wilson "two clocks", ported from the standalone
// Metronome PWA): a coarse setTimeout wakes and pushes every tick inside the next
// SCHEDULE_AHEAD window onto the precise Web Audio clock; timing accuracy comes from
// osc.start(time), not setTimeout, so it is drift-free. The first `countInBars` bars use a
// DISTINCT voice (brighter triangle, raised band) from the recording click, but both share
// the exact same accent+subdivision pattern and grid phase.
import { TIME_SIGS, computeLevels } from './clickModel.js';

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

// Accent tier (0 beat / 1 group start / 2 downbeat) -> [freq, gain, dur]. Recording click
// = the standalone app's voices (sine); count-in = a brighter triangle in a raised band so
// the pre-roll is unmistakable.
const REC_BEAT = [[1100, 0.70, 0.045], [1300, 0.85, 0.048], [1600, 1.00, 0.050]];
const REC_SUB = [850, 0.32, 0.028];
const CUE_BEAT = [[1500, 0.80, 0.045], [1700, 0.90, 0.048], [2000, 1.00, 0.050]];
const CUE_SUB = [1150, 0.36, 0.028];

export function makeClick(audioCtx, destination) {
  const master = audioCtx.createGain();
  master.gain.value = 1;
  master.connect(destination || audioCtx.destination);

  let timer = null;
  let running = false;

  function tone(time, type, freq, gain, dur) {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(gain, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(env); env.connect(master);
    osc.start(time); osc.stop(time + dur + 0.02);
  }

  // start(...) -> { countInSec, musicStartTime }. Schedules a `countInBars` count-in
  // beginning at `startAt` (ctx time) that flows straight into an unbounded recording
  // click. `musicStartTime` = startAt + countInSec is the ctx time of the first RECORDED
  // bar's downbeat; the caller aligns the capture gate to it. countInTicks is a whole
  // number of bars, so tick countInTicks lands on a downbeat (posInBar 0) with zero drift.
  function start({ bpm, timeSigIndex, subdivision, accentIndex, startAt, countInBars = 2 }) {
    const beats = (TIME_SIGS[timeSigIndex] || TIME_SIGS[0]).beats;
    const sub = Math.max(1, Math.min(4, Math.round(subdivision) || 1));
    const levels = computeLevels(timeSigIndex, accentIndex);
    const secPerTick = (60 / bpm) / sub;
    const ticksPerBar = beats * sub;
    const countInTicks = countInBars * ticksPerBar;
    const countInSec = countInBars * beats * (60 / bpm);
    const musicStartTime = startAt + countInSec;

    let tick = 0;
    let nextTickTime = startAt;
    running = true;

    const schedule = () => {
      if (!running) return;
      while (nextTickTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
        const isCue = tick < countInTicks;              // count-in voice vs recording voice
        const posInBar = tick % ticksPerBar;            // continuous grid — cue + rec share phase
        const type = isCue ? 'triangle' : 'sine';
        if ((posInBar % sub) === 0) {
          const lvl = levels[Math.floor(posInBar / sub)] || 0;
          const v = (isCue ? CUE_BEAT : REC_BEAT)[lvl];
          tone(nextTickTime, type, v[0], v[1], v[2]);
        } else {
          const s = isCue ? CUE_SUB : REC_SUB;
          tone(nextTickTime, type, s[0], s[1], s[2]);
        }
        nextTickTime += secPerTick;
        tick++;
      }
      timer = setTimeout(schedule, LOOKAHEAD_MS);
    };
    schedule();
    return { countInSec, musicStartTime };
  }

  // Idempotent. Clears the lookahead timer (no new ticks) and fades the bus so the
  // <= SCHEDULE_AHEAD s of already-scheduled clicks don't tail-click on teardown.
  function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      master.gain.setTargetAtTime(0, audioCtx.currentTime, 0.005);
      setTimeout(() => { try { master.disconnect(); } catch { /* already gone */ } }, 250);
    } catch {
      try { master.disconnect(); } catch { /* already gone */ }
    }
  }

  return { start, stop };
}
