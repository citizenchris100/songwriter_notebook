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
import { countInSeconds, TIME_SIGS } from './clickModel.js';

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

  const locked = !!deck.drumOnTake;

  // ---- top controls: BPM + time sig (click), count-in (click), kit, effect, mix, swing ----
  const ctrls = h('div', 'drumctrls');
  // BPM + time sig are LOCKED once the take is recorded — the audio is fixed at that tempo/meter,
  // so changing either would drift the drums against the tracks. Everything else stays editable.
  ctrls.appendChild(numCtl(locked ? 'BPM (locked)' : 'BPM', 20, 300, click.bpm, (v) => handlers.onSetClick({ bpm: v }), locked));
  ctrls.appendChild(selCtl(locked ? 'Time sig (locked)' : 'Time sig', TIME_SIGS.map((m, i) => [i, m.label]), click.timeSigIndex != null ? click.timeSigIndex : 2, (v) => handlers.onSetClick({ timeSigIndex: Number(v) }), locked));
  const ci = h('button', 'btn mini' + (click.countIn ? ' primary' : ''), click.countIn ? 'Count-in: 2 bars' : 'Count-in: off');
  ci.addEventListener('click', () => handlers.onSetClick({ countIn: !click.countIn }));
  const ciCtl = h('div', 'drumctl'); ciCtl.append(h('span', 'lbl', 'Count-in'), ci); ctrls.appendChild(ciCtl);
  ctrls.appendChild(selCtl('Kit', KITS.map((k) => [k.id, k.label]), cfg.kit, (v) => handlers.onSetDrums({ kit: v })));
  ctrls.appendChild(selCtl('Effect', EFFECTS.map((e) => [e.id, e.label]), cfg.effect, (v) => handlers.onSetDrums({ effect: v })));
  ctrls.appendChild(rangeCtl('Mix', 0, 1, 0.01, cfg.effectMix, (v) => handlers.onSetDrums({ effectMix: v })));
  ctrls.appendChild(rangeCtl('Swing', 0, SWING_MAX, 0.01, cfg.swing, (v) => handlers.onSetDrums({ swing: v })));
  box.appendChild(ctrls);

  // ---- mode: single loop / grid  vs  the drum-loop sequencer ----
  const mode = deck.drumMode || 'single';
  if (!locked) {
    const modeRow = h('div', 'row');
    const single = h('button', 'btn mini' + (mode === 'single' ? ' primary' : ''), 'Single loop');
    single.addEventListener('click', () => handlers.onSetDrumMode('single'));
    const seq = h('button', 'btn mini' + (mode === 'sequence' ? ' primary' : ''), 'Sequence');
    seq.addEventListener('click', () => handlers.onSetDrumMode('sequence'));
    modeRow.append(h('span', 'lbl', 'Mode'), single, seq);
    box.appendChild(modeRow);
  }

  if (mode === 'sequence') {
    buildSequenceSection(box, deck, handlers, click, locked);
  } else {
    buildSingleLoopSection(box, deck, handlers, cfg, click);
  }

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
    mk('VOL', 0, 1.5, 0.01, m.vol, 1.0, (x) => ({ master: { ...m, vol: x } })), // drum-bus fader into the mix (pre-EQ, like each track's vol); unity detent
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

