// js/tape/tapeView.js — the deck UI (§5.6). Built with dom.js's h(), called fresh
// on every songsView.update() (the same rebuild-from-view-model discipline as the
// rest of the Songs tab). The AudioContext/graph-owning controller
// (js/tape/audioEngine.js) is NOT built here — main.js owns ONE instance for the
// lifetime of the app (its own module scope is never torn down, so the
// AudioContext survives every rebuild without needing a special DOM container).
//
// A take is a 4-TRACK CONTAINER filled over multiple passes. Each pass records into
// currently-free slots via input->track routing; tracks can be ping-ponged (bounced
// one onto another) to free slots for more recording; retake re-records only the
// last group. Mono forever — the master bounce and every track are single-channel.
//
// Two things in this view genuinely cannot go through a full render(): the elapsed
// timer + level meters (mutated at ~10 Hz from the worklet) and the inline
// play-status text. Both are handed back as `live` — one small "current DOM node"
// registration per render, exactly like the sketches player.
import { h } from '../dom.js';
import { STEM_KEYS } from './takeModel.js';

const STEM_LABELS = { stem1: 'Track 1', stem2: 'Track 2', stem3: 'Track 3', stem4: 'Track 4' };

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } };
const rowOf = (child) => { const r = h('div', 'row'); r.appendChild(child); return r; };
const banner = (kind, text) => h('div', 'tapebanner ' + kind, text);
const labelList = (keys) => (keys || []).map((k) => STEM_LABELS[k]).join(' & ');

// Build the whole deck subview. `deck` is the tape-deck slice of the view-model
// (assembled by main.js's tapeDeckViewModel()); `handlers` are the callbacks from
// main.js. Returns { el, live }.
export function buildDeckView(deck, handlers, songName) {
  const {
    onCloseTapeDeck, onNewTake, onArmRecordPass, onSetRoutingSlot, onStopTake,
    onDiscardLastGroup, onBounceStemToTrack, onBounceTake, onDeleteTake, onSelectTake,
    onSelectInput, onSetMonitorLatency, onCalibrateLatency, onPreviewStemSetting, onSetStemSetting, onShareTake,
    onPlayTake, onReplayTake, onStopPlayTake,
  } = handlers;

  const wrap = h('div', 'songswrap tapewrap');
  const live = { timerEl: null, meterEls: null, setPlayStatus: null };

  // ---- header (AC-18: song name, take #, OPFS path) ----
  const head = h('div', 'row tapehead');
  const back = h('button', 'btn mini', '‹ Back to song');
  back.disabled = !!deck.recording;
  if (deck.recording) back.title = 'Stop recording first';
  back.addEventListener('click', () => { if (!deck.recording) onCloseTapeDeck(); });
  const title = h('div', 'tapetitle');
  title.appendChild(h('div', 'nm', songName || ''));
  const takeLabel = deck.pendingNewTake ? 'New take' : ('Take ' + (deck.currentTakeNo || '—'));
  title.appendChild(h('div', 'subtitle', takeLabel + (deck.path ? ' · ' + deck.path : '')));
  head.append(back, title);
  wrap.appendChild(head);

  // ---- status banners ----
  if (deck.blocked) wrap.appendChild(banner('err', 'Microphone access is blocked — enable it in Settings for this site.'));
  else if (deck.unsupported) wrap.appendChild(banner('err', 'Recording needs a current Safari or Chrome (this browser lacks on-device audio storage).'));
  else if (deck.noInterface) wrap.appendChild(banner('warn', 'No multi-input audio interface detected — the built-in mic records one track at a time.'));
  if (deck.warnMoreThanMax) wrap.appendChild(banner('warn', 'This interface has more than four inputs — only the first four are available per pass.'));
  if (deck.status && deck.status.message) wrap.appendChild(banner(deck.status.type === 'error' ? 'err' : 'warn', deck.status.message));
  if (deck.spaceWarning) wrap.appendChild(banner('warn', 'Storage is running low. Delete a take to free space, or export what you need to keep.'));

  // ---- input picker (AC-25) ----
  if (deck.inputs && deck.inputs.length > 1 && !deck.recording) {
    const card = h('div', 'card grow');
    card.appendChild(h('span', 'lbl', 'Input'));
    const sel = h('select');
    deck.inputs.forEach((d) => { const o = h('option', null, d.label); o.value = d.deviceId; sel.appendChild(o); });
    sel.value = deck.selectedInputId || '';
    sel.addEventListener('change', () => onSelectInput(sel.value));
    card.appendChild(sel);
    wrap.appendChild(rowOf(card));
  }

  // ---- transport ----
  const transport = transportSection(deck, { onNewTake, onArmRecordPass, onSetRoutingSlot, onSetMonitorLatency, onCalibrateLatency, onStopTake, onPlayTake, onReplayTake, onStopPlayTake, songId: deck.songId });
  wrap.appendChild(transport.el);
  live.timerEl = transport.timerEl;
  live.meterEls = transport.meterEls;
  live.setPlayStatus = transport.setPlayStatus;

  // ---- track strips (vol/EQ/comp + per-track bounce) — shown while recording OR a take is loaded ----
  if (deck.showStrips && deck.loadedTake) wrap.appendChild(trackStrips(deck, { onPreviewStemSetting, onSetStemSetting, onBounceStemToTrack }));

  // ---- retake / master bounce / share for the loaded take ----
  if (deck.showLoadedActions && deck.loadedTake) {
    wrap.appendChild(loadedActions(deck, { onDiscardLastGroup, onBounceTake, onShareTake }));
  }

  // ---- take history (AC-10, AC-22, AC-23) ----
  wrap.appendChild(takeHistory(deck, { onSelectTake, onDeleteTake, onShareTake }));

  wrap.appendChild(h('div', 'feel-empty tapenote', 'Takes live on this device — Share/Export any take you can’t lose.'));

  return { el: wrap, live };
}

