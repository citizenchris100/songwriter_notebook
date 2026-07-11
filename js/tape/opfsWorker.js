// js/tape/opfsWorker.js — self-contained CLASSIC Worker, zero imports (loadable
// from a Blob URL with no module-resolution concerns, D21). Owns every OPFS
// createSyncAccessHandle — the only reliable write path on iOS Safari (D20).
// Contains NO WAV knowledge: the main thread supplies the prebuilt 44-byte
// header and the SIZE_FIELDS offsets/biases from js/tape/wav.js; this file only
// patches raw bytes at those offsets. A sync access handle also locks its file,
// so a second tab racing the same take fails loudly instead of interleaving
// writes (accepted multi-tab posture).
//
// Two message sources feed this worker: the main thread's control channel
// (self.onmessage — request/reply, correlated by `id`) and, normally, a
// MessagePort transferred straight from the capture worklet (D33) carrying only
// fire-and-forget 'append' audio chunks, so the UI thread never sits in the
// audio-durability path. If port transfer fails, the main thread relays 'append'
// over the control channel instead — handleAppend() is shared by both paths.

let rootP = null;
function getRoot() {
  if (!rootP) rootP = navigator.storage.getDirectory();
  return rootP;
}

async function dirHandle(dir, create) {
  const segs = dir.split('/').filter(Boolean);
  let h = await getRoot();
  for (const seg of segs) h = await h.getDirectoryHandle(seg, { create });
  return h;
}

async function fileHandleAtPath(path, create) {
  const segs = path.split('/').filter(Boolean);
  const name = segs.pop();
  const dh = await dirHandle(segs.join('/'), create);
  return dh.getFileHandle(name, { create });
}

function patchSizeFields(handle, sizeFields, dataBytes) {
  for (const f of sizeFields) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, dataBytes + f.bias, true);
    handle.write(buf, { at: f.offset });
  }
}

// ---- the one open (recording) take at a time ----
let openTakeState = null; // { sizeFields, stems: { stem1: {handle, cursor}|null, stem2: ...|null }, timer }

function closeOpenTakeIfAny() {
  if (!openTakeState) return;
  clearInterval(openTakeState.timer);
  for (const key of ['stem1', 'stem2']) {
    const s = openTakeState.stems[key];
    if (s) { try { s.handle.close(); } catch { /* already closed */ } }
  }
  openTakeState = null;
}

function flushOpenTake() {
  if (!openTakeState) return;
  for (const key of ['stem1', 'stem2']) {
    const s = openTakeState.stems[key];
    if (!s) continue;
    patchSizeFields(s.handle, openTakeState.sizeFields, s.cursor - 44);
    s.handle.flush();
  }
}

async function openTake(msg) {
  closeOpenTakeIfAny();
  const stems = { stem1: null, stem2: null };
  for (const key of ['stem1', 'stem2']) {
    const filename = msg.files[key];
    if (!filename) continue;
    const fh = await fileHandleAtPath(msg.dir + filename, true);
    const handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    handle.write(new Uint8Array(msg.header), { at: 0 });
    stems[key] = { handle, cursor: msg.header.byteLength };
  }
  openTakeState = { sizeFields: msg.sizeFields, stems, timer: setInterval(flushOpenTake, 1000) };
  return { ok: true };
}

// Fire-and-forget: append one int16 chunk to the named stem's open file. Errors
// push an async {type:'writeError'} rather than reply — there is no request id.
function handleAppend(stemNum, bytes) {
  if (!openTakeState) { postWriteError('append received with no take open'); return; }
  const s = openTakeState.stems['stem' + stemNum];
  if (!s) { postWriteError('append to unopened stem' + stemNum); return; }
  try {
    s.handle.write(bytes, { at: s.cursor });
    s.cursor += bytes.byteLength;
  } catch (e) {
    postWriteError(String((e && e.message) || e));
  }
}

