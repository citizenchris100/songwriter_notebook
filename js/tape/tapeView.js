// js/tape/tapeView.js — the deck UI (§5.6). Built with dom.js's h(), called
// fresh on every songsView.update() (the same rebuild-from-view-model discipline
// as the rest of the Songs tab). The AudioContext/graph-owning controller
// (js/tape/audioEngine.js) is NOT built here — main.js owns ONE instance for the
// lifetime of the app (its own module scope is never torn down, so the
// AudioContext survives every rebuild without needing a special DOM container).
//
// Two things in this view genuinely cannot go through a full render(): the
// elapsed timer + level meters (mutated at ~10 Hz from the worklet) and the
// inline play-status text (mirrors sketchesView's makeSketchPlayer.setStatus
// idiom exactly). Both are handed back to the caller as `live` — one small
// "current DOM node" registration per render, exactly like the sketches player.
import { h } from '../dom.js';
import { STEM_KEYS } from './takeModel.js';

const STEM_LABELS = { stem1: 'Mic 1', stem2: 'Mic 2' };

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } };
const rowOf = (child) => { const r = h('div', 'row'); r.appendChild(child); return r; };
const banner = (kind, text) => h('div', 'tapebanner ' + kind, text);

// Build the whole deck subview. `deck` is the tape-deck slice of the view-model
// (assembled by main.js's songViewModel()); `handlers` are the callbacks from
// main.js (§5.7's named list, plus onPlayTake/onReplayTake/onStopPlayTake — the
// ephemeral, non-persisting playback controls; they mutate no persisted state,
// so they don't touch the manifest, but they still have to reach the
// AudioContext-owning controller that only main.js holds a reference to).
// Returns { el, live }.
export function buildDeckView(deck, handlers, songName) {
  const {
    onCloseTapeDeck, onRecordTake, onStopTake, onKeepTake, onDiscardLastTake, onCancelRetake,
    onDeleteTake, onSelectTake, onSelectInput, onPreviewStemSetting, onSetStemSetting,
    onBounceTake, onShareTake, onPlayTake, onReplayTake, onStopPlayTake,
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
  title.appendChild(h('div', 'subtitle', 'Take ' + (deck.currentTakeNo || '—') + (deck.path ? ' · ' + deck.path : '')));
  head.append(back, title);
  wrap.appendChild(head);

  // ---- status banners ----
  if (deck.blocked) wrap.appendChild(banner('err', 'Microphone access is blocked — enable it in Settings for this site.'));
  else if (deck.unsupported) wrap.appendChild(banner('err', 'Recording needs a current Safari or Chrome (this browser lacks on-device audio storage).'));
  else if (deck.noInterface) wrap.appendChild(banner('warn', 'No 2-input audio interface detected — the built-in mic records one channel only.'));
  if (deck.warnMoreThanTwo) wrap.appendChild(banner('warn', 'This interface has more than two inputs — only the first two will be recorded.'));
  if (deck.status && deck.status.message) wrap.appendChild(banner(deck.status.type === 'error' ? 'err' : 'warn', deck.status.message));
  if (deck.spaceWarning) wrap.appendChild(banner('warn', 'Storage is running low. Delete a take to free space, or export what you need to keep.'));

  // ---- input picker (AC-25) ----
  if (deck.inputs && deck.inputs.length > 1) {
    const card = h('div', 'card grow');
    card.appendChild(h('span', 'lbl', 'Input'));
    const sel = h('select');
    deck.inputs.forEach((d) => { const o = h('option', null, d.label); o.value = d.deviceId; sel.appendChild(o); });
    sel.value = deck.selectedInputId || '';
    sel.addEventListener('change', () => onSelectInput(sel.value));
    card.appendChild(sel);
    wrap.appendChild(rowOf(card));
  }

  // ---- take menu: choose which take loads after a stop-after-retake (AC-8) ----
  if (deck.takeMenuOpen) wrap.appendChild(takeMenu(deck, onSelectTake));

  // ---- transport ----
  const transport = transportSection(deck, { onRecordTake, onStopTake, onPlayTake, onReplayTake, onStopPlayTake, songId: deck.songId });
  wrap.appendChild(transport.el);
  live.timerEl = transport.timerEl;
  live.meterEls = transport.meterEls;
  live.setPlayStatus = transport.setPlayStatus;

  // ---- stem strips (vol/EQ/comp) — shown while recording OR a take is loaded ----
  if (deck.showStrips && deck.loadedTake) wrap.appendChild(stemStrips(deck, { onPreviewStemSetting, onSetStemSetting }));

  // ---- retake / bounce / share for the loaded take ----
  if (deck.showLoadedActions && deck.loadedTake) {
    wrap.appendChild(loadedActions(deck, { onKeepTake, onDiscardLastTake, onCancelRetake, onBounceTake, onShareTake }));
  }

  // ---- take history (AC-10, AC-22, AC-23) ----
  wrap.appendChild(takeHistory(deck, { onSelectTake, onDeleteTake, onShareTake }));

  wrap.appendChild(h('div', 'feel-empty tapenote', 'Takes live on this device — Share/Export any take you can’t lose.'));

  return { el: wrap, live };
}

function transportSection(deck, ctx) {
  const box = h('div', 'card grow tapetransport');

  if (deck.recording) {
    const timerEl = h('div', 'tapetimer', '0:00');
    const meterWrap = h('div', 'tapemeters');
    const meterEls = {};
    STEM_KEYS.forEach((key) => {
      const stem = deck.loadedTake && deck.loadedTake.stems && deck.loadedTake.stems[key];
      if (!stem) return;
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
    box.append(timerEl, meterWrap, rowOf(stopBtn));
    return { el: box, timerEl, meterEls, setPlayStatus: null };
  }

  if (deck.bouncing) {
    box.appendChild(h('div', 'feel-empty pad', 'Bouncing…'));
    return { el: box, timerEl: null, meterEls: null, setPlayStatus: null };
  }

  if (!deck.loadedTake) {
    box.appendChild(h('div', 'feel-empty pad', deck.hasHistory ? 'No current take. Record a new one.' : 'No takes yet — hit Record.'));
    const recBtn = h('button', 'btn primary grow', '● Record');
    recBtn.disabled = !!(deck.blocked || deck.unsupported);
    recBtn.addEventListener('click', () => ctx.onRecordTake());
    box.appendChild(rowOf(recBtn));
    return { el: box, timerEl: null, meterEls: null, setPlayStatus: null };
  }

  // A take is loaded: Play / Stop / Replay (ephemeral — ends in the audioEngine
  // controller directly, not a manifest-mutating handler; sketches precedent).
  const take = deck.loadedTake;
  box.appendChild(h('div', 'subtitle', 'Take ' + take.take + (take.recovered ? ' (recovered)' : '') + ' · ' + fmtTime(take.durationSec)));
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
  return { el: box, timerEl: null, meterEls: null, setPlayStatus: (t) => setStat(t) };
}

function stemStrips(deck, handlers) {
  const wrap = h('div', 'row');
  STEM_KEYS.forEach((key) => {
    const stem = deck.loadedTake.stems && deck.loadedTake.stems[key];
    if (!stem) return;
    wrap.appendChild(stemStrip(key, stem, handlers));
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

function stemStrip(stemKey, stem, handlers) {
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

  return card;
}

// Retake (AC-7) reuses the same inline-confirm-bar idiom as the per-take Delete
// row and songsView's own Delete-song confirm: the Keep/Discard/Cancel bar is
// built up front (hidden) and toggled with a plain classList flip, no re-render
// needed to open it (only Keep/Discard actually change persisted state).
function loadedActions(deck, handlers) {
  const wrap = h('div', 'col');
  const row = h('div', 'row tapeloaded');

  const retakeBtn = h('button', 'btn', 'Retake');
  const retakeBar = h('div', 'namebar hidden');
  const keepBtn = h('button', 'btn mini', 'Keep');
  const discardBtn = h('button', 'btn mini danger', 'Discard');
  const cancelBtn = h('button', 'btn mini', 'Cancel');
  retakeBar.append(h('span', 'savehint', 'Keep the last take, or discard it and record again?'), keepBtn, discardBtn, cancelBtn);
  retakeBtn.addEventListener('click', () => retakeBar.classList.remove('hidden'));
  keepBtn.addEventListener('click', () => handlers.onKeepTake());
  discardBtn.addEventListener('click', () => handlers.onDiscardLastTake());
  cancelBtn.addEventListener('click', () => { retakeBar.classList.add('hidden'); handlers.onCancelRetake(); });
  row.appendChild(retakeBtn);

  const bounceBtn = h('button', 'btn primary', 'Bounce');
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

  wrap.append(row, retakeBar);
  return wrap;
}

function takeMenu(deck, onSelectTake) {
  const box = h('div', 'card grow takemenu');
  box.appendChild(h('span', 'lbl', 'Choose a take'));
  // AC-8: "the newest take is preselected; dismissing the menu loads the
  // newest." takeMenuTakes is sorted newest-first (main.js), and the take that
  // just finished recording — the reason this menu is open — is always the
  // highest-numbered ACTIVE one, so index 0 is always a real, selectable take.
  const newest = (deck.takeMenuTakes || [])[0];
  if (newest) {
    const dismissBtn = h('button', 'btn mini', '✕ Use newest (Take ' + newest.take + ')');
    dismissBtn.addEventListener('click', () => onSelectTake(newest.take));
    box.appendChild(rowOf(dismissBtn));
  }
  const list = h('div', 'savedlist');
  (deck.takeMenuTakes || []).forEach((t, i) => {
    const row = h('div', 'saved' + (t.status === 'discarded' ? ' tombstone' : ''));
    row.appendChild(h('div', 'nm', 'Take ' + t.take + (t.status === 'discarded' ? ' (discarded)' : '') + (t.recovered ? ' (recovered)' : '')));
    row.appendChild(h('div', 'stuning', fmtWhen(t.createdAt) + (t.durationSec != null ? ' · ' + fmtTime(t.durationSec) : '')));
    if (t.status !== 'discarded') {
      row.addEventListener('click', () => onSelectTake(t.take));
      if (i === 0) row.classList.add('on');
    }
    list.appendChild(row);
  });
  box.appendChild(list);
  return box;
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
  const when = h('div', 'stuning', fmtWhen(t.createdAt) + ' · ' + fmtTime(t.durationSec));
  const loadBtn = h('button', 'btn mini', 'Load');
  loadBtn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onSelectTake(t.take); });
  // AC-10: active rows offer Load, Share, and Delete. Share the finished mix
  // when one exists, else the first available stem — reachable without first
  // Loading the take (loadedActions' per-file buttons cover the loaded take).
  const shareRef = (t.bounce && t.bounce.file) ? 'bounce' : (t.stems && t.stems.stem1 && t.stems.stem1.file) ? 'stem1' : (t.stems && t.stems.stem2 && t.stems.stem2.file) ? 'stem2' : null;
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
