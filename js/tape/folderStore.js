// js/tape/folderStore.js — IMPURE main-thread File System Access facade over a
// per-song FileSystemDirectoryHandle (the song's real on-disk folder, granted once
// via showDirectoryPicker). This is the DURABLE twin of js/tape/takeStore.js: Save
// migrates take audio OPFS -> here, playback of a saved slot reads back from here.
//
// Unlike takeStore (a Worker + createSyncAccessHandle, OPFS-only, the realtime
// capture path), folderStore runs on the MAIN thread with createWritable() and is
// only ever exercised on Save (batch) and on play/bounce/share (async). It holds NO
// singleton state — every call takes the dir handle explicitly, so it is safe across
// multiple songs sharing one granted folder.
//
// Browser-only (File System Access API); NEVER imported by the node engine test.
//
// Layout is id-namespaced inside the granted folder so one folder can hold many
// songs safely: <id>.json, takes/<id>/*.wav + manifest.json, midi/<id>/*.mid.

// Query then (if needed) request read/write permission on the dir handle. A persisted
// handle re-read from IndexedDB needs this after a reload (one prompt per session).
// Mirror of main.js ensureHandleWritable.
export async function ensurePermission(dir) {
  if (!dir) return false;
  try {
    const opts = { mode: 'readwrite' };
    if ((await dir.queryPermission(opts)) === 'granted') return true;
    if ((await dir.requestPermission(opts)) === 'granted') return true;
  } catch { /* handle stale / API missing */ }
  return false;
}

// Split a relative path into safe segments, or null if it is empty or contains a
// traversal ('.'/'..') or an absolute-path leading slash. A hard backstop against a
// caller bug ever escaping the granted folder.
function safeSegs(relPath) {
  const segs = String(relPath || '').split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs.some((s) => s === '.' || s === '..')) return null;
  return segs;
}

async function dirHandleAt(root, segs, create) {
  let h = root;
  for (const seg of segs) h = await h.getDirectoryHandle(seg, { create });
  return h;
}

// Resolve the FileSystemFileHandle for a rel path, walking (and optionally creating)
// intermediate dirs. Returns null when create=false and any segment is missing.
async function fileHandleAt(root, relPath, create) {
  const segs = safeSegs(relPath);
  if (!segs) throw new Error('folderStore: unsafe path ' + relPath);
  const name = segs.pop();
  try {
    const parent = await dirHandleAt(root, segs, create);
    return await parent.getFileHandle(name, { create });
  } catch (e) {
    if (!create && e && e.name === 'NotFoundError') return null;
    throw e;
  }
}

// One-shot truncating write. `bytes` may be an ArrayBuffer, TypedArray, Blob, or
// string (createWritable().write accepts all). Creates intermediate dirs.
export async function writeFile(dir, relPath, bytes) {
  const fh = await fileHandleAt(dir, relPath, true);
  const writable = await fh.createWritable();          // truncates on open
  try { await writable.write(bytes); } finally { await writable.close(); }
}

// Full-file read -> ArrayBuffer. Throws NotFoundError (via getFile) if the file is
// gone; callers treat that as "saved audio missing / folder moved".
export async function readFile(dir, relPath) {
  const fh = await fileHandleAt(dir, relPath, false);
  if (!fh) throw Object.assign(new Error('folderStore: not found ' + relPath), { name: 'NotFoundError' });
  const file = await fh.getFile();
  return file.arrayBuffer();
}

// List the file names directly under a rel dir (empty array if the dir is missing). Files
// only (subdirs skipped). Used by Save to GC folder orphans against the current manifest.
export async function listDir(dir, relPath) {
  const segs = safeSegs(relPath);
  if (!segs) return [];
  let h;
  try { h = await dirHandleAt(dir, segs, false); } catch { return []; }
  const names = [];
  try { for await (const [name, handle] of h.entries()) { if (handle.kind === 'file') names.push(name); } } catch { /* iteration unsupported */ }
  return names;
}

export async function fileExists(dir, relPath) {
  try {
    const fh = await fileHandleAt(dir, relPath, false);
    if (!fh) return false;
    await fh.getFile();       // confirm it is a readable file, not just a name
    return true;
  } catch { return false; }
}

// Byte length of a file (or -1 if absent). Used by Save to verify a migrated copy.
export async function fileSize(dir, relPath) {
  try {
    const fh = await fileHandleAt(dir, relPath, false);
    if (!fh) return -1;
    return (await fh.getFile()).size;
  } catch { return -1; }
}

// Delete a single file. Idempotent (a missing file is fine). Structurally guarded
// against traversal; callers only ever pass song-scoped paths (<id>.json,
// takes/<id>/…, midi/<id>/…).
export async function deleteFile(dir, relPath) {
  const segs = safeSegs(relPath);
  if (!segs) throw new Error('folderStore: unsafe path ' + relPath);
  const name = segs.pop();
  try {
    const parent = await dirHandleAt(dir, segs, false);
    await parent.removeEntry(name);
  } catch (e) {
    if (e && e.name === 'NotFoundError') return;   // already gone
    throw e;
  }
}

// The ONE destructive whole-song wipe, hard-scoped to a single song id: it can only
// ever remove takes/<id>/, midi/<id>/, loops/<id>/, and <id>.json — never the granted
// folder root and never another song sharing the folder. Idempotent (missing = fine).
export async function deleteSongArtifacts(dir, songId) {
  const id = String(songId || '');
  if (!id || id.includes('/') || id === '.' || id === '..') throw new Error('folderStore: bad songId ' + songId);
  const removeUnder = async (parentSegs, name, opts) => {
    try {
      const parent = await dirHandleAt(dir, parentSegs, false);
      await parent.removeEntry(name, opts);
    } catch (e) {
      if (!(e && e.name === 'NotFoundError')) throw e;   // missing is fine
    }
  };
  await removeUnder(['takes'], id, { recursive: true });
  await removeUnder(['midi'], id, { recursive: true });
  await removeUnder(['loops'], id, { recursive: true });
  await removeUnder([], id + '.json', {});
}
