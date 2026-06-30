// persistence.js — the storage/URL adapter. Impure (touches localStorage and
// location). Keeps the deep-link + per-device-settings family conventions.
import { DEFAULT_STATE, validate } from './session.js';

const KEY = 'sn_state';
const PARAMS = ['feel', 'root', 'accidental', 'mode', 'instrument'];

// defaults -> stored -> URL override -> resolve feel id -> validate.
// `feelIds` = all available ids (for validation); `builtinIds` = ordered built-in
// ids (to resolve a legacy numeric `feel` index from old links/stored state).
export function load(feelIds, builtinIds) {
  let s = { ...DEFAULT_STATE };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (stored) s = { ...s, ...stored };
  } catch {}
  const url = new URLSearchParams(location.search);
  for (const p of PARAMS) if (url.has(p)) s[p] = url.get(p);
  s.feel = resolveFeelId(s.feel, builtinIds);
  return validate(s, feelIds);
}

// A feel value used to be an integer index. Map a numeric value to the built-in id
// at that position so old ?feel=2 links and stored state still resolve.
function resolveFeelId(feel, builtinIds) {
  const isNumeric = typeof feel === 'number' || (typeof feel === 'string' && /^\d+$/.test(feel));
  if (isNumeric && builtinIds) {
    const i = Number(feel);
    if (i >= 0 && i < builtinIds.length) return builtinIds[i];
  }
  return feel;
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
