// js/tape/drumPanel.js — the DRUMS flip-panel (replaces the old CLICK panel). Browser-only,
// built with dom.js h() + deckControls widgets, rebuilt every render like the rest of the deck.
// The drum ENGINE (js/tape/drumMachine.js) is owned by audioEngine; this only EDITS the per-take
// draft drum config — main.js's handlers persist it (localStorage) and it applies at record/play.
//
// Tempo + count-in live on the take's CLICK config (shared with the count-in), so BPM/count-in
// write via onSetClick; everything drum-specific writes via onSetDrums / the grid handlers.
import { h } from '../dom.js';
import { buildKnob, buildLedMeter } from './deckControls.js';
import { METER_SEGMENTS } from './meterModel.js';
import { VOICES, KITS, EFFECTS, STEPS_PER_BAR, SWING_MAX } from './drumModel.js';
import { countInSeconds } from './clickModel.js';

export function buildDrumPanel(box, deck, handlers, meterSetters) {
  box.classList.add('drumpanel');
  const cfg = deck.drumConfig || null;
  const click = deck.clickConfig || { bpm: 120, countIn: false, timeSigIndex: 2 };

  const enabled = !!(cfg && cfg.enabled);
  const header = h('div', 'row');
  header.appendChild(h('div', 'subtitle', 'Drum machine'));
  const toggle = h('button', 'btn mini' + (enabled ? ' primary' : ''), enabled ? 'Drums: On' : 'Drums: Off');
  toggle.addEventListener('click', () => handlers.onSetDrums({ enabled: !enabled }));
  header.appendChild(toggle);
  box.appendChild(header);
  // Editing a RECORDED take's drums (vs the new-take draft): changes persist to the take and are
  // heard on the next play — the recorded tracks are untouched (drums regenerate from config).
  if (deck.drumOnTake) box.appendChild(h('div', 'feel-empty', 'Editing take ' + (deck.currentTakeNo || '') + '’s drums — changes apply on the next play.'));
  if (!enabled) return;

  // ---- top controls: BPM (click), count-in (click), kit, effect, mix, swing ----
  const ctrls = h('div', 'drumctrls');
  // BPM is LOCKED once the take is recorded — the recorded audio is fixed at that tempo, so
  // changing it would drift the drums against the tracks. Everything else stays editable.
  ctrls.appendChild(numCtl(deck.drumOnTake ? 'BPM (locked)' : 'BPM', 20, 300, click.bpm, (v) => handlers.onSetClick({ bpm: v }), deck.drumOnTake));
  const ci = h('button', 'btn mini' + (click.countIn ? ' primary' : ''), click.countIn ? 'Count-in: 2 bars' : 'Count-in: off');
  ci.addEventListener('click', () => handlers.onSetClick({ countIn: !click.countIn }));
  const ciCtl = h('div', 'drumctl'); ciCtl.append(h('span', 'lbl', 'Count-in'), ci); ctrls.appendChild(ciCtl);
  ctrls.appendChild(selCtl('Kit', KITS.map((k) => [k.id, k.label]), cfg.kit, (v) => handlers.onSetDrums({ kit: v })));
  ctrls.appendChild(selCtl('Effect', EFFECTS.map((e) => [e.id, e.label]), cfg.effect, (v) => handlers.onSetDrums({ effect: v })));
  ctrls.appendChild(rangeCtl('Mix', 0, 1, 0.01, cfg.effectMix, (v) => handlers.onSetDrums({ effectMix: v })));
  ctrls.appendChild(rangeCtl('Swing', 0, SWING_MAX, 0.01, cfg.swing, (v) => handlers.onSetDrums({ swing: v })));
  box.appendChild(ctrls);

  // ---- MIDI import ----
  const imp = h('div', 'row');
  const file = h('input'); file.type = 'file'; file.accept = '.mid,.midi'; file.style.display = 'none';
  file.addEventListener('change', () => { if (file.files && file.files[0]) { handlers.onImportDrumMidi(file.files[0]); file.value = ''; } });
  const impBtn = h('button', 'btn mini', 'Import MIDI…');
  impBtn.addEventListener('click', () => file.click());
  imp.append(impBtn, file);
  if (cfg.source && cfg.source.type === 'midi') imp.appendChild(h('span', 'savehint', 'pattern loaded from MIDI'));
  box.appendChild(imp);
  if (click.countIn) box.appendChild(h('div', 'feel-empty', '2-bar count-in ≈ ' + countInSeconds(click.bpm, click.timeSigIndex != null ? click.timeSigIndex : 2).toFixed(1) + ' s before recording.'));

  // ---- bar scroller ----
  const bars = (cfg.pattern && cfg.pattern.bars) || 1;
  const bar = Math.max(0, Math.min(bars - 1, deck.drumBar || 0));
  const scroller = h('div', 'drumbars');
  const prev = h('button', 'btn mini', '‹'); prev.disabled = bar <= 0; prev.addEventListener('click', () => handlers.onSetDrumBar(bar - 1));
  const next = h('button', 'btn mini', '›'); next.disabled = bar >= bars - 1; next.addEventListener('click', () => handlers.onSetDrumBar(bar + 1));
  const addB = h('button', 'btn mini', '+ bar'); addB.addEventListener('click', () => handlers.onSetDrumBars(bars + 1));
  const delB = h('button', 'btn mini', '− bar'); delB.disabled = bars <= 1; delB.addEventListener('click', () => handlers.onSetDrumBars(bars - 1));
  scroller.append(prev, h('span', 'lbl', 'Bar ' + (bar + 1) + ' / ' + bars), next, addB, delB);
  box.appendChild(scroller);

  // ---- the step grid (12 voices × 16 steps for the visible bar; vol/pitch per voice) ----
  const gridWrap = h('div', 'drumgridwrap');
  const grid = h('div', 'drumgrid');
  // Rows are drawn bottom-up (kick at the bottom, cymbals/percussion at the top) — the drum-machine
  // convention. Only the DISPLAY reverses; VOICES stays the canonical order for the model/GM map.
  [...VOICES].reverse().forEach((v) => {
    const rowEl = h('div', 'drumrow');
    rowEl.appendChild(h('div', 'drumvoice', v.label));
    const cells = h('div', 'drumcells');
    const arr = (cfg.pattern.grid && cfg.pattern.grid[v.id]) || [];
    for (let i = 0; i < STEPS_PER_BAR; i++) {
      const gStep = bar * STEPS_PER_BAR + i;
      const vel = arr[gStep] || 0;
      const cell = h('button', 'drumcell' + (vel > 0 ? ' on' : '') + (i % 4 === 0 ? ' beat' : ''));
      if (vel > 0) cell.style.setProperty('--v', vel.toFixed(2));
      cell.addEventListener('click', () => handlers.onToggleDrumCell(v.id, gStep));
      cells.appendChild(cell);
    }
    rowEl.appendChild(cells);
    const vv = (cfg.voices && cfg.voices[v.id]) || { vol: 1, pitch: 1 };
    const vp = h('div', 'drumvp');
    vp.appendChild(miniRange('vol', 0, 1.5, 0.01, vv.vol, (val) => handlers.onSetDrums({ voices: { [v.id]: { ...vv, vol: val } } })));
    vp.appendChild(miniRange('pit', 0.25, 4, 0.01, vv.pitch, (val) => handlers.onSetDrums({ voices: { [v.id]: { ...vv, pitch: val } } })));
    rowEl.appendChild(vp);
    grid.appendChild(rowEl);
  });
  gridWrap.appendChild(grid);
  box.appendChild(gridWrap);

  // ---- drum master strip: HI/MID/LO EQ + one-knob CMP + a meter ----
  const m = cfg.master || { vol: 1, eq: { bass: 0, mid: 0, treble: 0 }, comp: 0 };
  const strip = h('div', 'drummaster');
  strip.appendChild(h('div', 'lbl', 'DRUM MASTER'));
  const knobs = h('div', 'tsknobs');
  const mk = (label, min, max, step, val, detent, patch) => buildKnob({
    label, value: val, min, max, step, detent, disabled: false,
    onCommit: (x) => handlers.onSetDrums(patch(x)), // no live preview: drums are silent while editing the draft
  }).el;
  knobs.append(
    mk('HI', -12, 12, 0.5, m.eq.treble, 0, (x) => ({ master: { ...m, eq: { ...m.eq, treble: x } } })),
    mk('MID', -12, 12, 0.5, m.eq.mid, 0, (x) => ({ master: { ...m, eq: { ...m.eq, mid: x } } })),
    mk('LO', -12, 12, 0.5, m.eq.bass, 0, (x) => ({ master: { ...m, eq: { ...m.eq, bass: x } } })),
    mk('CMP', 0, 1, 0.01, m.comp, 0, (x) => ({ master: { ...m, comp: x } })),
  );
  strip.appendChild(knobs);
  const meter = buildLedMeter({ segments: METER_SEGMENTS });
  if (meterSetters) meterSetters.drum = meter.set;
  strip.appendChild(meter.el);
  box.appendChild(strip);
}

