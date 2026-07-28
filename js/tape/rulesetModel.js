// js/tape/rulesetModel.js — PURE model for the drum-loop SEQUENCER's selection algorithms
// ("rulesets") + the realize/flatten steps. No DOM, no fetch, no storage, no Date, and —
// critically — NO Math.random: randomness enters ONLY through an injected `rng` argument, so
// the whole file is node-testable and every roll is reproducible in a test. The impure shell
// (js/main.js) supplies `Math.random` as the rng at record time; the resulting order is then
// FROZEN onto the take (js/tape/rulesetModel does not persist anything).
//
// A ruleset is one of three `type`s, authored by the user as JSON and picked before recording:
//   markov     — first-order chain over 1-based loop indices; `to` is an index or the wildcards
//                'any' / 'any-other'; a `default` transition covers unlisted states (so a ruleset
//                adapts to any folder size); the chain walks `count` steps (count ends it).
//   weighted   — a stateless weighted bag; each of `count` picks is independent.
//   sequential — a fixed cycle (round-robin) through `order`, repeated to `count`.
//
// realizeSequence is TOTAL by construction: it never throws and never loops forever — every
// dead end (zero weights, out-of-range refs, 'any-other' with a single loop) degrades to a
// deterministic fallback. Loop indices in the returned order are always within 1..numLoops.

import { concatPatterns } from './drumModel.js';

export const RULESET_TYPES = ['markov', 'weighted', 'sequential'];

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const isPosInt = (x) => Number.isInteger(x) && x >= 1;
const num = (x, dflt) => { const n = Number(x); return Number.isFinite(n) ? n : dflt; };

// ---- validation (mirrors feels.js validateFeel: returns { ok, errors }) ----

export function validateRuleset(r) {
  if (!isObj(r)) return { ok: false, errors: ['ruleset must be an object'] };
  const errors = [];
  if (typeof r.name !== 'string' || r.name.length < 1) errors.push('name must be a non-empty string');
  if (!RULESET_TYPES.includes(r.type)) errors.push('type must be one of ' + RULESET_TYPES.join(', '));
  else if (r.type === 'markov') {
    if (!('start' in r) || !isPosInt(r.start)) errors.push('markov start must be an integer >= 1');
    if (!isObj(r.transitions)) errors.push('markov transitions must be an object');
    else for (const key of Object.keys(r.transitions)) {
      if (key !== 'default' && !/^\d+$/.test(key)) errors.push('markov transition key "' + key + '" must be a positive integer or "default"');
      const arr = r.transitions[key];
      if (!Array.isArray(arr) || arr.length < 1) { errors.push('markov transitions.' + key + ' must be a non-empty array'); continue; }
      arr.forEach((e, i) => {
        if (!isObj(e)) { errors.push('markov transitions.' + key + '[' + i + '] must be an object'); return; }
        const to = e.to;
        const okTo = to === 'any' || to === 'any-other' || isPosInt(to);
        if (!okTo) errors.push('markov transitions.' + key + '[' + i + '].to must be an index >= 1, "any", or "any-other"');
        if (!('w' in e) || !(Number.isFinite(Number(e.w)) && Number(e.w) >= 0)) errors.push('markov transitions.' + key + '[' + i + '].w must be a number >= 0');
      });
    }
  } else if (r.type === 'weighted') {
    if (!isObj(r.weights) || Object.keys(r.weights).length < 1) errors.push('weighted weights must be a non-empty object');
    else for (const k of Object.keys(r.weights)) {
      if (!/^\d+$/.test(k) || Number(k) < 1) errors.push('weighted weights key "' + k + '" must be a positive integer index');
      if (!(Number.isFinite(Number(r.weights[k])) && Number(r.weights[k]) >= 0)) errors.push('weighted weights.' + k + ' must be a number >= 0');
    }
  } else if (r.type === 'sequential') {
    if (!Array.isArray(r.order) || r.order.length < 1) errors.push('sequential order must be a non-empty array');
    else if (!r.order.every((x) => isPosInt(x))) errors.push('sequential order must be integers >= 1');
  }
  return { ok: errors.length === 0, errors };
}

// ---- normalization (canonical shape; coerces weights to numbers, defaults name<-id) ----