// ---- single-loop / grid mode (the original UI: MIDI import + bar scroller + step grid) ----
function buildSingleLoopSection(box, deck, handlers, cfg, click) {
  const imp = h('div', 'row');
  const file = h('input'); file.type = 'file'; file.accept = '.mid,.midi'; file.style.display = 'none';
  file.addEventListener('change', () => { if (file.files && file.files[0]) { handlers.onImportDrumMidi(file.files[0]); file.value = ''; } });
  const impBtn = h('button', 'btn mini', 'Import MIDI…');
  impBtn.addEventListener('click', () => file.click());
  imp.append(impBtn, file);
  if (cfg.source && cfg.source.type === 'midi') imp.appendChild(h('span', 'savehint', 'pattern loaded from MIDI'));
  box.appendChild(imp);
  if (click.countIn) box.appendChild(h('div', 'feel-empty', '2-bar count-in ≈ ' + countInSeconds(click.bpm, click.timeSigIndex != null ? click.timeSigIndex : 2).toFixed(1) + ' s before recording.'));

  const bars = (cfg.pattern && cfg.pattern.bars) || 1;
  const bar = Math.max(0, Math.min(bars - 1, deck.drumBar || 0));
  const scroller = h('div', 'drumbars');
  const prev = h('button', 'btn mini', '‹'); prev.disabled = bar <= 0; prev.addEventListener('click', () => handlers.onSetDrumBar(bar - 1));
  const next = h('button', 'btn mini', '›'); next.disabled = bar >= bars - 1; next.addEventListener('click', () => handlers.onSetDrumBar(bar + 1));
  const addB = h('button', 'btn mini', '+ bar'); addB.addEventListener('click', () => handlers.onSetDrumBars(bars + 1));
  const delB = h('button', 'btn mini', '− bar'); delB.disabled = bars <= 1; delB.addEventListener('click', () => handlers.onSetDrumBars(bars - 1));
  scroller.append(prev, h('span', 'lbl', 'Bar ' + (bar + 1) + ' / ' + bars), next, addB, delB);
  box.appendChild(scroller);

  const gridWrap = h('div', 'drumgridwrap');
  const grid = h('div', 'drumgrid');
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
}

// ---- sequence mode (the drum-loop sequencer authoring; read-only once recorded) ----
function buildSequenceSection(box, deck, handlers, click, locked) {
  const wrap = h('div', 'drumseq');

  if (locked) {
    const s = deck.recordedSequence;
    wrap.appendChild(h('div', 'subtitle', 'Sequence (locked)'));
    if (s) {
      const rs = (deck.rulesets || []).find((r) => r.id === s.algorithmId);
      wrap.appendChild(h('div', 'feel-empty', 'Folder “' + (s.folderName || '?') + '” · ' + ((s.loopFiles && s.loopFiles.length) || 0) + ' loops · ' + (rs ? rs.name : s.algorithmId) + ' · count ' + s.count));
      if (s.intro) wrap.appendChild(h('div', 'feel-empty', 'Intro: ' + s.intro));
      if (s.outro) wrap.appendChild(h('div', 'feel-empty', 'Outro: ' + s.outro));
      wrap.appendChild(h('div', 'savehint', s.realizedBars + ' bars — ' + (s.realizedOrder || []).join('→')));
    }
    wrap.appendChild(h('div', 'feel-empty', 'Locked to this take. Make a new take to change the sequence.'));
    box.appendChild(wrap);
    return;
  }

  const sd = deck.sequenceDraft;

  // Main-section folder.
  const folderRow = h('div', 'row');
  const folderBtn = h('button', 'btn mini', 'Main section folder…');
  folderBtn.addEventListener('click', () => handlers.onPickLoopFolder());
  folderRow.append(h('span', 'lbl', 'Main'), folderBtn);
  folderRow.appendChild(h('span', 'savehint', (sd && sd.folderName) ? ('“' + sd.folderName + '” · ' + sd.loopCount + ' loop' + (sd.loopCount === 1 ? '' : 's')) : 'name loops 001.mid, 002.mid…'));
  wrap.appendChild(folderRow);
  if (deck.sequenceReject) {
    const rj = deck.sequenceReject;
    const why = rj.reason === 'gaps' ? ('gapless set ' + rj.expected + '.mid required') : rj.reason === 'empty' ? 'no .mid files found' : ('bad names: ' + (rj.offenders || []).slice(0, 3).join(', '));
    wrap.appendChild(h('div', 'feel-empty', 'Folder rejected — ' + why + '.'));
  }

  // ←/→ audition over [intro?, loops…, outro?].
  const n = auditionCount(sd);
  if (n > 0) {
    const idx = Math.max(0, Math.min(n - 1, deck.loopAuditionIndex || 0));
    const audRow = h('div', 'drumbars');
    const prev = h('button', 'btn mini', '‹'); prev.addEventListener('click', () => handlers.onAuditionStep(-1));
    const play = h('button', 'btn mini', '▶'); play.addEventListener('click', () => handlers.onAuditionPlay());
    const next = h('button', 'btn mini', '›'); next.addEventListener('click', () => handlers.onAuditionStep(1));
    audRow.append(prev, play, next, h('span', 'lbl', auditionLabel(sd, idx) + ' (' + (idx + 1) + '/' + n + ')'));
    wrap.appendChild(audRow);
  }

  // Intro / Outro (optional single files).
  wrap.appendChild(introOutroRow('Intro', sd && sd.introName, () => handlers.onPickIntro(), () => handlers.onClearIntro()));
  wrap.appendChild(introOutroRow('Outro', sd && sd.outroName, () => handlers.onPickOutro(), () => handlers.onClearOutro()));

  // Algorithm + import.
  const algoRow = h('div', 'row');
  const algoOpts = [['', '— choose —']].concat((deck.rulesets || []).map((r) => [r.id, r.name + ' (' + r.type + ')']));
  algoRow.appendChild(selCtl('Algorithm', algoOpts, (sd && sd.algorithmId) || '', (v) => handlers.onSetAlgorithm(v)));
  const impF = h('input'); impF.type = 'file'; impF.accept = '.json,application/json'; impF.style.display = 'none';
  impF.addEventListener('change', async () => { const f = impF.files && impF.files[0]; if (f) { const txt = await f.text(); handlers.onImportRuleset(txt); impF.value = ''; } });
  const impBtn = h('button', 'btn mini', 'Import ruleset…'); impBtn.addEventListener('click', () => impF.click());
  algoRow.append(impBtn, impF);
  wrap.appendChild(algoRow);

  // Count + preview.
  const cRow = h('div', 'row');
  cRow.appendChild(numCtl('Count', 1, 512, (sd && sd.count) || 8, (v) => handlers.onSetSequenceCount(v), false));
  const prevBtn = h('button', 'btn mini', 'Preview ▶'); prevBtn.addEventListener('click', () => handlers.onPreviewSequence());
  cRow.append(prevBtn);
  wrap.appendChild(cRow);
  wrap.appendChild(h('div', 'savehint', sequenceReadout(sd)));

  if (click.countIn) wrap.appendChild(h('div', 'feel-empty', '2-bar count-in ≈ ' + countInSeconds(click.bpm, click.timeSigIndex != null ? click.timeSigIndex : 2).toFixed(1) + ' s before the intro.'));
  box.appendChild(wrap);
}

