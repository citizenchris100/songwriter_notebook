// js/audioStore.js — IMPURE audio byte store. Sketch AUDIO lives in IndexedDB (not
// localStorage, which is small and string-only); only the sketch METADATA lives in the
// song object (js/songs.js), keyed to its bytes by the globally-unique sketch id.
//
// Browser-only — NEVER imported by the node engine test (keeps the pure core loadable).
// Every op is a promise that resolves on the transaction's completion and REJECTS on
// error, so a failed write surfaces to the UI instead of being silently swallowed.

const DB_NAME = 'sn_audio';
const STORE = 'sketches';
const HANDLES = 'fileHandles';   // per-song FileSystemFileHandle (out-of-line key = song id)
const VERSION = 2;

let _dbP = null;

function open() {
  if (_dbP) return _dbP;
  _dbP = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);     // sketch audio blobs (sketch id)
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES); // save-in-place handles (song id)
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbP;
}

// Store (or overwrite) the audio Blob for a sketch id. A File is a Blob, so the raw
// upload can be passed straight through.
export function putBlob(id, blob) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(blob, id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

// Fetch the Blob for a sketch id (undefined if absent).
export function getBlob(id) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function deleteBlob(id) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

export function deleteMany(ids) {
  if (!ids || !ids.length) return Promise.resolve();
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    ids.forEach((id) => store.delete(id));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

// All stored sketch ids — used by the load-time reconcile to drop dangling metadata and
// garbage-collect orphan blobs.
export function allKeys() {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

// ---- save-in-place file handles (File System Access API; desktop) ----
// A FileSystemFileHandle is structured-cloneable, so it persists across sessions here.
// On platforms without the API (iOS, Chrome Android) nothing is ever stored.

export function putFileHandle(id, handle) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(HANDLES, 'readwrite');
    t.objectStore(HANDLES).put(handle, id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

export function getFileHandle(id) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(HANDLES, 'readonly');
    const req = t.objectStore(HANDLES).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function deleteFileHandle(id) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(HANDLES, 'readwrite');
    t.objectStore(HANDLES).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}
