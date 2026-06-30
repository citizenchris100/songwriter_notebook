// ui.js — DOM construction and rendering. The only module (besides main.js) that
// touches the DOM. It renders the output model from derive.js, reports control
// changes via callbacks, and hosts the Feels import/export panel. It knows nothing
// about how chords are computed or where feels are stored.
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

// A segmented button group. Returns { el, set(value), setEnabled(on) }.
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
    set: (v) => btns.forEach((b) => b.classList.toggle('on', b.dataset.value === String(v))),
    setEnabled: (on) => { el.classList.toggle('disabled', !on); btns.forEach((b) => { b.disabled = !on; }); },
  };
}

const ACC_SYMBOL = Object.fromEntries(ACCIDENTALS.map((a) => [a.id, a.symbol || '♮']));

export function mountApp(root, handlers) {
  const { onChange, onRandomize, onImportText, onDeleteFeel, onExportCurrent, onExportAll } = handlers;
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

  // Feels-panel element refs (assigned by manageFeelsPanel, used by update()).
  let importBox, importStatus, userList;

  // ---- Feel (picker rebuilt from the loaded feels in update()) ----
  const feelSel = h('select');
  feelSel.addEventListener('change', () => onChange({ feel: feelSel.value }));
  controls.appendChild(card([label('Feel'), feelSel, manageFeelsPanel()]));

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

  // ----- the Feels import/export panel -----
  function manageFeelsPanel() {
    const d = h('details', 'feels-panel');
    d.appendChild(h('summary', null, 'Add / manage feels'));

    importBox = h('textarea');
    importBox.placeholder = 'Paste a feel JSON here…';
    importBox.rows = 4;
    d.appendChild(importBox);

    const btnRow = h('div', 'feel-btns');
    const importBtn = h('button', 'btn mini', 'Import');
    importBtn.addEventListener('click', () => showImport(onImportText(importBox.value)));
    const fileLabel = h('label', 'btn mini', 'Upload .json');
    const fileInput = h('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { showImport(onImportText(String(reader.result))); fileInput.value = ''; };
      reader.readAsText(f);
    });
    fileLabel.appendChild(fileInput);
    const exportBtn = h('button', 'btn mini', 'Export current');
    exportBtn.addEventListener('click', onExportCurrent);
    const exportAllBtn = h('button', 'btn mini', 'Export all');
    exportAllBtn.addEventListener('click', onExportAll);
    btnRow.append(importBtn, fileLabel, exportBtn, exportAllBtn);
    d.appendChild(btnRow);

    importStatus = h('div', 'feel-status');
    d.appendChild(importStatus);

    userList = h('div', 'savedlist');
    d.appendChild(userList);
    return d;
  }

  function showImport(res) {
    if (!res) return;
    importStatus.className = 'feel-status ' + (res.ok ? 'ok' : 'err');
    importStatus.textContent = res.ok ? ('Imported "' + res.name + '"') : ('Could not import: ' + res.error);
    if (res.ok) importBox.value = '';
  }

  function rebuildFeelOptions(feels, selectedId) {
    feelSel.textContent = '';
    const builtin = feels.filter((f) => f.builtin);
    const user = feels.filter((f) => !f.builtin);
    const group = (lbl, items) => {
      if (!items.length) return;
      const og = document.createElement('optgroup');
      og.label = lbl;
      items.forEach((f) => {
        const o = h('option', null, f.name);
        o.value = f.id;
        og.appendChild(o);
      });
      feelSel.appendChild(og);
    };
    group('Built-in', builtin);
    group('Your feels', user);
    feelSel.value = selectedId;
  }

  function rebuildUserList(feels) {
    userList.textContent = '';
    const user = feels.filter((f) => !f.builtin);
    if (!user.length) {
      userList.appendChild(h('div', 'feel-empty', 'No imported feels yet.'));
      return;
    }
    user.forEach((f) => {
      const row = h('div', 'saved');
      row.appendChild(h('span', 'nm', f.name));
      const sig = Array.isArray(f.sections) ? f.sections.map((s) => s.label).join(' / ')
        : Array.isArray(f.progression) ? f.progression.join(' ')
          : '[' + f.degrees.join(' ') + ']';
      row.appendChild(h('span', 'stuning', sig));
      const del = h('button', 'btn mini danger', '✕');
      del.title = 'Delete';
      del.addEventListener('click', () => onDeleteFeel(f.id));
      row.appendChild(del);
      userList.appendChild(row);
    });
  }

  function update(state, model, feels) {
    rebuildFeelOptions(feels, state.feel);
    rebuildUserList(feels);
    rootSeg.set(state.root);
    accSeg.set(state.accidental);
    modeSeg.set(state.mode);
    modeSeg.setEnabled(!model.chromatic); // chromatic feels are mode-independent
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
  info.append(
    h('b', null, model.feelName),
    document.createTextNode(' · ' + model.keyLabel + (model.chromatic ? ' · chromatic feel' : '')),
  );
  out.appendChild(info);

  if (model.chromatic) {
    // One block per section: a flat feel has a single "Main Progression"; a sectioned
    // feel renders each labeled block (Main, Bridge, …) under its own heading.
    model.sections.forEach((s) => out.appendChild(sectionBlock(s.title, [chipRow(s.chords)])));
    out.appendChild(sectionBlock('Alternatives', [h('div', 'feel-empty',
      'A chromatic feel is fixed relative to the root, so the diatonic relative / dominant / subdominant alternatives and the major/minor switch do not apply. Transpose with the Key buttons.')]));
    out.appendChild(sectionBlock('Chords used', [chipRow(model.allChords, 'allchords')]));
    return;
  }

  const main = model.sections.find((s) => s.role === 'main');
  out.appendChild(sectionBlock('Main Progression', [chipRow(main.chords)]));
  const alts = model.sections.filter((s) => s.role !== 'main');
  const altBlocks = alts.map((s) => {
    const block = h('div', 'altblock');
    block.appendChild(h('div', 'subtitle', s.title));
    block.appendChild(chipRow(s.chords));
    return block;
  });
  out.appendChild(sectionBlock('Alternatives', altBlocks));
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
    'Some feels are chromatic: instead of scale degrees they list Roman-numeral chords (like I, ♭VII, ♭VI) that can be non-diatonic. These are fixed relative to the root, so the Key buttons transpose them but the major/minor switch and the diatonic alternatives do not apply.'));
  d.appendChild(h('p', null,
    'Add your own feels under "Add / manage feels": paste or upload a feel JSON. Exported feels are plain JSON files you can keep or commit as built-ins. Instrument is reserved for chord diagrams in a later version.'));
  return d;
}
