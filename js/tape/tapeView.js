// js/tape/tapeView.js — the deck UI, rebuilt as a 4-track PORTASTUDIO face (§5.6, Rev-4).
// Built with dom.js's h() and the widget builders in deckControls.js, called fresh on
// every songsView.update() (the same rebuild-from-view-model discipline as the rest of
// the Songs tab). The AudioContext/graph-owning controller (js/tape/audioEngine.js) is
// NOT built here — main.js owns ONE instance for the app's lifetime.
//
// Layout: four ALWAYS-present vertical channel strips (HI/MID/LO/COMP knobs, a fader +
// segmented LED meter, a REC arm button with an input badge, a BOUNCE button) plus a
// master strip (LED counter window + monitor fader + master meter), a function-button
// row, a piano-key transport, and a collapsible take log. A take is a 4-TRACK CONTAINER
// filled over multiple passes; mono forever.
//
// Three things can't go through a full render(): the LED meters + the counter time (both
// mutated at ~10-12 Hz from the engine) and the inline play-status. All three are handed
// back as `live` — { setLevels, setCounter, setPlayStatus } — refreshed every render, and
// driven by main.js's meter merge layer.
import { h } from '../dom.js';
import { STEM_KEYS } from './takeModel.js';
import { buildKnob, buildFader, buildLedMeter, buildCounter } from './deckControls.js';
import { buildDrumPanel } from './drumPanel.js';
import { METER_SEGMENTS } from './meterModel.js';

const STEM_LABELS = { stem1: 'Track 1', stem2: 'Track 2', stem3: 'Track 3', stem4: 'Track 4' };
const STEM_SHORT = { stem1: 'TRACK 1', stem2: 'TRACK 2', stem3: 'TRACK 3', stem4: 'TRACK 4' };

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } };
const labelList = (keys) => (keys || []).map((k) => STEM_LABELS[k]).join(' & ');

export function buildDeckView(deck, handlers, songName) {
  const {
    onCloseTapeDeck, onNewTake, onArmRecordPass, onArmTrack, onCycleInput, onStopTake,
    onDiscardLastGroup, onBounceStemToTrack, onBounceTake, onDeleteTake, onSelectTake,
    onSelectInput, onSetMonitorLatency, onCalibrateLatency, onSetClick,
    onPreviewStemSetting, onSetStemSetting, onPreviewMasterVol, onSetMasterVol,
    onTogglePanel, onToggleTakeLog, onShareTake,
    onPlayTake, onReplayTake, onStopPlayTake,
  } = handlers;

  const wrap = h('div', 'songswrap tapewrap');

  // ---- live refs: the LED meters, the counter, and the play-status text ----
  const meterSetters = {};   // 'stem1'..'stem4' + 'master' -> ledmeter.set(lit, clip)
  let counter = null;        // { el, timeEl, takeEl, statEl } once the master strip is built
  const setStat = (t) => { if (counter) counter.statEl.textContent = t; };
  const live = {
    setLevels(perKey, master) {
      if (perKey) for (const k of Object.keys(perKey)) { const s = meterSetters[k]; if (s) s(perKey[k].lit, perKey[k].clip); }
      if (master && meterSetters.master) meterSetters.master(master.lit, master.clip);
    },
    setCounter(clock) { if (counter && clock) counter.timeEl.textContent = fmtTime(clock.elapsedSec); },
    setPlayStatus: setStat,
  };

  // ---- header ----
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

  // ---- status strip: banners -> chips, input-device picker, one hint line ----
  wrap.appendChild(statusStrip(deck, { onSelectInput }));

  // ---- the deck face: 4 strips + master ----
  const face = h('div', 'tapedeck');
  const bounceBars = {}; // key -> the (hidden) full-width destination-confirm bar in the drawer
  STEM_KEYS.forEach((key) => face.appendChild(trackStrip(key, deck, handlers, meterSetters, bounceBars)));
  const master = masterStrip(deck, { onPreviewMasterVol, onSetMasterVol }, meterSetters);
  counter = master.counter;
  face.appendChild(master.el);
  wrap.appendChild(face);

  // ---- drawer: per-strip bounce destination-confirm bars (won't fit in a 63px strip) ----
  const drawer = h('div', 'tapedrawer');
  STEM_KEYS.forEach((key) => { if (bounceBars[key]) drawer.appendChild(bounceBars[key]); });
  wrap.appendChild(drawer);

  // ---- function row + its inline confirm bars ----
  wrap.appendChild(functionRow(deck, handlers));

  // ---- song-management row: Save / Export / Rename / Delete (the whole song, from the deck) ----
  wrap.appendChild(songManageRow(deck, handlers, songName));

  // ---- flip-open panel (drums / cal / share) ----
  if (deck.panelOpen) wrap.appendChild(flipPanel(deck, handlers, meterSetters));

  // ---- piano-key transport ----
  wrap.appendChild(transport(deck, { onArmRecordPass, onStopTake, onPlayTake, onReplayTake, onStopPlayTake, songId: deck.songId, setStat }));

  // ---- collapsible take log ----
  wrap.appendChild(takeLog(deck, { onSelectTake, onDeleteTake, onShareTake, onToggleTakeLog }));

  wrap.appendChild(h('div', 'feel-empty tapenote', 'Save writes takes into the song’s folder on disk (durable). Until then they live only on this device — the SAVE badge counts unsaved takes. EXPORT renders the current take to a WAV.'));

  return { el: wrap, live };
}