// ---- small local control builders ----
function numCtl(label, min, max, val, onChange, disabled) {
  const c = h('div', 'drumctl');
  c.appendChild(h('span', 'lbl', label));
  const inp = h('input', 'drumnum'); inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = '1'; inp.value = String(val);
  if (disabled) inp.disabled = true;
  else inp.addEventListener('change', () => onChange(Number(inp.value)));
  c.appendChild(inp);
  return c;
}
function selCtl(label, options, value, onChange) {
  const c = h('div', 'drumctl');
  c.appendChild(h('span', 'lbl', label));
  const sel = h('select');
  options.forEach(([v, t]) => { const o = h('option', null, t); o.value = String(v); sel.appendChild(o); });
  sel.value = String(value);
  sel.addEventListener('change', () => onChange(sel.value));
  c.appendChild(sel);
  return c;
}
function rangeCtl(label, min, max, step, val, onChange) {
  const c = h('div', 'drumctl');
  c.appendChild(h('span', 'lbl', label));
  const inp = h('input', 'drumrange'); inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(val);
  inp.addEventListener('change', () => onChange(Number(inp.value))); // commit on release — no mid-drag render (D32)
  c.appendChild(inp);
  return c;
}
function miniRange(label, min, max, step, val, onChange) {
  const wrap = h('div', 'drumvpctl');
  wrap.appendChild(h('span', 'drumvplbl', label));
  const inp = h('input', 'drumrange mini'); inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(val);
  inp.title = label;
  inp.addEventListener('change', () => onChange(Number(inp.value)));
  wrap.appendChild(inp);
  return wrap;
}