// The arm-pass routing panel (AC-2/25): one row per available input mapping it to a
// currently-free track slot, defaulted from deck.routing, plus the Record button.
function armPanel(deck, ctx) {
  const box = h('div', 'col armpanel');
  const maxCap = deck.maxCapture || 0;
  const free = deck.freeSlotKeys || [];
  box.appendChild(h('div', 'subtitle', 'Record ' + maxCap + ' track' + (maxCap === 1 ? '' : 's') + ' this pass · ' + deck.inputChannels + ' input' + (deck.inputChannels === 1 ? '' : 's') + ' → ' + deck.freeSlots + ' free'));
  const routing = deck.routing || [];
  for (let i = 0; i < maxCap; i++) {
    const row = h('div', 'row routerow');
    row.appendChild(h('span', 'lbl', 'Input ' + (i + 1) + ' →'));
    const sel = h('select');
    free.forEach((key) => { const o = h('option', null, STEM_LABELS[key]); o.value = key; sel.appendChild(o); });
    sel.value = routing[i] || free[i] || '';
    sel.addEventListener('change', () => ctx.onSetRoutingSlot(i, sel.value));
    row.appendChild(sel);
    box.appendChild(row);
  }
  if (deck.inputChannels > deck.freeSlots) box.appendChild(banner('warn', 'More inputs than free tracks — only ' + deck.freeSlots + ' will be recorded this pass.'));
  // Overdub timing: the tracks play back and you monitor via the interface; this
  // shifts a new track earlier to cancel the interface's round-trip delay so it
  // lands in time. Only relevant once there are tracks to play under the new one.
  if (deck.filledCount > 0) box.appendChild(latencyPanel(deck, ctx));
  const recBtn = h('button', 'btn primary grow', '● Record');
  recBtn.disabled = !!(deck.blocked || deck.unsupported || maxCap < 1);
  recBtn.addEventListener('click', () => ctx.onArmRecordPass());
  box.appendChild(rowOf(recBtn));
  return box;
}

// Overdub timing panel: a measured round-trip (via the loopback calibration) or a
// manual value, applied as the shift that lands a new track in time with the backing.
function latencyPanel(deck, ctx) {
  const lat = deck.monitorLatency || { ms: 0, source: 'none', spreadMs: null };
  const box = h('div', 'col armpanel');
  const desc = lat.source === 'measured'
    ? 'Overdub sync: ' + lat.ms + ' ms measured' + (lat.spreadMs != null ? ' (±' + lat.spreadMs + ' ms)' : '')
    : lat.source === 'manual'
      ? 'Overdub sync: ' + lat.ms + ' ms (manual)'
      : 'Overdub sync: none — playback + capture only';
  box.appendChild(h('div', 'subtitle', desc));
  const row = h('div', 'row routerow');
  row.appendChild(h('span', 'lbl', 'Latency (ms)'));
  const latIn = h('input', 'tapedial-range');
  latIn.type = 'number'; latIn.min = '0'; latIn.max = '400'; latIn.step = '1'; latIn.value = String(lat.ms || 0);
  latIn.style.width = '5rem';
  latIn.addEventListener('change', () => ctx.onSetMonitorLatency(Number(latIn.value) || 0));
  const calBtn = h('button', 'btn mini', deck.calibrating ? 'Calibrating…' : 'Calibrate');
  calBtn.disabled = !!(deck.calibrating || deck.blocked || deck.unsupported);
  calBtn.addEventListener('click', () => ctx.onCalibrateLatency());
  row.append(latIn, calBtn);
  box.appendChild(row);
  box.appendChild(h('div', 'feel-empty', 'Loop the EVO output to input 1 (or hold the mic to your headphones), then Calibrate. Or type a value if you already know it.'));
  return box;
}