function finalizeTake() {
  if (!openTakeState) return { ok: true, dataBytes: {} };
  const dataBytes = {};
  for (const key of ['stem1', 'stem2']) {
    const s = openTakeState.stems[key];
    if (!s) continue;
    const bytes = s.cursor - 44;
    patchSizeFields(s.handle, openTakeState.sizeFields, bytes);
    s.handle.flush();
    dataBytes[key] = bytes;
  }
  closeOpenTakeIfAny();
  return { ok: true, dataBytes };
}

// Crash recovery: measure + patch a stem file that was left mid-write (status
// "recording"). Missing/empty -> dataBytes 0 (the caller tombstones it).
async function finalizeExisting(msg) {
  let handle;
  try {
    const fh = await fileHandleAtPath(msg.path, false);
    handle = await fh.createSyncAccessHandle();
  } catch {
    return { ok: true, dataBytes: 0 };
  }
  try {
    const size = handle.getSize();
    const dataBytes = Math.max(0, size - 44);
    if (dataBytes > 0) { patchSizeFields(handle, msg.sizeFields, dataBytes); handle.flush(); }
    return { ok: true, dataBytes };
  } finally {
    handle.close();
  }
}

// One-shot truncating write (manifest.json, a re-bounced _mix.wav).
async function writeFile(msg) {
  const fh = await fileHandleAtPath(msg.path, true);
  const handle = await fh.createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(new Uint8Array(msg.bytes), { at: 0 });
    handle.flush();
    return { ok: true };
  } finally {
    handle.close();
  }
}

async function readFile(msg) {
  const fh = await fileHandleAtPath(msg.path, false);
  const handle = await fh.createSyncAccessHandle();
  try {
    const size = handle.getSize();
    const buf = new Uint8Array(size);
    handle.read(buf, { at: 0 });
    return { ok: true, bytes: buf.buffer };
  } finally {
    handle.close();
  }
}

// Best-effort; a missing file is not an error (deletes are idempotent).
async function deleteFiles(msg) {
  for (const path of msg.paths) {
    const segs = path.split('/').filter(Boolean);
    const name = segs.pop();
    try {
      const dh = await dirHandle(segs.join('/'), false);
      await dh.removeEntry(name);
    } catch { /* missing is fine */ }
  }
  return { ok: true };
}

async function deleteDir(msg) {
  const segs = msg.dir.split('/').filter(Boolean);
  const name = segs.pop();
  try {
    const parent = await dirHandle(segs.join('/'), false);
    await parent.removeEntry(name, { recursive: true });
  } catch { /* missing is fine */ }
  return { ok: true };
}

function postWriteError(message) {
  self.postMessage({ type: 'writeError', message });
}

// createSyncAccessHandle exists ONLY on the Worker-realm FileSystemFileHandle —
// checking `'createSyncAccessHandle' in FileSystemFileHandle.prototype` from the
// main thread always reports false, even on browsers that fully support it.
// This is the one capability check that has to happen from inside the worker.
async function checkSupport() {
  return { ok: true, supported: typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype };
}

const REQUEST_HANDLERS = { openTake, finalizeTake: async () => finalizeTake(), finalizeExisting, writeFile, readFile, deleteFiles, deleteDir, checkSupport };

async function handleControlMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.op === 'append') { handleAppend(msg.stem, msg.bytes); return; }             // fire-and-forget
  if (msg.op === 'bindPort') { msg.port.onmessage = (e) => { const m = e.data; if (m && m.op === 'append') handleAppend(m.stem, m.bytes); }; return; }
  const fn = REQUEST_HANDLERS[msg.op];
  if (!fn) { self.postMessage({ id: msg.id, ok: false, error: 'unknown op ' + msg.op }); return; }
  try {
    const result = await fn(msg);
    const transfer = result && result.bytes instanceof ArrayBuffer ? [result.bytes] : [];
    self.postMessage({ id: msg.id, ...result }, transfer);
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
}

self.onmessage = (e) => { handleControlMessage(e.data); };
