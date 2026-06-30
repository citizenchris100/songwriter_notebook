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

export function saveSongs(songs) {
  try { localStorage.setItem(SONGS_KEY, JSON.stringify(songs)); } catch {}
}
