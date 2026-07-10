// js/sketchesView.js — the Sketches sub-section of a song in the Songs tab: attach an
// .m4a, list the attached sketches, and (on selecting one) play it back inline and edit
// its notes. Impure (DOM + <audio>). Pure sketch logic lives in js/sketches.js, byte I/O
// in js/audioStore.js, and state/orchestration in main.js.
//
// The whole songs view is torn down and rebuilt on every songsView.update(), so audio
// bytes are loaded LAZILY on Play through the persistent `player` controller (created
// once in songsView), which owns the single <audio> element and at most one live object
// URL. No blob: URL is ever left dangling in a discarded DOM tree.
import { h } from './dom.js';

// Human, local-time stamp for a sketch's addedAt (presentational; not unit-tested).
function whenLabel(iso) {
  try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso || ''; }
}

const rowWrap = (child) => { const r = h('div', 'row'); r.appendChild(child); return r; };

// Build the whole "Sketches" section for the active song. `handlers` are the sketch
// handlers from main.js; `player` is the persistent audio controller (see below).
export function sketchesSection(song, vm, handlers, player) {
  const { onAddSketch, onSelectSketch, onDeleteSketch, onSketchNotesChange } = handlers;
  const sketches = song.sketches || [];

  const card = h('div', 'card grow sketches');
  card.appendChild(h('span', 'lbl', 'Sketches'));

  // ---- add + status ----
  const addRow = h('div', 'feel-btns');
  const addLabel = h('label', 'btn mini', '+ Add sketch');
  const fileInput = h('input');
  fileInput.type = 'file';
  fileInput.accept = '.m4a,audio/mp4,audio/x-m4a,audio/aac';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';       // reset so re-picking the same file fires change again
    if (f) onAddSketch(f);
  });
  addLabel.appendChild(fileInput);
  addRow.appendChild(addLabel);
  card.appendChild(addRow);

  const status = h('div', 'feel-status');
  if (vm.sketchFlash) {
    status.classList.add(vm.sketchFlash.ok ? 'ok' : 'err');
    status.textContent = vm.sketchFlash.ok ? ('Added "' + vm.sketchFlash.name + '"') : vm.sketchFlash.error;
  }
  card.appendChild(status);

  card.appendChild(h('div', 'feel-empty sketchnote', 'Stored on this device — export a song to keep a permanent copy.'));

  // ---- list ----
  if (!sketches.length) {
    card.appendChild(h('div', 'feel-empty', 'No sketches yet. Add an .m4a recording.'));
    return rowWrap(card);
  }

  const list = h('div', 'savedlist');
  sketches.forEach((sk) => {
    const isSel = sk.id === vm.currentSketchId;
    const rowEl = h('div', 'saved sketch' + (isSel ? ' on' : ''));
    const nm = h('div', 'nm', sk.filename);
    const when = h('div', 'stuning', whenLabel(sk.addedAt));
    const del = h('button', 'btn mini danger', '✕'); del.title = 'Delete sketch';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDeleteSketch(sk.id); });
    rowEl.append(nm, when, del);
    rowEl.addEventListener('click', () => onSelectSketch(isSel ? null : sk.id)); // toggle selection
    list.appendChild(rowEl);
    if (isSel) list.appendChild(detail(sk));
  });
  card.appendChild(list);
  return rowWrap(card);

  // The inline player + notes for the selected sketch.
  function detail(sk) {
    const box = h('div', 'sketch-detail');

    const pl = h('div', 'sketch-player');
    const playBtn = h('button', 'btn mini', '▶ Play');
    const replayBtn = h('button', 'btn mini', '↻ Replay');
    const pstat = h('span', 'sketch-pstat');
    const setStat = (t) => { pstat.textContent = t; };
    player.setStatus(() => setStat('Finished'));   // single slot; overwritten each render
    playBtn.addEventListener('click', async () => {
      setStat('Loading…');
      setStat((await player.play(sk.id)) ? 'Playing' : 'Audio unavailable');
    });
    replayBtn.addEventListener('click', async () => {
      setStat('Loading…');
      setStat((await player.replay(sk.id)) ? 'Playing' : 'Audio unavailable');
    });
    pl.append(playBtn, replayBtn, pstat);
    box.appendChild(pl);

    const ta = h('textarea', 'lyrics sketch-notes');
    ta.rows = 4; ta.placeholder = 'Notes for this sketch…'; ta.value = sk.notes || '';
    ta.addEventListener('input', () => onSketchNotesChange(sk.id, ta.value)); // capture only — no re-render (keeps the caret)
    box.appendChild(ta);

    return box;
  }
}

// A persistent inline audio controller. Owns ONE <audio> element (kept OUT of the
// rebuilt songs DOM) and at most one live object URL, so the full-view rebuild in
// songsView.update() can't leak blob: URLs. Playback never loops — Replay restarts from
// 0. `loadBlob(id)` returns a Promise<Blob|undefined> (main.js → audioStore.getBlob).
export function makeSketchPlayer(loadBlob) {
  const el = new Audio();
  el.loop = false;
  let url = null;
  let loadedId = null;
  let token = 0;              // guards against a rapid A→B selection racing its blob load
  let onStatus = null;       // single 'ended' callback, set by the current detail render
  el.addEventListener('ended', () => { if (onStatus) onStatus('ended'); });

  function revoke() { if (url) { URL.revokeObjectURL(url); url = null; } }

  // Ensure the <audio> is wired to `id`'s blob. Revokes the previous URL first, so only
  // one is ever live. Returns false if the blob is missing or a newer call superseded it.
  async function ensure(id) {
    if (loadedId === id && url) return true;
    const my = ++token;
    let blob;
    try { blob = await loadBlob(id); } catch { blob = null; }
    if (my !== token) return false;   // a newer ensure() started — abandon this one
    el.pause();
    revoke();
    if (!blob) { loadedId = null; return false; }
    url = URL.createObjectURL(blob);
    el.src = url;
    loadedId = id;
    return true;
  }

  return {
    setStatus(cb) { onStatus = cb; },
    async play(id) {
      if (!(await ensure(id))) return false;
      try { await el.play(); return true; } catch { return false; }
    },
    async replay(id) {
      if (!(await ensure(id))) return false;
      try { el.currentTime = 0; } catch { /* not yet seekable — play from wherever */ }
      try { await el.play(); return true; } catch { return false; }
    },
    stop() { el.pause(); },   // called before each rebuild; the URL is kept for instant replay
  };
}