export function normalizeRuleset(r) {
  const src = isObj(r) ? r : {};
  const id = typeof src.id === 'string' && src.id ? src.id : (typeof src.name === 'string' ? src.name : 'ruleset');
  const name = typeof src.name === 'string' && src.name ? src.name : id;
  const base = { id, name, type: RULESET_TYPES.includes(src.type) ? src.type : 'sequential' };
  if (base.type === 'markov') {
    const start = isPosInt(src.start) ? src.start : 1;
    const transitions = {};
    const tsrc = isObj(src.transitions) ? src.transitions : {};
    for (const key of Object.keys(tsrc)) {
      const arr = Array.isArray(tsrc[key]) ? tsrc[key] : [];
      transitions[key] = arr.filter(isObj).map((e) => ({
        to: (e.to === 'any' || e.to === 'any-other') ? e.to : (isPosInt(e.to) ? e.to : 0),
        w: Math.max(0, num(e.w, 0)),
      }));
    }
    return { ...base, start, transitions };
  }
  if (base.type === 'weighted') {
    const weights = {};
    const wsrc = isObj(src.weights) ? src.weights : {};
    for (const k of Object.keys(wsrc)) if (/^\d+$/.test(k)) weights[k] = Math.max(0, num(wsrc[k], 0));
    return { ...base, weights };
  }
  const order = (Array.isArray(src.order) ? src.order : []).filter(isPosInt);
  return { ...base, order };
}

// ---- realization: (numLoops, ruleset, count, rng) -> { order: 1-based indices } ----

// Pick one entry from `entries` (each {..., w}) by weight using ONE rng() draw. All-zero
// weights (or none) fall back to a uniform choice among the entries. Never throws.
function weightedPick(entries, rng) {
  if (!entries.length) return null;
  let total = 0;
  for (const e of entries) total += e.w > 0 ? e.w : 0;
  if (!(total > 0)) return entries[Math.min(entries.length - 1, Math.floor(rng() * entries.length))];
  let x = rng() * total;
  for (const e of entries) { const w = e.w > 0 ? e.w : 0; if (x < w) return e; x -= w; }
  return entries[entries.length - 1];
}

const uniform = (n, rng) => 1 + Math.min(n - 1, Math.floor(rng() * n));           // 1..n
function uniformOther(n, s, rng) {                                                  // 1..n except s
  if (n <= 1) return s;
  let v = 1 + Math.min(n - 2, Math.floor(rng() * (n - 1)));
  if (v >= s) v += 1;
  return v;
}

export function realizeSequence(numLoops, ruleset, count, rng) {
  const N = Math.max(1, Math.floor(numLoops) || 1);
  const K = Math.max(0, Math.floor(count) || 0);
  const r = normalizeRuleset(ruleset);
  const rand = typeof rng === 'function' ? rng : () => 0;      // TOTAL even without an rng
  const order = [];

  if (r.type === 'sequential') {
    const seq = r.order.filter((x) => x >= 1 && x <= N);
    const cyc = seq.length ? seq : [1];
    for (let i = 0; i < K; i++) order.push(cyc[i % cyc.length]);
    return { order };
  }

  if (r.type === 'weighted') {
    const entries = Object.keys(r.weights)
      .map((k) => ({ to: Number(k), w: r.weights[k] }))
      .filter((e) => e.to >= 1 && e.to <= N);
    const pool = entries.length ? entries : Array.from({ length: N }, (_, i) => ({ to: i + 1, w: 1 }));
    for (let i = 0; i < K; i++) order.push(weightedPick(pool, rand).to);
    return { order };
  }

  // markov
  let s = Math.min(N, Math.max(1, r.start || 1));
  for (let i = 0; i < K; i++) {
    order.push(s);
    const raw = r.transitions[String(s)] || r.transitions.default || [{ to: 'any', w: 1 }];
    // Keep only entries that can resolve to a valid value for this N / state.
    const cand = raw.filter((e) => e.to === 'any' || e.to === 'any-other' || (isPosInt(e.to) && e.to <= N));
    const pick = weightedPick(cand.length ? cand : [{ to: 'any', w: 1 }], rand);
    if (pick.to === 'any') s = uniform(N, rand);
    else if (pick.to === 'any-other') s = uniformOther(N, s, rand);   // N==1 degrades to s
    else s = pick.to;
  }
  return { order };
}

// ---- flatten: realized order + the parsed patterns -> ONE frozen pattern ----

// parts = { introPattern|null, loopPatterns: {[idx]: pattern}, outroPattern|null }.
// Order references 1-based loop indices into loopPatterns. Intro plays once first, outro once
// last; each main iteration is the full chosen loop. Delegates the actual grid glue to
// drumModel.concatPatterns (the single home of the pattern schema).
export function flattenRealizedSequence(order, parts) {
  const p = parts || {};
  const loops = p.loopPatterns || {};
  const list = [];
  if (p.introPattern) list.push(p.introPattern);
  for (const idx of order || []) if (loops[idx]) list.push(loops[idx]);
  if (p.outroPattern) list.push(p.outroPattern);
  return concatPatterns(list);
}

// Total realized bar count (intro + each chosen main loop + outro), for the UI readout.
export function sequenceBars(order, parts) {
  const p = parts || {};
  const loops = p.loopPatterns || {};
  const barsOf = (pat) => (pat && Number.isFinite(pat.bars) ? Math.max(0, Math.floor(pat.bars)) : 0);
  let total = barsOf(p.introPattern) + barsOf(p.outroPattern);
  for (const idx of order || []) total += barsOf(loops[idx]);
  return total;
}
