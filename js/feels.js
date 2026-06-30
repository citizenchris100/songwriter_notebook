// js/feels.js — PURE feel helpers: validation (mirrors feels/feel.schema.json) and
// merging built-in + user feels. No DOM, no fetch, no storage — node-importable,
// so the engine test and the sync tool can reuse it.

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED = new Set(['$schema', 'id', 'name', 'degrees', 'description', 'tags', 'source', 'schemaVersion']);

// Validate a feel object against the schema rules. Returns { ok, errors }.
// This mirrors feels/feel.schema.json (kept zero-dependency on purpose).
export function validateFeel(f) {
  if (f == null || typeof f !== 'object' || Array.isArray(f)) return { ok: false, errors: ['feel must be an object'] };
  const errors = [];
  if (typeof f.id !== 'string' || !SLUG.test(f.id)) errors.push('id must be a slug matching ^[a-z0-9][a-z0-9-]*$');
  if (typeof f.name !== 'string' || f.name.length < 1) errors.push('name must be a non-empty string');
  if (!Array.isArray(f.degrees) || f.degrees.length < 1) errors.push('degrees must be a non-empty array');
  else if (!f.degrees.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) errors.push('degrees must be integers 0..6');
  if ('description' in f && typeof f.description !== 'string') errors.push('description must be a string');
  if ('tags' in f && (!Array.isArray(f.tags) || !f.tags.every((t) => typeof t === 'string'))) errors.push('tags must be an array of strings');
  if ('source' in f && typeof f.source !== 'string') errors.push('source must be a string');
  if ('schemaVersion' in f && f.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const k of Object.keys(f)) if (!ALLOWED.has(k)) errors.push('unknown property: ' + k);
  return { ok: errors.length === 0, errors };
}

// Reduce a validated feel to the fields the app keeps (drops $schema etc.).
export function normalizeFeel(f) {
  const out = { id: f.id, name: f.name, degrees: f.degrees.slice() };
  if (typeof f.description === 'string') out.description = f.description;
  if (Array.isArray(f.tags)) out.tags = f.tags.slice();
  if (typeof f.source === 'string') out.source = f.source;
  return out;
}

// Merge built-in feels (ordered) with user feels (ordered). Built-ins win on id
// collision. Each result is tagged builtin:true/false (used by the UI). Returns
// { list, byId }.
export function mergeFeels(builtin, user) {
  const byId = {};
  const list = [];
  const add = (f, isBuiltin) => { if (!byId[f.id]) { byId[f.id] = { ...f, builtin: isBuiltin }; list.push(byId[f.id]); } };
  for (const f of builtin) add(f, true);
  for (const f of user) add(f, false);
  return { list, byId };
}
