// ui.js — DOM construction for the app shell (tab nav + the two view containers),
// the generator (Progressions) tab, and the Feels import/export panel. Shares the
// low-level render primitives with the Songs tab via dom.js, and mounts the Songs view
// (songsView.js). It reports control changes via callbacks and knows nothing about how
// chords are computed or where feels/songs are stored.
import { ROOTS, ACCIDENTAL_IDS, MODE_IDS, INSTRUMENTS } from './session.js';
import { ACCIDENTALS } from './theory/pitch.js';
import { h, chipRow, sectionBlock } from './dom.js';
import { mountSongsView } from './songsView.js';

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
  const {
    onChange, onRandomize, onImportText, onDeleteFeel, onExportCurrent, onExportAll,
    onTab, onCreateSong, onAddToCurrent, songs: songHandlers,
  } = handlers;
  root.textContent = '';
  const wrap = h('div', 'wrap');
  wrap.appendChild(h('h1', null, 'Songwriter Notebook'));

  // ---- top tab nav ----
  const tabs = h('div', 'tabs');
  const tabProg = h('button', 'tab on', 'Progressions');
  const tabSongs = h('button', 'tab', 'Songs');
  tabProg.addEventListener('click', () => onTab('progressions'));
  tabSongs.addEventListener('click', () => onTab('songs'));
  tabs.append(tabProg, tabSongs);
  wrap.appendChild(tabs);

  // ---- the two views ----
  const viewGen = h('div', 'view');
  const viewSongs = h('div', 'view hidden');
  wrap.append(viewGen, viewSongs);

  const layout = h('div', 'layout');
  const controls = h('aside', 'controls');
  const outputCol = h('main', 'outputcol');
  layout.append(controls, outputCol);
  viewGen.appendChild(layout);

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

  // ---- mount the Songs view into its container ----
  const songsApp = mountSongsView(viewSongs, songHandlers);

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

  // A selectable progression block: a checkbox + title header over the chord row. The
  // checkbox toggles `idx` (an index into model.sections) in the live selection set.
  function selBlock(idx, title, chords, selection, onToggle, sub) {
    const sec = h('div', sub ? 'altblock' : 'sec');
    const head = h('label', (sub ? 'subtitle' : 'seclabel') + ' selhead');
    const cb = h('input', 'pcheck');
    cb.type = 'checkbox';
    cb.checked = selection.has(idx);
    cb.addEventListener('change', () => { if (cb.checked) selection.add(idx); else selection.delete(idx); onToggle(); });
    head.append(cb, h('span', null, title));
    sec.append(head, chipRow(chords));
    return sec;
  }

  // Render the generator output with a per-row select checkbox and the song action bar.
  function renderGenerator(model, vm) {
    out.textContent = '';
    if (vm && vm.genFlash) out.appendChild(h('div', 'selflash', vm.genFlash));

    const info = h('div', 'info');
    info.append(
      h('b', null, model.feelName),
      document.createTextNode(' · ' + model.keyLabel + (model.chromatic ? ' · chromatic feel' : '')),
    );
    out.appendChild(info);

    // Selection state + action bar (toggled locally as boxes change, no full re-render).
    const selection = new Set();
    const selbar = h('div', 'selbar hidden');
    const selnote = h('span', 'selnote');
    const createBtn = h('button', 'btn primary mini2', 'Create song');
    const addBtn = h('button', 'btn mini2', 'Add to current song');
    createBtn.addEventListener('click', () => { if (selection.size) onCreateSong([...selection].sort((a, b) => a - b)); });
    addBtn.addEventListener('click', () => { if (selection.size) onAddToCurrent([...selection].sort((a, b) => a - b)); });
    selbar.append(selnote, createBtn, addBtn);
    const refreshBar = () => {
      selbar.classList.toggle('hidden', selection.size < 1);
      selnote.textContent = selection.size ? (selection.size + ' selected') : '';
      addBtn.classList.toggle('hidden', !(vm && vm.hasCurrentSong));
      addBtn.textContent = vm && vm.currentSongName ? ('Add to ' + vm.currentSongName) : 'Add to current song';
    };
    out.appendChild(selbar);

    if (model.chromatic) {
      // One block per section: a flat feel has a single "Main Progression"; a sectioned
      // feel renders each labeled block (Main, Bridge, …). Each is selectable.
      model.sections.forEach((s, idx) => out.appendChild(selBlock(idx, s.title, s.chords, selection, refreshBar, false)));
      out.appendChild(sectionBlock('Alternatives', [h('div', 'feel-empty',
        'A chromatic feel is fixed relative to the root, so the diatonic relative / dominant / subdominant alternatives and the major/minor switch do not apply. Transpose with the Key buttons.')]));
      out.appendChild(sectionBlock('Chords used', [chipRow(model.allChords, 'allchords')]));
    } else {
      let mainBlock = null;
      const altBlocks = [];
      model.sections.forEach((s, idx) => {
        if (s.role === 'main') mainBlock = selBlock(idx, 'Main Progression', s.chords, selection, refreshBar, false);
        else altBlocks.push(selBlock(idx, s.title, s.chords, selection, refreshBar, true));
      });
      if (mainBlock) out.appendChild(mainBlock);
      out.appendChild(sectionBlock('Alternatives', altBlocks));
      out.appendChild(sectionBlock('All Chords in Key', [chipRow(model.allChords, 'allchords')]));
    }
    refreshBar();
  }

  function update(state, model, feels, vm) {
    rebuildFeelOptions(feels, state.feel);
    rebuildUserList(feels);
    rootSeg.set(state.root);
    accSeg.set(state.accidental);
    modeSeg.set(state.mode);
    modeSeg.setEnabled(!model.chromatic); // chromatic feels are mode-independent
    instSeg.set(state.instrument);
    renderGenerator(model, vm);

    const onSongs = !!(vm && vm.view === 'songs');
    viewGen.classList.toggle('hidden', onSongs);
    viewSongs.classList.toggle('hidden', !onSongs);
    tabProg.classList.toggle('on', !onSongs);
    tabSongs.classList.toggle('on', onSongs);
    // AC-27: the top tab strip is inert while the tape deck is recording.
    const deckRecording = !!(vm && vm.deck && vm.deck.recording);
    tabProg.disabled = deckRecording;
    tabSongs.disabled = deckRecording;
    songsApp.update(vm);
  }
  return { update };
}

function helpPanel() {
  const d = h('details');
  d.appendChild(h('summary', null, 'How this works'));
  d.appendChild(h('p', null,
    'A feel is a chord-progression template: a sequence of scale degrees. Pick a feel and a key, and the progression is those degrees voiced as the diatonic chords of that key. Each chord shows its three notes underneath.'));
  d.appendChild(h('p', null,
    'The three alternatives are the neighbouring keys most likely to sit well with the main one: its relative, its dominant (the key a fifth up), and its subdominant (a fifth down), each running the same feel.'));
  d.appendChild(h('p', null,
    'Tick the checkbox on any progression, then use "Create song" to start a song with it (or "Add to current song" to append it to the song open in the Songs tab). Name and write lyrics over there.'));
  d.appendChild(h('p', null,
    'Some feels are chromatic: instead of scale degrees they list Roman-numeral chords (like I, ♭VII, ♭VI) that can be non-diatonic. These are fixed relative to the root, so the Key buttons transpose them but the major/minor switch and the diatonic alternatives do not apply.'));
  d.appendChild(h('p', null,
    'Add your own feels under "Add / manage feels": paste or upload a feel JSON. Exported feels are plain JSON files you can keep or commit as built-ins. Instrument is reserved for chord diagrams in a later version.'));
  return d;
}
