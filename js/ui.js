// ui.js — DOM construction and rendering. The only module (besides main.js) that
// touches the DOM. It knows nothing about how chords are computed; it renders the
// output model from derive.js and reports control changes via callbacks.
import { FEELS } from './data/feels.js';
import { ROOTS, ACCIDENTAL_IDS, MODE_IDS, INSTRUMENTS } from './session.js';
import { ACCIDENTALS } from './theory/pitch.js';

const h = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const label = (t) => h('span', 'lbl', t);

// A segmented button group. Returns { el, set(value) } so the active button can
// be synced to state after load/randomize.
function seg(options, onPick, extraCls) {
  const el = h('span', 'seg' + (extraCls ? ' ' + extraCls : ''));
  const btns = options.map((o) => {
    const b = h('button', null, o.text);
    b.dataset.value = o.value;
    b.addEventListener('click', () => onPick(o.value));
    el.appendChild(b);
    return b;
  });
  return {
    el,
    set: (value) => btns.forEach((b) => b.classList.toggle('on', b.dataset.value === String(value))),
  };
}

const ACC_SYMBOL = Object.fromEntries(ACCIDENTALS.map((a) => [a.id, a.symbol || '♮']));

// Build the whole app shell once. Returns { update(state, model) }.
export function mountApp(root, { onChange, onRandomize }) {
  root.textContent = '';
  const wrap = h('div', 'wrap');
  wrap.appendChild(h('h1', null, 'Songwriter Notebook'));

  const layout = h('div', 'layout');
  const controls = h('aside', 'controls');
  const outputCol = h('main', 'outputcol');
  layout.append(controls, outputCol);
  wrap.appendChild(layout);

  const card = (children) => {
    const c = h('div', 'card grow');
    children.forEach((x) => c.appendChild(x));
    const r = h('div', 'row');
    r.appendChild(c);
    return r;
  };

  // ---- Feel ----
  const feelSel = h('select');
  FEELS.forEach((f, i) => {
    const o = h('option', null, f.name);
    o.value = i;
    feelSel.appendChild(o);
  });
  feelSel.addEventListener('change', () => onChange({ feel: Number(feelSel.value) }));
  controls.appendChild(card([label('Feel'), feelSel]));

  // ---- Key ----
  const keyLine = h('div', 'keyline');
  const rootSeg = seg(ROOTS.map((r) => ({ value: r, text: r })), (v) => onChange({ root: v }));
  const accSeg = seg(ACCIDENTAL_IDS.map((a) => ({ value: a, text: ACC_SYMBOL[a] })), (v) => onChange({ accidental: v }), 'acc');
  const modeSeg = seg(MODE_IDS.map((m) => ({ value: m, text: cap(m) })), (v) => onChange({ mode: v }));
  keyLine.append(rootSeg.el, accSeg.el, modeSeg.el);
  controls.appendChild(card([label('Key'), keyLine]));

  // ---- Instrument ----
  const instSeg = seg(INSTRUMENTS.map((x) => ({ value: x, text: cap(x) })), (v) => onChange({ instrument: v }));
  controls.appendChild(card([label('Instrument'), instSeg.el]));

  // ---- Randomize ----
  const randBtn = h('button', 'btn primary grow', '🎲  Randomize');
  randBtn.addEventListener('click', onRandomize);
  const randRow = h('div', 'row');
  randRow.appendChild(randBtn);
  controls.appendChild(randRow);

  // ---- Output + help + footer ----
  const out = h('div', 'output');
  outputCol.appendChild(out);
  outputCol.appendChild(helpPanel());
  outputCol.appendChild(h('div', 'foot', 'Works fully offline · settings saved on this device'));
  root.appendChild(wrap);

  function update(state, model) {
    feelSel.value = String(state.feel);
    rootSeg.set(state.root);
    accSeg.set(state.accidental);
    modeSeg.set(state.mode);
    instSeg.set(state.instrument);
    renderOutput(out, model);
  }
  return { update };
}

function chip(c) {
  const el = h('div', 'pchip');
  el.appendChild(h('div', 'pchip-name', c.name));
  el.appendChild(h('div', 'pchip-notes', c.notes.join(' ')));
  return el;
}
function chipRow(chords, cls) {
  const row = h('div', 'prow' + (cls ? ' ' + cls : ''));
  chords.forEach((c) => row.appendChild(chip(c)));
  return row;
}
function sectionBlock(title, children) {
  const sec = h('div', 'sec');
  sec.appendChild(h('div', 'seclabel', title));
  children.forEach((c) => sec.appendChild(c));
  return sec;
}

function renderOutput(out, model) {
  out.textContent = '';

  const info = h('div', 'info');
  info.append(h('b', null, model.feelName), document.createTextNode(' · ' + model.keyLabel));
  out.appendChild(info);

  const main = model.sections.find((s) => s.role === 'main');
  const alts = model.sections.filter((s) => s.role !== 'main');

  out.appendChild(sectionBlock('Main Progression', [chipRow(main.chords)]));

  const altGrid = h('div', 'altgrid');
  alts.forEach((s) => {
    const col = h('div', 'altcol');
    col.appendChild(h('div', 'subtitle', s.title));
    col.appendChild(chipRow(s.chords));
    altGrid.appendChild(col);
  });
  out.appendChild(sectionBlock('Alternatives', [altGrid]));

  out.appendChild(sectionBlock('All Chords in Key', [chipRow(model.allChords, 'allchords')]));
}

function helpPanel() {
  const d = h('details');
  d.appendChild(h('summary', null, 'How this works'));
  d.appendChild(h('p', null,
    'A feel is a chord-progression template: a sequence of scale degrees. Pick a feel and a key, and the progression is those degrees voiced as the diatonic chords of that key. Each chord shows its three notes underneath.'));
  d.appendChild(h('p', null,
    'The three alternatives are the neighbouring keys most likely to sit well with the main one: its relative, its dominant (the key a fifth up), and its subdominant (a fifth down), each running the same feel.'));
  d.appendChild(h('p', null,
    'All Chords in Key lists every diatonic chord, in case you want to swap one in. Instrument is reserved for chord diagrams in a later version; it has no effect yet.'));
  return d;
}
