// songsView.js — the Songs tab. Pick/show a saved song, label/reorder/remove its
// captured progressions, edit lyrics, save (with inline naming) / rename / delete, and
// import/export songs. Reuses chipRow from dom.js so progressions render identically to
// the generator. Impure (DOM only); all song logic lives in songs.js (pure) and main.js
// (state + storage). The view is rebuilt from the view-model on every update().
import { h, chipRow } from './dom.js';
import { SECTION_LABELS } from './songs.js';

export function mountSongsView(container, handlers) {
  const {
    onSelectSong, onSetLabel, onReorder, onRemoveProgression,
    onLyricsChange, onSaveSong, onRenameSong, onDeleteSong,
    onImportSong, onExportCurrent, onExportAllSongs,
  } = handlers;

  const rowOf = (child) => { const r = h('div', 'row'); r.appendChild(child); return r; };

  function update(vm) {
    container.textContent = '';
    const wrap = h('div', 'songswrap');

    // ---- song picker ----
    const pickCard = h('div', 'card grow');
    pickCard.appendChild(h('span', 'lbl', 'Song'));
    const sel = h('select');
    const blank = h('option', null, '— choose a song —'); blank.value = ''; sel.appendChild(blank);
    if (vm.isDraft) { const o = h('option', null, '(unsaved draft)'); o.value = '__draft__'; sel.appendChild(o); }
    vm.songs.forEach((s) => { const o = h('option', null, s.name); o.value = s.id; sel.appendChild(o); });
    sel.value = vm.selectedId || '';
    const confirmHost = h('div', 'switchconfirm');
    sel.addEventListener('change', () => {
      const target = sel.value || null;
      if (vm.isDraft && target !== '__draft__') {
        sel.value = vm.selectedId || '';        // revert until the user confirms
        showSwitchConfirm(confirmHost, target);
      } else {
        onSelectSong(target);
      }
    });
    pickCard.append(sel, confirmHost);
    wrap.appendChild(rowOf(pickCard));

    // ---- empty state ----
    if (!vm.activeSong) {
      wrap.appendChild(h('div', 'feel-empty pad', 'No song selected. Choose one above, or use "Create song" on the Progressions tab.'));
      wrap.appendChild(managePanel());
      container.appendChild(wrap);
      return;
    }

    // ---- captured progressions ----
    const song = vm.activeSong;
    const last = song.progressions.length - 1;
    if (!song.progressions.length) {
      wrap.appendChild(h('div', 'feel-empty pad', 'This song has no progressions yet. Add some from the Progressions tab.'));
    }
    song.progressions.forEach((p, i) => wrap.appendChild(progBlock(p, i, last)));

    // ---- lyrics ----
    const lyrCard = h('div', 'card grow');
    lyrCard.appendChild(h('span', 'lbl', 'Lyrics'));
    const ta = h('textarea', 'lyrics');
    ta.rows = 8; ta.placeholder = 'Write lyrics here…'; ta.value = song.lyrics || '';
    ta.addEventListener('input', () => onLyricsChange(ta.value)); // capture only — no re-render (keeps the caret)
    lyrCard.appendChild(ta);
    wrap.appendChild(rowOf(lyrCard));

    // ---- save / rename / delete ----
    wrap.appendChild(actionRow(vm));

    // ---- import / export ----
    wrap.appendChild(managePanel());
    container.appendChild(wrap);
  }

  function progBlock(p, i, last) {
    const sec = h('div', 'sec songsec');
    const head = h('div', 'pchead');
    const lblSel = h('select', 'plabel');
    [''].concat(SECTION_LABELS).forEach((l) => { const o = h('option', null, l || '(no label)'); o.value = l; lblSel.appendChild(o); });
    lblSel.value = p.label || '';
    lblSel.addEventListener('change', () => onSetLabel(i, lblSel.value));
    const spacer = h('span', 'spacer');
    const up = h('button', 'btn mini', '▲'); up.title = 'Move up'; up.disabled = i === 0; up.addEventListener('click', () => onReorder(i, -1));
    const down = h('button', 'btn mini', '▼'); down.title = 'Move down'; down.disabled = i === last; down.addEventListener('click', () => onReorder(i, 1));
    const rm = h('button', 'btn mini danger', '✕'); rm.title = 'Remove from song'; rm.addEventListener('click', () => onRemoveProgression(i));
    head.append(lblSel, spacer, up, down, rm);
    sec.appendChild(head);

    const prov = p.provenance || {};
    const subParts = [p.title, prov.feelName, prov.keyLabel].filter(Boolean);
    if (subParts.length) sec.appendChild(h('div', 'subtitle', subParts.join(' · ')));
    sec.appendChild(chipRow(p.chords));
    return sec;
  }

  function actionRow(vm) {
    const row = h('div', 'row songactions');
    const hint = h('div', 'savehint', vm.isDraft ? 'Unsaved — Save to keep this song.' : 'Saved on this device.');

    const btns = h('div', 'row');
    const saveBtn = h('button', 'btn primary', 'Save');
    btns.appendChild(saveBtn);

    // Inline name field for a draft's first save (no native dialog).
    const nameBar = h('div', 'namebar hidden');
    const nameInput = h('input', 'nameinput'); nameInput.type = 'text';
    const nameOk = h('button', 'btn mini', '✓ Save');
    const nameCancel = h('button', 'btn mini', '✗');
    nameBar.append(nameInput, nameOk, nameCancel);
    nameOk.addEventListener('click', () => onSaveSong(nameInput.value));
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveSong(nameInput.value); });
    nameCancel.addEventListener('click', () => nameBar.classList.add('hidden'));
    saveBtn.addEventListener('click', () => {
      if (vm.isDraft) {
        nameInput.value = vm.nextName;
        nameBar.classList.remove('hidden');
        nameInput.focus(); nameInput.select();
      } else {
        onSaveSong(null);
      }
    });

    if (vm.isDraft) {
      row.append(hint, btns, nameBar);
      return row;
    }

    // Rename (saved songs only).
    const renameBtn = h('button', 'btn', 'Rename');
    const renBar = h('div', 'namebar hidden');
    const renInput = h('input', 'nameinput'); renInput.type = 'text';
    const renOk = h('button', 'btn mini', '✓');
    const renCancel = h('button', 'btn mini', '✗');
    renBar.append(renInput, renOk, renCancel);
    renameBtn.addEventListener('click', () => { renInput.value = vm.activeSong.name; renBar.classList.remove('hidden'); renInput.focus(); renInput.select(); });
    renOk.addEventListener('click', () => onRenameSong(renInput.value));
    renInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRenameSong(renInput.value); });
    renCancel.addEventListener('click', () => renBar.classList.add('hidden'));
    btns.appendChild(renameBtn);

    // Delete (inline confirm, no native dialog).
    const delBtn = h('button', 'btn danger', 'Delete');
    const delBar = h('div', 'namebar hidden');
    const delOk = h('button', 'btn mini danger', 'Delete song');
    const delCancel = h('button', 'btn mini', 'Cancel');
    delBar.append(h('span', 'savehint', 'Delete this song permanently?'), delOk, delCancel);
    delBtn.addEventListener('click', () => delBar.classList.remove('hidden'));
    delOk.addEventListener('click', () => onDeleteSong(vm.activeSong.id));
    delCancel.addEventListener('click', () => delBar.classList.add('hidden'));
    btns.appendChild(delBtn);

    row.append(hint, btns, nameBar, renBar, delBar);
    return row;
  }

  function showSwitchConfirm(host, target) {
    host.textContent = '';
    const strip = h('div', 'namebar');
    strip.appendChild(h('span', 'savehint', 'Discard unsaved draft?'));
    const ok = h('button', 'btn mini danger', 'Discard');
    const cancel = h('button', 'btn mini', 'Keep editing');
    ok.addEventListener('click', () => onSelectSong(target));
    cancel.addEventListener('click', () => { host.textContent = ''; });
    strip.append(ok, cancel);
    host.appendChild(strip);
  }

  function managePanel() {
    const d = h('details', 'feels-panel songs-panel');
    d.appendChild(h('summary', null, 'Import / export songs'));

    const box = h('textarea');
    box.placeholder = 'Paste a song JSON here…';
    box.rows = 4;
    d.appendChild(box);

    const status = h('div', 'feel-status');

    const btnRow = h('div', 'feel-btns');
    const importBtn = h('button', 'btn mini', 'Import');
    importBtn.addEventListener('click', () => showStatus(status, onImportSong(box.value)));
    const fileLabel = h('label', 'btn mini', 'Upload .json');
    const fileInput = h('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { showStatus(status, onImportSong(String(reader.result))); fileInput.value = ''; };
      reader.readAsText(f);
    });
    fileLabel.appendChild(fileInput);
    const exportBtn = h('button', 'btn mini', 'Export current');
    exportBtn.addEventListener('click', onExportCurrent);
    const exportAllBtn = h('button', 'btn mini', 'Export all');
    exportAllBtn.addEventListener('click', onExportAllSongs);
    btnRow.append(importBtn, fileLabel, exportBtn, exportAllBtn);
    d.append(btnRow, status);
    return d;
  }

  function showStatus(el, res) {
    if (!res) return;
    el.className = 'feel-status ' + (res.ok ? 'ok' : 'err');
    el.textContent = res.ok ? ('Imported "' + res.name + '"') : ('Could not import: ' + res.error);
  }

  return { update };
}