function transportSection(deck, ctx) {
  const box = h('div', 'card grow tapetransport');

  if (deck.recording) {
    const timerEl = h('div', 'tapetimer', '0:00');
    const meterWrap = h('div', 'tapemeters');
    const meterEls = {};
    (deck.recordingSlotKeys || []).forEach((key) => {
      const row = h('div', 'meterrow');
      row.appendChild(h('span', 'meterlabel', STEM_LABELS[key]));
      const bar = h('div', 'meterbar');
      const fill = h('div', 'meterfill');
      bar.appendChild(fill);
      row.appendChild(bar);
      meterWrap.appendChild(row);
      meterEls[key] = fill;
    });
    const stopBtn = h('button', 'btn primary grow', '■ Stop');
    stopBtn.addEventListener('click', () => ctx.onStopTake());
    box.append(h('div', 'subtitle', deck.overdub ? 'Overdub — backing tracks playing' : 'Recording'), timerEl, meterWrap, rowOf(stopBtn));
    return { el: box, timerEl, meterEls, setPlayStatus: null };
  }

  if (deck.bouncing) {
    box.appendChild(h('div', 'feel-empty pad', 'Bouncing…'));
    return { el: box, timerEl: null, meterEls: null, setPlayStatus: null };
  }

  let setPlayStatus = null;

  // A loaded take with audio: Play / Stop / Replay (ephemeral — ends in the
  // audioEngine controller directly, not a manifest-mutating handler).
  if (deck.loadedTake) {
    const take = deck.loadedTake;
    box.appendChild(h('div', 'subtitle', 'Take ' + take.take + (take.recovered ? ' (recovered)' : '') + ' · ' + fmtTime(take.durationSec) + ' · ' + deck.filledCount + '/4 tracks'));
    const btnRow = h('div', 'row');
    const playBtn = h('button', 'btn mini', '▶ Play');
    const stopBtn = h('button', 'btn mini', '■ Stop');
    const replayBtn = h('button', 'btn mini', '↻ Replay');
    const pstat = h('span', 'sketch-pstat');
    const setStat = (t) => { pstat.textContent = t; };
    playBtn.addEventListener('click', async () => { setStat('Loading…'); setStat((await ctx.onPlayTake(take, ctx.songId)) ? 'Playing' : 'Audio unavailable'); });
    replayBtn.addEventListener('click', async () => { setStat('Loading…'); setStat((await ctx.onReplayTake(take, ctx.songId)) ? 'Playing' : 'Audio unavailable'); });
    stopBtn.addEventListener('click', () => { ctx.onStopPlayTake(); setStat(''); });
    btnRow.append(playBtn, stopBtn, replayBtn, pstat);
    box.appendChild(btnRow);
    setPlayStatus = (t) => setStat(t);
  } else {
    box.appendChild(h('div', 'feel-empty pad', deck.pendingNewTake ? 'New take — route your inputs and hit Record.' : (deck.hasHistory ? 'No take loaded. Record a new one, or load one from history below.' : 'No takes yet — route your inputs and hit Record.')));
  }

  // Arm a pass into free slots, or explain the full-take options.
  if (deck.freeSlots > 0 && deck.maxCapture > 0) box.appendChild(armPanel(deck, ctx));
  else if (deck.loadedTake) box.appendChild(h('div', 'feel-empty', 'All 4 tracks are full — bounce a track onto another to free one, or start a new take.'));

  // + New take (a fresh empty 4-track container).
  const newBtn = h('button', 'btn mini', '+ New take');
  newBtn.disabled = !!(deck.blocked || deck.unsupported);
  newBtn.addEventListener('click', () => ctx.onNewTake());
  box.appendChild(rowOf(newBtn));

  return { el: box, timerEl: null, meterEls: null, setPlayStatus };
}

function trackStrips(deck, handlers) {
  const wrap = h('div', 'row');
  STEM_KEYS.forEach((key) => {
    const stem = deck.loadedTake.stems && deck.loadedTake.stems[key];
    if (!stem || !stem.file) return;
    wrap.appendChild(trackStrip(key, stem, deck, handlers));
  });
  return wrap;
}