function auditionCount(sd) {
  if (!sd) return 0;
  return (sd.introName ? 1 : 0) + (sd.loopCount || 0) + (sd.outroName ? 1 : 0);
}
function auditionLabel(sd, idx) {
  if (!sd) return '';
  const list = [];
  if (sd.introName) list.push('intro: ' + sd.introName);
  for (let i = 0; i < (sd.loopCount || 0); i++) list.push((sd.loopFiles && sd.loopFiles[i]) || ('loop ' + (i + 1)));
  if (sd.outroName) list.push('outro: ' + sd.outroName);
  return list[idx] || '';
}
function introOutroRow(label, name, onPick, onClear) {
  const row = h('div', 'row');
  row.appendChild(h('span', 'lbl', label));
  if (name) {
    row.appendChild(h('span', 'savehint', name));
    const clr = h('button', 'btn mini', '✕'); clr.addEventListener('click', onClear); row.appendChild(clr);
  } else {
    const btn = h('button', 'btn mini', 'Set ' + label.toLowerCase() + '…'); btn.addEventListener('click', onPick); row.appendChild(btn);
  }
  return row;
}
function sequenceReadout(sd) {
  if (!sd || !sd.loopCount) return 'Pick a folder + algorithm, then Preview to hear the roll.';
  const count = sd.count || 0, intro = sd.introBars || 0, outro = sd.outroBars || 0;
  const bars = sd.loopBars || [];
  const min = Math.min.apply(null, bars), max = Math.max.apply(null, bars);
  if (min === max) {
    const total = intro + count * min + outro;
    return 'Total ≈ ' + total + ' bars (' + (intro ? 'intro ' + intro + ' + ' : '') + count + '×' + min + (outro ? ' + outro ' + outro : '') + ').';
  }
  return 'Total ≈ ' + (intro + count * min + outro) + '–' + (intro + count * max + outro) + ' bars (mixed lengths; Preview for the exact roll).';
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
function selCtl(label, options, value, onChange, disabled) {
  const c = h('div', 'drumctl');
  c.appendChild(h('span', 'lbl', label));
  const sel = h('select');
  options.forEach(([v, t]) => { const o = h('option', null, t); o.value = String(v); sel.appendChild(o); });
  sel.value = String(value);
  if (disabled) sel.disabled = true;
  else sel.addEventListener('change', () => onChange(sel.value));
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
