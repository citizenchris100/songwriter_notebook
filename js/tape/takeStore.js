// js/tape/takeStore.js — IMPURE OPFS facade over js/tape/opfsWorker.js. All take
// file I/O lives in the worker; this module owns the worker's lifecycle (D21
// fetch->Blob load, plain-URL fallback), the correlated request/reply RPC, and
// the write-error push channel. Browser-only — NEVER imported by the node
// engine test.
import { STEM_KEYS, stemFileName, mixFileName } from './takeModel.js';

let workerP = null;
let idSeq = 0;
const pending = new Map();
const writeErrorCbs = [];
let offlineSafeFlag = true;

// D21: fetch the worker's own source (SW-cache-served offline) and load it from
// a Blob URL, so `new Worker(...)` never hits the network directly. A plain-URL
// fallback keeps recording working online if blob loading itself throws, at the
// cost of an "may not work offline" note (offlineSafe() reports which path won).
function loadWorker() {
  if (workerP) return workerP;
  workerP = (async () => {
    const url = new URL('./opfsWorker.js', import.meta.url).href;
    let worker;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('opfsWorker fetch failed: ' + res.status);
      const text = await res.text();
      const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      worker = new Worker(blobUrl);
    } catch {
      offlineSafeFlag = false;
      worker = new Worker(url);
    }
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.type === 'writeError') { writeErrorCbs.forEach((cb) => cb(msg.message)); return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'OPFS worker error'));
    };
    return worker;
  })();
  return workerP;
}

export function offlineSafe() { return offlineSafeFlag; }
export function onWriteError(cb) { writeErrorCbs.push(cb); }

function call(op, payload, transfer) {
  return loadWorker().then((worker) => new Promise((resolve, reject) => {
    const id = ++idSeq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...payload }, transfer || []);
  }));
}

// D20: sync access handles are the only reliable OPFS write path on iOS Safari.
// `createSyncAccessHandle` exists ONLY on the Worker-realm FileSystemFileHandle
// — checking `'createSyncAccessHandle' in FileSystemFileHandle.prototype` from
// the MAIN thread always reports false, even on a browser that fully supports
// it, so that check has to happen inside the worker itself (opfsWorker.js's
// checkSupport op). `navigator.storage.getDirectory` is a fast main-thread
// pre-filter: no point spinning up a worker on a browser that lacks OPFS at all.
let supportedP = null;
export function isSupported() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return Promise.resolve(false);
  if (!supportedP) supportedP = call('checkSupport', {}).then((res) => !!res.supported).catch(() => false);
  return supportedP;
}

// Bind the worklet's transferred MessagePort as this worker's audio-append input
// (D33, the normal path — no main-thread relay).
export async function bindAudioPort(port) {
  const worker = await loadWorker();
  worker.postMessage({ op: 'bindPort', port }, [port]);
}

// Fallback (Phase 0): relay one audio chunk through the main thread when port
// transfer into the worklet failed.
export async function relayAppend(stemNum, bytes) {
  const worker = await loadWorker();
  worker.postMessage({ op: 'append', stem: stemNum, bytes }, [bytes]);
}

// ---- manifest ----
export async function readManifest(path) {
  const res = await call('readFile', { path });
  return JSON.parse(new TextDecoder().decode(res.bytes));
}
export async function writeManifest(path, manifest) {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2)).buffer;
  await writeFile(path, bytes);
}

// ---- streamed take recording ----
export async function openTakeFiles(dir, files, header, sizeFields) {
  await call('openTake', { dir, files, header, sizeFields }, [header]);
}
export async function finalizeTakeFiles() {
  const res = await call('finalizeTake', {});
  return res.dataBytes;
}
export async function finalizeExisting(path, sizeFields) {
  const res = await call('finalizeExisting', { path, sizeFields });
  return res.dataBytes;
}

// ---- one-shot file ops ----
export async function writeFile(path, bytes) {
  await call('writeFile', { path, bytes }, [bytes]);
}
export async function readFile(path) {
  const res = await call('readFile', { path });
  return res.bytes;
}

// Best-effort delete of every file a take could own (stems + mix); missing ones
// are fine (the worker's deleteFiles is idempotent). Filenames are re-derived
// from the naming helpers rather than passed in, so callers only need slug+take.
export async function deleteTakeAudio(slug, take) {
  const names = STEM_KEYS.map((k) => stemFileName(slug, take, k)).concat([mixFileName(slug, take)]);
  await call('deleteFiles', { paths: names.map((f) => 'takes/' + slug + '/' + f) });
}
export async function deleteSongTakes(slug) {
  await call('deleteDir', { dir: 'takes/' + slug });
}

export async function estimateSpace() {
  try {
    if (!(navigator.storage && navigator.storage.estimate)) return null;
    const est = await navigator.storage.estimate();
    const usage = est.usage || 0, quota = est.quota || 0;
    return { usage, quota, available: Math.max(0, quota - usage) };
  } catch {
    return null;
  }
}