// ---- song-management row (Save / Export / Rename / Delete) ----
// Same fnbtn + inline-namebar idiom as functionRow, but acting on the whole SONG: Save
// migrates OPFS take audio + MIDI into the song's folder; Export renders a master WAV;
// Rename changes the display name; Delete removes the song + its on-disk artifacts.
function songManageRow(deck, handlers, songName) {
  const wrap = h('div', 'col');
  const row = h('div', 'fnrow');
  const busy = deck.recording || deck.bouncing || deck.saving;
  const haveAudio = !!deck.loadedTake && deck.filledCount > 0;

  const fn = (label, on, disabled, click) => {
    const b = h('button', 'fnbtn' + (on ? ' on' : ''), label);
    b.disabled = !!disabled;
    b.addEventListener('click', click);
    row.appendChild(b);
    return b;
  };

  // SAVE — migrate OPFS take audio + MIDI into the song's folder. No confirm; the count of
  // unsaved takes is shown in the label so the user knows what an eviction would cost.
  const pending = deck.takesPendingSave || 0;
  const saveLabel = deck.saving ? 'SAVING…' : (pending > 0 ? 'SAVE (' + pending + ')' : 'SAVE');
  fn(saveLabel, pending > 0, busy || (pending === 0 && deck.folderGranted), () => handlers.onSaveDeck());

  // EXPORT — render the loaded take to a mastered WAV (never persisted). Offer the drums
  // opt-in exactly like MIX when the take has drums.
  const hasDrums = !!(deck.loadedTake && deck.loadedTake.drums && deck.loadedTake.drums.enabled);
  const expBar = h('div', 'namebar hidden');
  if (hasDrums) {
    const chk = h('input'); chk.type = 'checkbox'; chk.checked = true;
    const lbl = h('label', 'savehint'); lbl.append(chk, ' Include drums in the master');
    const go = h('button', 'btn mini primary', 'Export'); go.addEventListener('click', () => { expBar.classList.add('hidden'); handlers.onExportDeck({ includeDrums: chk.checked }); });
    const cx = h('button', 'btn mini', 'Cancel'); cx.addEventListener('click', () => expBar.classList.add('hidden'));
    expBar.append(lbl, go, cx);
    fn('EXPORT', false, busy || !haveAudio, () => expBar.classList.remove('hidden'));
  } else {
    fn('EXPORT', false, busy || !haveAudio, () => handlers.onExportDeck());
  }

  // RENAME — a name input; commits the song's display name (id/on-disk names unchanged).
  const renameBar = h('div', 'namebar hidden');
  const nameIn = h('input', 'nameinput'); nameIn.type = 'text'; nameIn.value = songName || ''; nameIn.placeholder = 'Song name';
  const renameOk = h('button', 'btn mini primary', 'Rename');
  const renameCancel = h('button', 'btn mini', 'Cancel');
  const doRename = () => { const v = nameIn.value.trim(); renameBar.classList.add('hidden'); if (v) handlers.onRenameSongDeck(v); };
  renameOk.addEventListener('click', doRename);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRename(); });
  renameCancel.addEventListener('click', () => renameBar.classList.add('hidden'));
  renameBar.append(nameIn, renameOk, renameCancel);
  fn('RENAME', false, busy, () => { nameIn.value = songName || ''; renameBar.classList.remove('hidden'); nameIn.focus(); });

  // DELETE — danger confirm; removes the song + its <id>-scoped on-disk artifacts.
  const delBar = h('div', 'namebar hidden');
  const delOk = h('button', 'btn mini danger', 'Delete song');
  const delCancel = h('button', 'btn mini', 'Cancel');
  delBar.append(h('span', 'savehint', 'Delete this song and its saved take/MIDI files on disk? This cannot be undone.'), delOk, delCancel);
  delOk.addEventListener('click', () => { delBar.classList.add('hidden'); handlers.onDeleteDeck(); });
  delCancel.addEventListener('click', () => delBar.classList.add('hidden'));
  fn('DELETE', false, busy, () => delBar.classList.remove('hidden'));

  wrap.append(row, expBar, renameBar, delBar);
  return wrap;
}