function dial(label, min, max, step, value, onInput, onChange) {
  const box = h('div', 'tapedial');
  box.appendChild(h('span', 'tapedial-label', label));
  const input = h('input', 'tapedial-range');
  input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  input.addEventListener('input', () => onInput(Number(input.value)));       // capture-only, no render (D32)
  input.addEventListener('change', () => onChange(Number(input.value)));     // pointer-up: persist debounced + render
  box.appendChild(input);
  return box;
}

function trackStrip(stemKey, stem, deck, handlers) {
  const card = h('div', 'card grow tapestrip');
  card.appendChild(h('span', 'lbl', STEM_LABELS[stemKey]));

  const patch = (fields) => ({ ...fields });
  const preview = (fields) => handlers.onPreviewStemSetting(stemKey, patch(fields));
  const commit = (fields) => handlers.onSetStemSetting(stemKey, patch(fields));

  card.appendChild(dial('Vol', 0, 1.5, 0.01, stem.vol,
    (v) => preview({ vol: v }), (v) => commit({ vol: v })));
  card.appendChild(dial('Bass', -12, 12, 0.5, stem.eq.bass,
    (v) => preview({ eq: { ...stem.eq, bass: v } }), (v) => commit({ eq: { ...stem.eq, bass: v } })));
  card.appendChild(dial('Mid', -12, 12, 0.5, stem.eq.mid,
    (v) => preview({ eq: { ...stem.eq, mid: v } }), (v) => commit({ eq: { ...stem.eq, mid: v } })));
  card.appendChild(dial('Treble', -12, 12, 0.5, stem.eq.treble,
    (v) => preview({ eq: { ...stem.eq, treble: v } }), (v) => commit({ eq: { ...stem.eq, treble: v } })));
  card.appendChild(dial('Comp', 0, 1, 0.01, stem.comp,
    (v) => preview({ comp: v }), (v) => commit({ comp: v })));

  // Per-track ping-pong bounce (freeing this slot): pick a destination from the
  // OTHER filled tracks. Inline confirm bar, plain classList toggle (no re-render).
  if (deck.canBounceTracks) {
    const others = (deck.filledSlotKeys || []).filter((k) => k !== stemKey);
    if (others.length) {
      const bounceBtn = h('button', 'btn mini', 'Bounce ▸');
      const bar = h('div', 'namebar hidden');
      bar.appendChild(h('span', 'savehint', 'Bounce ' + STEM_LABELS[stemKey] + ' into… (frees this track)'));
      others.forEach((k) => {
        const b = h('button', 'btn mini', STEM_LABELS[k]);
        b.addEventListener('click', () => handlers.onBounceStemToTrack(stemKey, k));
        bar.appendChild(b);
      });
      const cancel = h('button', 'btn mini', 'Cancel');
      cancel.addEventListener('click', () => bar.classList.add('hidden'));
      bar.appendChild(cancel);
      bounceBtn.addEventListener('click', () => bar.classList.remove('hidden'));
      card.append(bounceBtn, bar);
    }
  }

  return card;
}

// Retake (rescoped to the last recorded group) + master bounce + per-file Share.
// The retake bar reuses the inline-confirm-bar idiom (built hidden, toggled with a
// classList flip): re-recording erases only the last pass's tracks (AC: retake
// affects only the last recorded set of tracks) and re-arms them for recording.
function loadedActions(deck, handlers) {
  const wrap = h('div', 'col');
  const row = h('div', 'row tapeloaded');

  if (deck.lastGroupKeys && deck.lastGroupKeys.length) {
    const retakeBtn = h('button', 'btn', 'Retake last group');
    const retakeBar = h('div', 'namebar hidden');
    const redoBtn = h('button', 'btn mini danger', 'Re-record');
    const cancelBtn = h('button', 'btn mini', 'Cancel');
    retakeBar.append(h('span', 'savehint', 'Re-record the last group (' + labelList(deck.lastGroupKeys) + ')? This erases it.'), redoBtn, cancelBtn);
    retakeBtn.addEventListener('click', () => retakeBar.classList.remove('hidden'));
    redoBtn.addEventListener('click', () => handlers.onDiscardLastGroup());
    cancelBtn.addEventListener('click', () => retakeBar.classList.add('hidden'));
    row.appendChild(retakeBtn);
    wrap.appendChild(retakeBar);
  }

  const bounceBtn = h('button', 'btn primary', 'Bounce to mix');
  bounceBtn.disabled = !!deck.bouncing;
  bounceBtn.addEventListener('click', () => handlers.onBounceTake());
  row.appendChild(bounceBtn);

  if (deck.loadedTake && deck.loadedTake.stems) {
    STEM_KEYS.forEach((key) => {
      const stem = deck.loadedTake.stems[key];
      if (!stem || !stem.file) return;
      const btn = h('button', 'btn mini', 'Share ' + STEM_LABELS[key]);
      btn.addEventListener('click', () => handlers.onShareTake(key));
      row.appendChild(btn);
    });
  }
  if (deck.loadedTake && deck.loadedTake.bounce && deck.loadedTake.bounce.file) {
    const btn = h('button', 'btn mini', 'Share Mix');
    btn.addEventListener('click', () => handlers.onShareTake('bounce'));
    row.appendChild(btn);
  }

  wrap.insertBefore(row, wrap.firstChild);
  return wrap;
}

