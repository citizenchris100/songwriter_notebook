// songsView.js — the Songs tab. Pick/show a saved song, label/reorder/remove its
// sections, HAND-EDIT sections (new row, + add chord, tap a chord to change it via the
// 12-tone picker), edit lyrics, save (with inline naming) / rename / delete, and
// import/export songs. Impure (DOM only); all song logic lives in songs.js (pure) and
// main.js (state + storage). The view is rebuilt from the view-model on every update().
import { h } from './dom.js';
import { SECTION_LABELS } from './songs.js';
import { CHROMATIC_TONES, chordForTone } from './theory/roman.js';
import { sketchesSection, makeSketchPlayer } from './sketchesView.js';

export function mountSongsView(container, handlers) {
  const {
    onSelectSong, onSetLabel, onReorder, onRemoveProgression,
    onNewSong, onNewRow, onAddChord, onSetChord, onRemoveChord,
    onLyricsChange, onSaveSong, onRenameSong, onDeleteSong,
    onImportSong, onExportCurrent, onExportAllSongs,
    onAddSketch, onSelectSketch, onDeleteSketch, onSketchNotesChange, onLoadSketchBlob,
  } = handlers;

  const rowOf = (child) => { const r = h('div', 'row'); r.appendChild(child); return r; };

  // One persistent audio controller for inline sketch playback — survives the full-view
  // rebuilds below, so it can own the single <audio> element and revoke object URLs.
  const player = makeSketchPlayer(onLoadSketchBlob);

  function update(vm) {
    closePicker();               // drop any open chord picker before the view is rebuilt
    player.stop();               // pause any inline sketch playback before the DOM is torn down
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
      wrap.appendChild(h('div', 'feel-empty pad', 'No song selected. Start one below, choose one above, or capture progressions on the Progressions tab.'));
      const newBtn = h('button', 'btn primary newsong', '+ New song');
      newBtn.addEventListener('click', () => onNewSong());
      wrap.appendChild(rowOf(newBtn));
      wrap.appendChild(managePanel());
      container.appendChild(wrap);
      return;
    }

    // ---- captured progressions ----
    const song = vm.activeSong;
    const last = song.progressions.length - 1;
    if (!song.progressions.length) {
      wrap.appendChild(h('div', 'feel-empty pad', 'This song has no sections yet. Add one with "New row", or capture progressions on the Progressions tab.'));
    }
    song.progressions.forEach((p, i) => wrap.appendChild(progBlock(p, i, last)));

    // ---- new row (a fresh section seeded with one C major chord) ----
    const newRowBtn = h('button', 'btn newrow', '+ New row');
    newRowBtn.addEventListener('click', () => onNewRow());
    wrap.appendChild(rowOf(newRowBtn));

    // ---- lyrics ----
    const lyrCard = h('div', 'card grow');
    lyrCard.appendChild(h('span', 'lbl', 'Lyrics'));
    const ta = h('textarea', 'lyrics');
    ta.rows = 8; ta.placeholder = 'Write lyrics here…'; ta.value = song.lyrics || '';
    ta.addEventListener('input', () => onLyricsChange(ta.value)); // capture only — no re-render (keeps the caret)
    lyrCard.appendChild(ta);
    wrap.appendChild(rowOf(lyrCard));

    // ---- sketches (audio attachments) ----
    wrap.appendChild(sketchesSection(song, vm, { onAddSketch, onSelectSketch, onDeleteSketch, onSketchNotesChange }, player));

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
    const rm = h('button', 'btn mini danger', '✕'); rm.title = 'Remove section';
    rm.disabled = last === 0;     // keep the song non-empty: can't remove its only section
    rm.addEventListener('click', () => onRemoveProgression(i));
    head.append(lblSel, spacer, up, down, rm);
    sec.appendChild(head);

    const prov = p.provenance || {};
    const subParts = [p.title, prov.feelName, prov.keyLabel].filter(Boolean);
    if (subParts.length) sec.appendChild(h('div', 'subtitle', subParts.join(' · ')));
    sec.appendChild(editableChipRow(p, i));
    return sec;
  }

  // A row of tappable chord chips + an "add chord" button. Tapping a chip opens the
  // 12-tone picker to change it; the + appends a C-major chord (edit it the same way).
  function editableChipRow(p, i) {
    const row = h('div', 'prow songchips');
    p.chords.forEach((c, j) => {
      const chip = h('div', 'pchip editable');
      chip.appendChild(h('div', 'pchip-name', c.name));
      chip.appendChild(h('div', 'pchip-notes', c.notes.join(' ')));
      chip.addEventListener('click', () => openPicker(chip, i, j, p.chords.length));
      row.appendChild(chip);
    });
    const add = h('button', 'pchip addchord', '+');
    add.title = 'Add chord';
    add.addEventListener('click', () => onAddChord(i));
    row.appendChild(add);
    return row;
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
    importBtn.addEventListener('click', async () => showStatus(status, await onImportSong(box.value)));
    const fileLabel = h('label', 'btn mini', 'Upload .json');
    const fileInput = h('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => { showStatus(status, await onImportSong(String(reader.result))); fileInput.value = ''; };
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

  // ---- the 12-tone chord picker (a fixed-position popover; only one open at a time) ----
  let activePicker = null;

  function closePicker() {
    if (!activePicker) return;
    document.removeEventListener('click', activePicker.onDocClick, true);
    document.removeEventListener('keydown', activePicker.onKey);
    window.removeEventListener('scroll', activePicker.onScroll, true);
    window.removeEventListener('resize', activePicker.onScroll);
    activePicker.el.remove();
    activePicker = null;
  }

  // Open the picker for chord (i, j). Step 1: pick one of the 12 tones. Step 2: choose
  // major or minor — which commits the chord and closes. Local DOM only (no full
  // re-render until commit), so opening/among-step clicks stay snappy.
  function openPicker(anchorEl, i, j, rowLen) {
    const toggleOff = activePicker && activePicker.anchor === anchorEl;
    closePicker();
    if (toggleOff) return;       // tapping the same chip again closes it

    const pop = h('div', 'chordpicker');
    const upArr = h('button', 'cp-arrow', '▲'); upArr.title = 'Scroll up';
    const list = h('div', 'cp-list');
    const downArr = h('button', 'cp-arrow', '▼'); downArr.title = 'Scroll down';
    upArr.addEventListener('click', (e) => { e.stopPropagation(); list.scrollBy({ top: -110, behavior: 'smooth' }); });
    downArr.addEventListener('click', (e) => { e.stopPropagation(); list.scrollBy({ top: 110, behavior: 'smooth' }); });

    const qBar = h('div', 'cp-quality hidden');
    const qName = h('span', 'cp-qname');
    const majBtn = h('button', 'btn mini', 'major');
    const minBtn = h('button', 'btn mini', 'minor');
    qBar.append(qName, majBtn, minBtn);

    let chosen = null;           // tone index picked in step 1
    const commit = (quality) => {
      if (chosen == null) return;
      const chord = chordForTone(CHROMATIC_TONES[chosen], quality);
      closePicker();
      onSetChord(i, j, chord);
    };
    majBtn.addEventListener('click', (e) => { e.stopPropagation(); commit('maj'); });
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); commit('min'); });

    CHROMATIC_TONES.forEach((tone, idx) => {
      const t = h('button', 'cp-tone', tone.label);
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        chosen = idx;
        [...list.children].forEach((el, k) => el.classList.toggle('on', k === idx));
        qName.textContent = tone.label + ' —';
        qBar.classList.remove('hidden');
      });
      list.appendChild(t);
    });

    pop.append(upArr, list, downArr, qBar);

    // A multi-chord row can drop this chord here; a single-chord row uses the section ✕.
    if (rowLen > 1) {
      const rmBar = h('div', 'cp-remove');
      const rmBtn = h('button', 'btn mini danger', 'Remove chord');
      rmBtn.addEventListener('click', (e) => { e.stopPropagation(); closePicker(); onRemoveChord(i, j); });
      rmBar.appendChild(rmBtn);
      pop.appendChild(rmBar);
    }

    document.body.appendChild(pop);
    positionPicker(pop, anchorEl);

    const onDocClick = (e) => {
      if (pop.contains(e.target) || e.target === anchorEl || anchorEl.contains(e.target)) return;
      closePicker();
    };
    const onKey = (e) => { if (e.key === 'Escape') closePicker(); };
    const onScroll = (e) => { if (e && e.target && pop.contains(e.target)) return; closePicker(); }; // ignore the tone list's own scroll
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    activePicker = { el: pop, anchor: anchorEl, onDocClick, onKey, onScroll };
  }

  function positionPicker(pop, anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth || 200;
    const ph = pop.offsetHeight || 260;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6); // flip above if it would overflow
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  return { update };
}
