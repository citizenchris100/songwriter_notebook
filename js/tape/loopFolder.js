// js/tape/loopFolder.js — PURE folder-name gate for the drum-loop sequencer's MAIN section.
// The main folder's loops must be named three-digit numeric (001.mid, 002.mid, …) AND form a
// CONTIGUOUS 001..00N set, so that loop index N ≡ file 00N ≡ sorted position — one unambiguous
// mapping the rulesets can reference. This is the "onus on the user" contract: name them right
// and the app stays simple. No DOM/IO here — the picker (loopPicker.js) enforces this gate.

// Exactly three digits + .mid/.midi (so 010.mid is valid, 10.mid is not, keeping lexical == numeric).
export const LOOP_NAME_RE = /^(\d{3})\.midi?$/i;

export function isLoopName(name) {
  return typeof name === 'string' && LOOP_NAME_RE.test(name);
}

// The 1-based loop number a compliant filename encodes (001 -> 1), else null.
export function loopNumber(name) {
  const m = typeof name === 'string' ? name.match(LOOP_NAME_RE) : null;
  return m ? parseInt(m[1], 10) : null;
}

// Numeric-sorted copy (001, 002, … 010, …); position == loop index for a compliant set.
export function sortLoopNames(names) {
  return (Array.isArray(names) ? names.slice() : []).sort((a, b) => (loopNumber(a) || 0) - (loopNumber(b) || 0));
}

const pad3 = (n) => String(n).padStart(3, '0');

// Validate the .mid names found (non-recursively) in a chosen folder. Returns:
//   { ok:true, count }                              — a clean contiguous 001..00N set
//   { ok:false, reason:'empty' }                    — no .mid files at all
//   { ok:false, reason:'names', offenders:[...] }   — some file isn't NNN.mid
//   { ok:false, reason:'gaps',  expected:'001..00N' } — names valid but not contiguous from 001
export function validateLoopFolderNames(names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string');
  if (list.length === 0) return { ok: false, reason: 'empty', offenders: [], expected: null };
  const offenders = list.filter((n) => !isLoopName(n));
  if (offenders.length) return { ok: false, reason: 'names', offenders, expected: null };
  const nums = list.map(loopNumber).sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) return { ok: false, reason: 'gaps', offenders: [], expected: pad3(1) + '..' + pad3(nums.length) };
  }
  return { ok: true, reason: null, offenders: [], count: nums.length };
}
