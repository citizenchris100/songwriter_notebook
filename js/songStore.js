// js/songStore.js — IMPURE song I/O. Songs are user content saved per-device in
// localStorage; there are no built-in songs, so (unlike feelStore) there is no fetch
// and no manifest. Browser-only.
import { validateSong, normalizeSong } from './songs.js';

const SONGS_KEY = 'sn_songs';

export function loadSongs() {
  try {
    const arr = JSON.parse(localStorage.getItem(SONGS_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => validateSong(s).ok).map(normalizeSong);
  } catch { return []; }
}

// A best-effort listener for a failed persist (localStorage quota / private mode). Registered
// by main.js so a quota failure surfaces to the user instead of being swallowed — the exact
// silent-durability-failure class the take-persistence work exists to eliminate.
let onSaveErrorCb = null;
export function onSaveError(cb) { onSaveErrorCb = cb; }

export function saveSongs(songs) {
  try {
    localStorage.setItem(SONGS_KEY, JSON.stringify(songs));
    return true;
  } catch (e) {
    // The durable copies (the on-disk .json and, for takes, the folder manifest.json) live on
    // separate paths that do NOT hit localStorage quota, so nothing is lost — but this fast
    // per-device cache is now stale, so tell the user rather than failing silently.
    if (onSaveErrorCb) { try { onSaveErrorCb(e); } catch { /* never let the listener throw */ } }
    return false;
  }
}
