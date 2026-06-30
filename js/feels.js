// js/feels.js — PURE feel helpers: validation (mirrors feels/feel.schema.json) and
// merging built-in + user feels. No DOM, no fetch, no storage — node-importable,
// so the engine test and the sync tool can reuse it.
import { isValidToken } from './theory/roman.js';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED = new Set(['$schema', 'id', 'name', 'degrees', 'progression', 'sections', 'description', 'tags', 'source', 'schemaVersion']);

// A feel is exactly one of three shapes:
//   diatonic  — `degrees` (ints 0..6), voiced in the app's major/minor mode (schemaVersion 1)
//   chromatic — `progression` (Roman-numeral tokens), absolute relative to the tonic,
//               mode-independent, free to be non-diatonic (schemaVersion 2)
//   sectioned — `sections` (labeled blocks, each its own token progression: Main, Bridge, …),
//               also chromatic/mode-independent (schemaVersion 3)
export const isTokenFeel = (f) => Array.isArray(f && f.progression);
export const isSectionedFeel = (f) => Array.isArray(f && f.sections);
// Chromatic = built from tokens (flat or sectioned): mode-independent, no diatonic alternatives.
export const isChromaticFeel = (f) => isTokenFeel(f) || isSectionedFeel(f);

// Validate a feel object against the schema rules. Returns { ok, errors }.
// This mirrors feels/feel.schema.json (kept zero-dependency on purpose).
export function validateFeel(f) {
  if (f == null || typeof f !== 'object' || Array.isArray(f)) return { ok: false, errors: ['feel must be an object'] };
  const errors = [];
  if (typeof f.id !== 'string' || !SLUG.test(f.id)) errors.push('id must be a slug matching ^[a-z0-9][a-z0-9-]*$');
  if (typeof f.name !== 'string' || f.name.length < 1) errors.push('name must be a non-empty string');

  const shapes = ['degrees', 'progression', 'sections'].filter((k) => k in f);
  if (shapes.length === 0) errors.push('feel must have degrees, progression, or sections');
  if (shapes.length > 1) errors.push('a feel has exactly one of degrees, progression, or sections (found: ' + shapes.join(', ') + ')');

  if ('degrees' in f) {
    if (!Array.isArray(f.degrees) || f.degrees.length < 1) errors.push('degrees must be a non-empty array');
    else if (!f.degrees.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) errors.push('degrees must be integers 0..6');
  }
  if ('progression' in f) {
    if (!Array.isArray(f.progression) || f.progression.length < 1) errors.push('progression must be a non-empty array');
    else {
      const bad = f.progression.filter((t) => !isValidToken(t));
      if (bad.length) errors.push('progression has invalid Roman-numeral token(s): ' + bad.join(', '));
    }
  }
  if ('sections' in f) {
    if (!Array.isArray(f.sections) || f.sections.length < 1) errors.push('sections must be a non-empty array');
    else f.sections.forEach((s, i) => {
      if (s == null || typeof s !== 'object' || Array.isArray(s)) { errors.push('section ' + i + ' must be an object'); return; }
      if (typeof s.label !== 'string' || s.label.length < 1) errors.push('section ' + i + ' must have a non-empty label');
      if (!Array.isArray(s.progression) || s.progression.length < 1) errors.push('section ' + i + ' must have a non-empty progression');
      else {
        const bad = s.progression.filter((t) => !isValidToken(t));
        if (bad.length) errors.push('section ' + i + ' has invalid token(s): ' + bad.join(', '));
      }
      for (const k of Object.keys(s)) if (k !== 'label' && k !== 'progression') errors.push('section ' + i + ' has unknown property: ' + k);
    });
  }

  if ('description' in f && typeof f.description !== 'string') errors.push('description must be a string');
  if ('tags' in f && (!Array.isArray(f.tags) || !f.tags.every((t) => typeof t === 'string'))) errors.push('tags must be an array of strings');
  if ('source' in f && typeof f.source !== 'string') errors.push('source must be a string');
  if ('schemaVersion' in f && ![1, 2, 3].includes(f.schemaVersion)) errors.push('schemaVersion must be 1, 2, or 3');
  for (const k of Object.keys(f)) if (!ALLOWED.has(k)) errors.push('unknown property: ' + k);
  return { ok: errors.length === 0, errors };
}

// Reduce a validated feel to the fields the app keeps (drops $schema etc.).
export function normalizeFeel(f) {
  const out = { id: f.id, name: f.name };
  if (Array.isArray(f.degrees)) out.degrees = f.degrees.slice();
  if (Array.isArray(f.progression)) out.progression = f.progression.slice();
  if (Array.isArray(f.sections)) out.sections = f.sections.map((s) => ({ label: s.label, progression: s.progression.slice() }));
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
