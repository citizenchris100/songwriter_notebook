// js/tape/rulesetStore.js — IMPURE ruleset I/O for the drum-loop sequencer. Mirrors
// js/feelStore.js exactly: built-in rulesets are fetched from JSON (served cache-first by the
// service worker, so they work offline once cached); user rulesets live in localStorage. The
// pure validate/normalize live in rulesetModel.js. Browser-only.
import { validateRuleset, normalizeRuleset } from './rulesetModel.js';

const USER_KEY = 'sn_rulesets';

// Fetch the manifest, then every built-in ruleset file. Invalid/failed files are skipped
// (logged), never crash the app. Returns { ids, rulesets } (ordered).
export async function loadBuiltinRulesets() {
  const ids = await (await fetch('./assets/rulesets/index.json')).json();
  const loaded = await Promise.all(ids.map(async (id) => {
    try {
      const r = await (await fetch('./assets/rulesets/' + id + '.json')).json();
      const v = validateRuleset(r);
      if (!v.ok) { console.warn('songwriter: skipping invalid ruleset', id, v.errors); return null; }
      return normalizeRuleset(r);
    } catch (e) { console.warn('songwriter: failed to load ruleset', id, e); return null; }
  }));
  return { ids, rulesets: loaded.filter(Boolean) };
}

export function loadUserRulesets() {
  try {
    const arr = JSON.parse(localStorage.getItem(USER_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter((r) => validateRuleset(r).ok).map(normalizeRuleset);
  } catch { return []; }
}

export function saveUserRulesets(rulesets) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(rulesets)); } catch { /* quota/private mode */ }
}
