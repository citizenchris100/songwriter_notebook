// persistence.js — the storage/URL adapter. Impure (touches localStorage and
// location). Keeps the deep-link + per-device-settings family conventions.
import { DEFAULT_STATE, validate } from './session.js';

const KEY = 'sn_state';
const PARAMS = ['feel', 'root', 'accidental', 'mode', 'instrument'];

// defaults -> stored -> URL override -> validate.
export function load() {
  let s = { ...DEFAULT_STATE };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (stored) s = { ...s, ...stored };
  } catch {}
  const url = new URLSearchParams(location.search);
  for (const p of PARAMS) {
    if (url.has(p)) s[p] = p === 'feel' ? Number(url.get(p)) : url.get(p);
  }
  return validate(s);
}

export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
}

// Keep the address bar a shareable deep link to the current settings.
export function reflectUrl(state) {
  const url = new URLSearchParams();
  PARAMS.forEach((p) => url.set(p, state[p]));
  try { history.replaceState(null, '', './?' + url.toString()); } catch {}
}
