// js/feelStore.js — IMPURE feel I/O. Loads built-in feels from JSON over the
// network (served cache-first by the service worker, so it works offline once
// cached) and user feels from localStorage. Browser-only.
import { validateFeel, normalizeFeel } from './feels.js';

const USER_KEY = 'sn_feels';

// Fetch the manifest, then every built-in feel file. Invalid/failed files are
// skipped (logged), never crash the app. Returns an ordered array of feels.
export async function loadBuiltinFeels() {
  const ids = await (await fetch('./feels/index.json')).json();
  const loaded = await Promise.all(ids.map(async (id) => {
    try {
      const f = await (await fetch('./feels/' + id + '.json')).json();
      const v = validateFeel(f);
      if (!v.ok) { console.warn('songwriter: skipping invalid feel', id, v.errors); return null; }
      return normalizeFeel(f);
    } catch (e) { console.warn('songwriter: failed to load feel', id, e); return null; }
  }));
  return { ids, feels: loaded.filter(Boolean) };
}

export function loadUserFeels() {
  try {
    const arr = JSON.parse(localStorage.getItem(USER_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter((f) => validateFeel(f).ok).map(normalizeFeel);
  } catch { return []; }
}

export function saveUserFeels(feels) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(feels)); } catch {}
}
