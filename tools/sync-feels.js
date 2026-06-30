// tools/sync-feels.js — dev authoring helper (NOT part of the running app, no
// runtime dependency). After adding/editing/removing a feels/<id>.json it:
//   1. validates every feel file against the schema (via the app's validateFeel);
//   2. rebuilds feels/index.json (keeps existing order, appends new ids);
//   3. regenerates the feels block of sw.js ASSETS (between the // feels markers);
//   4. bumps the offline cache version when anything changed.
// Usage:  node tools/sync-feels.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFeel } from '../js/feels.js';

const root = fileURLToPath(new URL('..', import.meta.url)); // repo root (trailing /)
const feelsDir = root + 'feels';
const swPath = root + 'sw.js';
const indexPath = feelsDir + '/index.json';
const RESERVED = new Set(['feel.schema.json', 'index.json']);

// 1. Collect + validate feel files.
const files = readdirSync(feelsDir).filter((f) => f.endsWith('.json') && !RESERVED.has(f)).sort();
const ids = [];
let bad = 0;
for (const file of files) {
  let obj;
  try { obj = JSON.parse(readFileSync(feelsDir + '/' + file, 'utf8')); }
  catch (e) { console.error('INVALID JSON:', file, '-', e.message); bad++; continue; }
  const v = validateFeel(obj);
  if (!v.ok) { console.error('SCHEMA FAIL:', file, '-', v.errors.join('; ')); bad++; continue; }
  if (obj.id + '.json' !== file) { console.error('ID/FILENAME MISMATCH:', file, 'has id', JSON.stringify(obj.id)); bad++; continue; }
  ids.push(obj.id);
}
if (bad) { console.error('\n' + bad + ' feel file(s) failed validation. Nothing changed.'); process.exit(1); }

// 2. Rebuild index.json (preserve existing order, append new, drop missing).
let prevOrder = [];
try { prevOrder = JSON.parse(readFileSync(indexPath, 'utf8')); } catch {}
const present = new Set(ids);
const order = prevOrder.filter((id) => present.has(id));
for (const id of ids) if (!order.includes(id)) order.push(id);
const newIndex = '[\n' + order.map((id) => '  ' + JSON.stringify(id)).join(',\n') + '\n]\n';
let oldIndex = '';
try { oldIndex = readFileSync(indexPath, 'utf8'); } catch {}
const indexChanged = newIndex !== oldIndex;
if (indexChanged) writeFileSync(indexPath, newIndex);

// 3. Regenerate the sw.js feels block.
let sw = readFileSync(swPath, 'utf8');
const markers = /([ \t]*\/\/ feels:start[^\n]*\n)([\s\S]*?)([ \t]*\/\/ feels:end[^\n]*\n)/;
const m = sw.match(markers);
if (!m) { console.error('sw.js is missing the "// feels:start" / "// feels:end" markers.'); process.exit(1); }
const block = ['"./feels/index.json",', ...order.map((id) => '"./feels/' + id + '.json",')]
  .map((l) => '  ' + l).join('\n') + '\n';
const swChanged = block !== m[2];
let out = sw.replace(markers, m[1] + block + m[3]);

// 4. Bump cache when something changed.
let bumped = null;
if (indexChanged || swChanged) {
  out = out.replace(/const CACHE = "([a-z]+)-v(\d+)";/, (_full, prefix, n) => {
    bumped = prefix + '-v' + (Number(n) + 1);
    return 'const CACHE = "' + bumped + '";';
  });
}
if (out !== sw) writeFileSync(swPath, out);

console.log('feels (' + order.length + '): ' + order.join(', '));
console.log(
  'index.json ' + (indexChanged ? 'updated' : 'unchanged') +
  '; sw.js feels block ' + (swChanged ? 'updated' : 'unchanged') +
  (bumped ? '; CACHE -> ' + bumped : '; CACHE unchanged')
);