// ---- status strip ----
function statusStrip(deck, ctx) {
  const box = h('div', 'tapestatus');
  const chip = (kind, text) => box.appendChild(h('div', 'tapechip ' + kind, text));
  if (deck.blocked) chip('err', 'Microphone access is blocked — enable it in Settings for this site.');
  else if (deck.unsupported) chip('err', 'Recording needs a current Safari or Chrome (no on-device audio storage here).');
  else if (deck.noInterface) chip('warn', 'No multi-input interface — the built-in mic records one track at a time.');
  if (deck.warnMoreThanMax) chip('warn', 'Interface has more than four inputs — only the first four are available.');
  if (deck.status && deck.status.message) chip(deck.status.type === 'error' ? 'err' : 'warn', deck.status.message);
  if (deck.spaceWarning) chip('warn', 'Storage is running low. Delete a take, or export what you need to keep.');

  if (deck.inputs && deck.inputs.length > 1 && !deck.recording) {
    const sel = h('select', 'tapein');
    deck.inputs.forEach((d) => { const o = h('option', null, d.label); o.value = d.deviceId; sel.appendChild(o); });
    sel.value = deck.selectedInputId || '';
    sel.addEventListener('change', () => ctx.onSelectInput(sel.value));
    box.appendChild(sel);
  }

  box.appendChild(h('div', 'tapehint', hintText(deck)));
  return box;
}

function hintText(deck) {
  if (deck.recording) return deck.overdub ? 'Overdub — backing tracks playing' : 'Recording…';
  if (deck.bouncing) return 'Bouncing…';
  if (deck.armed && deck.armed.length) return deck.armed.map((a) => 'IN ' + (a.inputIndex + 1) + ' → ' + STEM_LABELS[a.slotKey]).join('  ·  ');
  if (deck.pendingNewTake) return 'New take — tap a track’s REC to arm it, then press ● REC.';
  if (deck.loadedTake) return 'Take ' + deck.loadedTake.take + (deck.loadedTake.recovered ? ' (recovered)' : '') + ' · ' + fmtTime(deck.loadedTake.durationSec) + ' · ' + deck.filledCount + '/4 tracks';
  if (deck.hasHistory) return 'No take loaded — arm a track and record, or load one from the log below.';
  return 'No takes yet — tap a track’s REC to arm it, then press ● REC.';
}