function takeHistory(deck, handlers) {
  const box = h('div', 'card grow takehistory');
  box.appendChild(h('span', 'lbl', 'Take history'));
  const takes = (deck.manifestTakes || []).slice().sort((a, b) => b.take - a.take);
  if (!takes.length) { box.appendChild(h('div', 'feel-empty', 'No takes recorded yet.')); return box; }
  const list = h('div', 'savedlist');
  takes.forEach((t) => list.appendChild(historyRow(t, deck, handlers)));
  box.appendChild(list);
  return box;
}

// The count of filled tracks in a take (for the history "N/4 tracks" line).
function filledCountOf(t) {
  if (!t || !t.stems) return 0;
  return STEM_KEYS.reduce((n, k) => n + (t.stems[k] && t.stems[k].file ? 1 : 0), 0);
}
// First shareable ref for a take without loading it: the mix, else the first track.
function firstShareRef(t) {
  if (t.bounce && t.bounce.file) return 'bounce';
  if (!t.stems) return null;
  for (const k of STEM_KEYS) if (t.stems[k] && t.stems[k].file) return k;
  return null;
}

function historyRow(t, deck, handlers) {
  if (t.status === 'discarded') {
    const row = h('div', 'saved tombstone');
    row.appendChild(h('div', 'nm', 'Take ' + t.take + ' — discarded'));
    row.appendChild(h('div', 'stuning', fmtWhen(t.createdAt) + (t.durationSec != null ? ' · ' + fmtTime(t.durationSec) : '')));
    return row;
  }
  if (t.status === 'recording') {
    const row = h('div', 'saved');
    row.appendChild(h('div', 'nm', 'Take ' + t.take + ' — recording…'));
    return row;
  }
  const row = h('div', 'saved' + (t.take === deck.currentTakeNo ? ' on' : ''));
  const nm = h('div', 'nm', 'Take ' + t.take + (t.recovered ? ' (recovered)' : ''));
  const when = h('div', 'stuning', fmtWhen(t.createdAt) + ' · ' + fmtTime(t.durationSec) + ' · ' + filledCountOf(t) + '/4');
  const loadBtn = h('button', 'btn mini', 'Load');
  loadBtn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onSelectTake(t.take); });
  // AC-10: active rows offer Load, Share, and Delete. Share the finished mix when
  // one exists, else the first available track — reachable without first Loading.
  const shareRef = firstShareRef(t);
  const shareBtn = h('button', 'btn mini', 'Share');
  shareBtn.disabled = !shareRef;
  shareBtn.addEventListener('click', (e) => { e.stopPropagation(); if (shareRef) handlers.onShareTake(shareRef, t.take); });
  const delBtn = h('button', 'btn mini danger', '✕');
  delBtn.title = 'Delete take';
  delBtn.disabled = !!deck.bouncing; // a bounce in flight may be writing this exact take's mix file (AC-13/22 race)
  const confirmBar = h('div', 'namebar hidden');
  const delOk = h('button', 'btn mini danger', 'Delete');
  const delCancel = h('button', 'btn mini', 'Cancel');
  confirmBar.append(h('span', 'savehint', 'Delete take ' + t.take + '?'), delOk, delCancel);
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!deck.bouncing) confirmBar.classList.remove('hidden'); });
  delOk.addEventListener('click', (e) => { e.stopPropagation(); handlers.onDeleteTake(t.take); });
  delCancel.addEventListener('click', (e) => { e.stopPropagation(); confirmBar.classList.add('hidden'); });
  row.append(nm, when, loadBtn, shareBtn, delBtn);
  const wrap = h('div', 'historyrowwrap');
  wrap.append(row, confirmBar);
  return wrap;
}
