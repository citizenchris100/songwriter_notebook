// songsView.js — the Songs tab. Open a song from a .json / pick a saved one, name a NEW
// song up front, label/reorder/remove its sections, HAND-EDIT sections (new row, + add
// chord, tap a chord to change it via the 12-tone picker), edit lyrics, Save the .json /
// rename / delete. Impure (DOM only); all song logic lives in songs.js (pure) and main.js
// (state + storage). The view is rebuilt from the view-model on every update().
import { h } from './dom.js';
import { SECTION_LABELS } from './songs.js';
import { CHROMATIC_TONES, chordForTone } from './theory/roman.js';
import { sketchesSection, makeSketchPlayer } from './sketchesView.js';
import { buildDeckView } from './tape/tapeView.js';

export function mountSongsView(container, handlers) {
  const {
    onSelectSong, onSetLabel, onReorder, onRemoveProgression, onCopyProgression,
    onNewSong, onConfirmNewSong, onCancelNewSong, onNewRow, onAddChord, onSetChord, onRemoveChord,
    onLyricsChange, onRenameSong, onDeleteSong,
    onOpenSongPicker, onOpenSongText, onSaveSongFile,
    onAddSketch, onSelectSketch, onDeleteSketch, onSketchNotesChange, onLoadSketchBlob,
    onOpenTapeDeck, onDeckLiveRefs,
  } = handlers;

  // An "Open…" control: native file picker → load a song's .json. Uses the File System
  // Access picker where present (desktop; yields a handle for silent Save), else a hidden
  // <input type=file> (iOS / Chrome Android). `cls` styles the visible button.
  function openControl(label, cls) {
    const wrap = h('span', 'openctl');
    const btn = h('button', cls || 'btn', label || 'Open…');
    const fileInput = h('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { onOpenSongText(String(reader.result), f.name); fileInput.value = ''; };
      reader.readAsText(f);
    });
    btn.addEventListener('click', () => {
      if (typeof window !== 'undefined' && window.showOpenFilePicker) onOpenSongPicker();
      else fileInput.click();
    });
    wrap.append(btn, fileInput);
    return wrap;
  }

  const rowOf = (child) => { const r = h('div', 'row'); r.appendChild(child); return r; };

  // One persistent audio controller for inline sketch playback — survives the full-view
  // rebuilds below, so it can own the single <audio> element and revoke object URLs.
  const player = makeSketchPlayer(onLoadSketchBlob);

  function update(vm) {
    closePicker();               // drop any open chord picker before the view is rebuilt
    player.stop();               // pause any inline sketch playback before the DOM is torn down
    container.textContent = '';

    // ---- the tape deck fully replaces the normal song-detail content while
    // open (§5.6) — this is what makes AC-27's "Back + top tabs inert while
    // recording" true for free: the song picker / delete / etc. simply aren't
    // in the rebuilt tree to begin with. The AudioContext-owning controller
    // itself lives in main.js (never torn down by this rebuild); this view
    // only hands back the current render's live timer/meter/status DOM nodes.
    if (vm && vm.songSubView === 'tapedeck' && vm.activeSong) {
      const built = buildDeckView(vm.deck, handlers, vm.currentSongName);
      onDeckLiveRefs(built.live);
      container.appendChild(built.el);
      return;
    }

    const wrap = h('div', 'songswrap');

    // ---- naming a new song (name up front) ----
    if (vm.isPendingNew) {
      const card = h('div', 'card grow');
      card.appendChild(h('span', 'lbl', 'Name your song'));
      const bar = h('div', 'namebar');
      const input = h('input', 'nameinput'); input.type = 'text';
      input.value = vm.nextName || ''; input.placeholder = 'Song name';
      const ok = h('button', 'btn primary', 'Create…');
      const cancel = h('button', 'btn mini', 'Cancel');
      const submit = () => onConfirmNewSong(input.value);
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      cancel.addEventListener('click', () => onCancelNewSong());
      bar.append(input, ok, cancel);
      card.appendChild(bar);
      card.appendChild(h('div', 'feel-empty', "You'll choose where to save the .json next."));
      if (vm.songFlash && !vm.songFlash.ok) card.appendChild(h('div', 'feel-status err', vm.songFlash.error));
      wrap.appendChild(rowOf(card));
      container.appendChild(wrap);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return;
    }

    // ---- song picker + Open ----
    const pickCard = h('div', 'card grow');
    pickCard.appendChild(h('span', 'lbl', 'Song'));
    const pickRow = h('div', 'row pickrow');
    const sel = h('select');
    const blank = h('option', null, '— choose a song —'); blank.value = ''; sel.appendChild(blank);
    vm.songs.forEach((s) => { const o = h('option', null, s.name); o.value = s.id; sel.appendChild(o); });
    sel.value = vm.selectedId || '';
    sel.addEventListener('change', () => onSelectSong(sel.value || null));
    pickRow.append(sel, openControl('Open…', 'btn'));
    pickCard.appendChild(pickRow);
    wrap.appendChild(rowOf(pickCard));

    if (vm.songFlash) wrap.appendChild(flashEl(vm.songFlash));

    // ---- empty state ----
    if (!vm.activeSong) {
      wrap.appendChild(h('div', 'feel-empty pad', 'No song open. Open one from your files, start a new one, or capture progressions on the Progressions tab.'));
      const cta = h('div', 'row');
      cta.appendChild(openControl('Open a song…', 'btn primary'));
      const newBtn = h('button', 'btn primary newsong', '+ New song');
      newBtn.addEventListener('click', () => onNewSong());
      cta.appendChild(newBtn);
      wrap.appendChild(cta);
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

    // ---- tape deck ----
    const deckBtn = h('button', 'btn', '🎛 Tape Deck');
    deckBtn.addEventListener('click', () => onOpenTapeDeck());
    wrap.appendChild(rowOf(deckBtn));

    // ---- save / rename / delete ----
    wrap.appendChild(actionRow(vm));
    container.appendChild(wrap);
  }

  function flashEl(flash) {
    return h('div', 'feel-status ' + (flash.ok ? 'ok' : 'err'),
      flash.ok ? ('Saved ' + flash.name) : ('Could not open: ' + flash.error));
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
    const copy = h('button', 'btn mini', '⧉'); copy.title = 'Duplicate section';
    copy.addEventListener('click', () => onCopyProgression(i));
    head.append(lblSel, spacer, up, down, copy, rm);
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
    const linked = vm.linkedFile;
    const hint = h('div', 'savehint', linked ? ('File: ' + linked) : 'Not saved to a file yet.');

    const btns = h('div', 'row');
    // The one Save: writes the song's .json (overwrites the linked file in place where the
    // platform allows it; else opens the save flow and links the song to the file it lands in).
    const saveBtn = h('button', 'btn primary', 'Save');
    saveBtn.addEventListener('click', () => onSaveSongFile());
    btns.appendChild(saveBtn);

    // Rename.
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

    // Delete (inline confirm, no native dialog). §5.7: also GC the song's OPFS
    // takes — an inline note says so, with a live count when it's cheaply known
    // (the deck was already opened this session) and a generic note otherwise.
    const delBtn = h('button', 'btn danger', 'Delete');
    const delBar = h('div', 'namebar hidden');
    const delOk = h('button', 'btn mini danger', 'Delete song');
    const delCancel = h('button', 'btn mini', 'Cancel');
    const delHint = [h('span', 'savehint', 'Delete this song permanently?')];
    if (vm.deckHasTapeDeck) {
      const n = vm.deckTakeCountForDelete;
      delHint.push(h('span', 'savehint', typeof n === 'number' ? ('Also deletes ' + n + ' take(s).') : 'Also deletes this song’s tape-deck takes.'));
    }
    delBar.append(...delHint, delOk, delCancel);
    delBtn.addEventListener('click', () => delBar.classList.remove('hidden'));
    delOk.addEventListener('click', () => onDeleteSong(vm.activeSong.id));
    delCancel.addEventListener('click', () => delBar.classList.add('hidden'));
    btns.appendChild(delBtn);

    row.append(hint, btns, renBar, delBar);
    return row;
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