// ---- one channel strip ----
function trackStrip(key, deck, handlers, meterSetters, bounceBars) {
  const st = deck.strips[key];
  const state = st.state; // 'empty' | 'armed' | 'recording' | 'filled'
  const filled = !!st.stem;
  const stem = st.stem || { vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 };
  const card = h('div', 'tapestrip ' + state);
  card.appendChild(h('div', 'tsname', STEM_SHORT[key]));

  // Knobs are live only when there's a playback chain to preview (a loaded, idle take).
  const knobsOn = filled && !deck.recording && !deck.bouncing;
  const mkKnob = (label, min, max, step, val, patchOf) => buildKnob({
    label, value: val, min, max, step, detent: 0, disabled: !knobsOn,
    onPreview: (v) => handlers.onPreviewStemSetting(key, patchOf(v)),
    onCommit: (v) => handlers.onSetStemSetting(key, patchOf(v)),
  }).el;
  const knobs = h('div', 'tsknobs');
  knobs.append(
    mkKnob('HI', -12, 12, 0.5, stem.eq.treble, (v) => ({ eq: { ...stem.eq, treble: v } })),
    mkKnob('MID', -12, 12, 0.5, stem.eq.mid, (v) => ({ eq: { ...stem.eq, mid: v } })),
    mkKnob('LO', -12, 12, 0.5, stem.eq.bass, (v) => ({ eq: { ...stem.eq, bass: v } })),
    mkKnob('CMP', 0, 1, 0.01, stem.comp, (v) => ({ comp: v })),
  );
  card.appendChild(knobs);

  // Fader + meter.
  const fader = buildFader({
    value: stem.vol, min: 0, max: 1.5, detent: 1.0, disabled: !knobsOn,
    onPreview: (v) => handlers.onPreviewStemSetting(key, { vol: v }),
    onCommit: (v) => handlers.onSetStemSetting(key, { vol: v }),
  });
  const meter = buildLedMeter({ segments: METER_SEGMENTS });
  meterSetters[key] = meter.set;
  const fm = h('div', 'tsfm');
  fm.append(fader.el, meter.el);
  card.appendChild(fm);

  // REC arm button (red dot) — armable only on a free/armed strip, off during record/bounce.
  const arm = h('button', 'tsarm' + ((state === 'armed' || state === 'recording') ? ' on' : ''));
  arm.append(h('span', 'recdot'), 'REC');
  const atCapacity = state === 'empty' && deck.armed.length >= deck.maxCapture;
  arm.disabled = deck.recording || deck.bouncing || deck.blocked || deck.unsupported
    || !(state === 'empty' || state === 'armed') || atCapacity;
  arm.addEventListener('click', () => handlers.onArmTrack(key));
  card.appendChild(arm);

  // Input badge on an armed/recording strip (tap to cycle when >1 input).
  if ((state === 'armed' || state === 'recording') && st.inputIndex != null) {
    const badge = h('button', 'tsin', 'IN ' + (st.inputIndex + 1));
    badge.disabled = deck.recording || deck.bouncing || deck.inputChannels < 2;
    badge.addEventListener('click', () => handlers.onCycleInput(key));
    card.appendChild(badge);
  }

  // BOUNCE ▸ (filled strips only, when a ping-pong is possible) -> reveals its drawer bar.
  if (filled && deck.canBounceTracks) {
    const others = (deck.filledSlotKeys || []).filter((k) => k !== key);
    if (others.length) {
      const bar = h('div', 'namebar hidden');
      bar.appendChild(h('span', 'savehint', 'Bounce ' + STEM_LABELS[key] + ' into… (frees this track)'));
      others.forEach((k) => { const b = h('button', 'btn mini', STEM_LABELS[k]); b.addEventListener('click', () => handlers.onBounceStemToTrack(key, k)); bar.appendChild(b); });
      const cancel = h('button', 'btn mini', 'Cancel'); cancel.addEventListener('click', () => bar.classList.add('hidden')); bar.appendChild(cancel);
      bounceBars[key] = bar;
      const btn = h('button', 'tsbounce', 'BNC ▸');
      btn.addEventListener('click', () => { Object.keys(bounceBars).forEach((k) => bounceBars[k].classList.add('hidden')); bar.classList.remove('hidden'); });
      card.appendChild(btn);
    }
  }

  return card;
}

// ---- master strip ----
function masterStrip(deck, ctx, meterSetters) {
  const card = h('div', 'tapestrip master');
  card.appendChild(h('div', 'tsname', 'MASTER'));

  const initTime = deck.recording ? 0 : (deck.loadedTake ? (deck.loadedTake.durationSec || 0) : 0);
  const counter = buildCounter({
    time: fmtTime(initTime),
    take: deck.counterTakeNo ? ('TAKE ' + deck.counterTakeNo) : '',
    stat: deck.bouncing ? 'BOUNCING' : (deck.overdub ? 'OVERDUB' : ''),
  });
  card.appendChild(counter.el);

  const fader = buildFader({
    value: deck.masterVol, min: 0, max: 1.5, detent: 1.0, disabled: false,
    onPreview: (v) => ctx.onPreviewMasterVol(v),
    onCommit: (v) => ctx.onSetMasterVol(v),
  });
  const meter = buildLedMeter({ segments: METER_SEGMENTS });
  meterSetters.master = meter.set;
  const fm = h('div', 'tsfm');
  fm.append(fader.el, meter.el);
  card.appendChild(fm);

  return { el: card, counter };
}

