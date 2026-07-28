// js/tape/loopPicker.js — IMPURE folder/file choosers for the drum-loop sequencer. A fork of
// the MIDI Drum Auditioner's folderPicker, with two deliberate differences: it is
// NON-RECURSIVE (only the chosen directory's top level, never subfolders), and it runs the
// pure NNN.mid gate (loopFolder.js) — rejecting a non-compliant folder with a reminder instead
// of emitting it. Desktop-Chrome uses showDirectoryPicker; a hidden <input webkitdirectory> is
// the fallback + the seam automated tests drive.
//
// Contract: makeLoopPicker({ onFolder, onReject }) -> { open }
//   onFolder({ folderName, files })  files = [{ name, getBytes:()=>Promise<Uint8Array> }] numeric-sorted
//   onReject({ folderName, reason, offenders, expected })  reason: 'empty' | 'names' | 'gaps'
import { validateLoopFolderNames, sortLoopNames } from './loopFolder.js';

const MIDI_RE = /\.midi?$/i;
async function bytesFromFile(file) { return new Uint8Array(await file.arrayBuffer()); }

// Non-recursive: only this directory's own file entries (no descent into subdirectories).
async function listTopLevelMidi(dirHandle) {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && MIDI_RE.test(name)) {
      out.push({ name, getBytes: async () => bytesFromFile(await handle.getFile()) });
    }
  }
  return out;
}

export function makeLoopPicker({ onFolder, onReject }) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.setAttribute('webkitdirectory', '');
  input.setAttribute('accept', '.mid,.midi');
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const all = Array.from(input.files || []);
    // Root level only: webkitRelativePath is "<folder>/<name>"; a nested file has more slashes.
    const rootMidi = all.filter((f) => {
      if (!MIDI_RE.test(f.name)) return false;
      const rel = f.webkitRelativePath || f.name;
      return rel.split('/').length <= 2;
    });
    const rel0 = all[0] && all[0].webkitRelativePath;
    const folderName = rel0 && rel0.includes('/') ? rel0.split('/')[0] : 'Selected folder';
    finish(folderName, rootMidi.map((f) => ({ name: f.name, getBytes: () => bytesFromFile(f) })));
    input.value = '';   // allow re-selecting the same folder
  });
  document.body.appendChild(input);

  function finish(folderName, files) {
    const v = validateLoopFolderNames(files.map((f) => f.name));
    if (!v.ok) { if (onReject) onReject({ folderName, reason: v.reason, offenders: v.offenders || [], expected: v.expected || null }); return; }
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    onFolder({ folderName, files: sortLoopNames(files.map((f) => f.name)).map((n) => byName[n]) });
  }

  async function open() {
    if (window.showDirectoryPicker) {
      let dir;
      try { dir = await window.showDirectoryPicker({ id: 'sn-loops', mode: 'read' }); }
      catch (err) { if (err && err.name === 'AbortError') return; throw err; }
      finish(dir.name, await listTopLevelMidi(dir));
      return;
    }
    input.click();   // fallback
  }

  return { open };
}

// A single-.mid chooser for the optional intro/outro (no naming convention, no folder).
// Contract: makeSingleMidiPicker({ onFile }) -> { open }; onFile({ name, getBytes }).
export function makeSingleMidiPicker({ onFile }) {
  const input = document.createElement('input');
  input.type = 'file';
  input.setAttribute('accept', '.mid,.midi');
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const f = (input.files || [])[0];
    if (f && MIDI_RE.test(f.name)) onFile({ name: f.name, getBytes: () => bytesFromFile(f) });
    input.value = '';
  });
  document.body.appendChild(input);
  return { open: () => input.click() };
}