// ---- function row ----
function functionRow(deck, handlers) {
  const wrap = h('div', 'col');
  const row = h('div', 'fnrow');
  const haveAudio = !!deck.loadedTake && deck.filledCount > 0;
  const busy = deck.recording || deck.bouncing;

  const fn = (label, on, disabled, click) => {
    const b = h('button', 'fnbtn' + (on ? ' on' : ''), label);
    b.disabled = !!disabled;
    b.addEventListener('click', click);
    row.appendChild(b);
    return b;
  };

  // NEW TAKE — inline confirm bar.
  const newBar = h('div', 'namebar hidden');
  newBar.append(
    h('span', 'savehint', 'Start a new take? The current take stays in the log.'),
    (() => { const b = h('button', 'btn mini', 'Start'); b.addEventListener('click', () => { newBar.classList.add('hidden'); handlers.onNewTake(); }); return b; })(),
    (() => { const b = h('button', 'btn mini', 'Cancel'); b.addEventListener('click', () => newBar.classList.add('hidden')); return b; })(),
  );
  fn('NEW TAKE', false, busy || deck.blocked || deck.unsupported, () => newBar.classList.remove('hidden'));

  // RETAKE — inline confirm bar (re-records the last group).
  const retakeBar = h('div', 'namebar hidden');
  if (deck.lastGroupKeys && deck.lastGroupKeys.length) {
    retakeBar.append(
      h('span', 'savehint', 'Re-record the last group (' + labelList(deck.lastGroupKeys) + ')? This erases it.'),
      (() => { const b = h('button', 'btn mini danger', 'Re-record'); b.addEventListener('click', () => handlers.onDiscardLastGroup()); return b; })(),
      (() => { const b = h('button', 'btn mini', 'Cancel'); b.addEventListener('click', () => retakeBar.classList.add('hidden')); return b; })(),
    );
  }
  fn('RETAKE', false, busy || !(deck.lastGroupKeys && deck.lastGroupKeys.length), () => retakeBar.classList.remove('hidden'));

  // MIX — bounce to a mix WAV. If the loaded take has drums, an inline confirm offers to
  // include them in the printed mix (per-bounce, default on); otherwise it bounces directly.
  const hasDrums = !!(deck.loadedTake && deck.loadedTake.drums && deck.loadedTake.drums.enabled);
  const mixBar = h('div', 'namebar hidden');
  if (hasDrums) {
    const chk = h('input'); chk.type = 'checkbox'; chk.checked = true;
    const lbl = h('label', 'savehint'); lbl.append(chk, ' Include drums in the mix');
    const go = h('button', 'btn mini primary', 'Bounce'); go.addEventListener('click', () => { mixBar.classList.add('hidden'); handlers.onBounceTake({ includeDrums: chk.checked }); });
    const cx = h('button', 'btn mini', 'Cancel'); cx.addEventListener('click', () => mixBar.classList.add('hidden'));
    mixBar.append(lbl, go, cx);
    fn('MIX', false, busy || !haveAudio, () => mixBar.classList.remove('hidden'));
  } else {
    fn('MIX', false, busy || !haveAudio, () => handlers.onBounceTake());
  }
  fn('DRUMS', deck.drumConfig && deck.drumConfig.enabled, deck.recording, () => handlers.onTogglePanel('drums'));
  fn('CAL', deck.panelOpen === 'cal', deck.recording, () => handlers.onTogglePanel('cal'));
  fn('SHARE', deck.panelOpen === 'share', !haveAudio && !(deck.loadedTake && deck.loadedTake.bounce), () => handlers.onTogglePanel('share'));

  wrap.append(row, newBar, retakeBar, mixBar);
  return wrap;
}

// ---- flip-open panel ----
function flipPanel(deck, handlers, meterSetters) {
  const box = h('div', 'card grow tapepanel');
  if (deck.panelOpen === 'drums') buildDrumPanel(box, deck, handlers, meterSetters);
  else if (deck.panelOpen === 'cal') calPanel(box, deck, handlers);
  else if (deck.panelOpen === 'share') sharePanel(box, deck, handlers);
  return box;
}

function calPanel(box, deck, handlers) {
  const lat = deck.monitorLatency || { ms: 0, source: 'none', spreadMs: null };
  const desc = lat.source === 'measured'
    ? 'Overdub sync: ' + lat.ms + ' ms measured' + (lat.spreadMs != null ? ' (±' + lat.spreadMs + ' ms)' : '')
    : lat.source === 'manual' ? 'Overdub sync: ' + lat.ms + ' ms (manual)'
    : (lat.estimateMs > 0
        ? 'Overdub sync: ~' + lat.estimateMs + ' ms (auto-estimated from your device — Calibrate for exact)'
        : 'Overdub sync: none — playback + capture only');
  box.appendChild(h('div', 'subtitle', desc));
  const row = h('div', 'row routerow');
  row.appendChild(h('span', 'lbl', 'Latency (ms)'));
  const latIn = h('input', 'nameinput'); latIn.type = 'number'; latIn.min = '0'; latIn.max = '400'; latIn.step = '1'; latIn.value = String(lat.ms || 0); latIn.style.maxWidth = '6rem';
  latIn.addEventListener('change', () => handlers.onSetMonitorLatency(Number(latIn.value) || 0));
  const calBtn = h('button', 'btn mini', deck.calibrating ? 'Calibrating…' : 'Calibrate');
  calBtn.disabled = !!(deck.calibrating || deck.blocked || deck.unsupported);
  calBtn.addEventListener('click', () => handlers.onCalibrateLatency());
  row.append(latIn, calBtn);
  box.appendChild(row);
  box.appendChild(h('div', 'feel-empty', 'Loop the EVO output to input 1 (or hold the mic to your headphones), then Calibrate. Or type a value if you already know it.'));
}

function sharePanel(box, deck, handlers) {
  box.appendChild(h('div', 'subtitle', 'Share / Export'));
  const row = h('div', 'row');
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
  box.appendChild(row);
}

// ---- piano-key transport ----
function transport(deck, ctx) {
  const box = h('div', 'pkeys');
  const haveAudio = !!deck.loadedTake && deck.filledCount > 0;
  const key = (cls, glyph, label, disabled, click) => {
    const b = h('button', 'pkey ' + cls, '');
    b.append(h('span', 'pk-glyph', glyph), h('span', 'pk-lbl', label));
    b.disabled = !!disabled;
    b.addEventListener('click', click);
    box.appendChild(b);
    return b;
  };
  key('', '⏮', 'RTZ', deck.recording || deck.bouncing || !haveAudio, async () => {
    ctx.setStat('Loading…'); ctx.setStat((await ctx.onReplayTake(deck.loadedTake, ctx.songId)) ? 'Playing' : 'Audio unavailable');
  });
  key('', '▶', 'PLAY', deck.recording || deck.bouncing || !haveAudio, async () => {
    ctx.setStat('Loading…'); ctx.setStat((await ctx.onPlayTake(deck.loadedTake, ctx.songId)) ? 'Playing' : 'Audio unavailable');
  });
  key('', '■', 'STOP', deck.bouncing, () => { if (deck.recording) ctx.onStopTake(); else { ctx.onStopPlayTake(); ctx.setStat(''); } });
  key('rec' + (deck.recording ? ' on' : ''), '●', 'REC', deck.recording || deck.bouncing || !deck.canRecord, () => ctx.onArmRecordPass());
  return box;
}

// ---- collapsible take log ----
function takeLog(deck, handlers) {
  const takes = (deck.manifestTakes || []).slice().sort((a, b) => b.take - a.take);
  const details = h('details', 'tapelog');
  if (deck.logOpen) details.open = true;
  const sum = h('summary', null, 'TAPE LOG — ' + takes.length + ' take' + (takes.length === 1 ? '' : 's'));
  details.appendChild(sum);
  details.addEventListener('toggle', () => handlers.onToggleTakeLog(details.open));
  if (!takes.length) { details.appendChild(h('div', 'feel-empty', 'No takes recorded yet.')); return details; }
  const list = h('div', 'savedlist');
  takes.forEach((t) => list.appendChild(historyRow(t, deck, handlers)));
  details.appendChild(list);
  return details;
}

function filledCountOf(t) {
  if (!t || !t.stems) return 0;
  return STEM_KEYS.reduce((n, k) => n + (t.stems[k] && t.stems[k].file ? 1 : 0), 0);
}
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
  const shareRef = firstShareRef(t);
  const shareBtn = h('button', 'btn mini', 'Share');
  shareBtn.disabled = !shareRef;
  shareBtn.addEventListener('click', (e) => { e.stopPropagation(); if (shareRef) handlers.onShareTake(shareRef, t.take); });
  const delBtn = h('button', 'btn mini danger', '✕');
  delBtn.title = 'Delete take';
  delBtn.disabled = !!deck.bouncing; // a bounce in flight may be writing this take's mix file (AC-13/22 race)
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
