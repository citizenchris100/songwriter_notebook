// main.js — composition root. Loads feels (from JSON + localStorage), wires
// controls/import/export -> state -> derive -> ui, and registers the service
// worker. The only stateful, side-effectful module.
import { deriveOutput } from './derive.js';
import { validate, randomize, DEFAULT_FEEL } from './session.js';
import { load, save, reflectUrl } from './persistence.js';
import { loadBuiltinFeels, loadUserFeels, saveUserFeels } from './feelStore.js';
import { validateFeel, normalizeFeel, mergeFeels } from './feels.js';
import { mountApp } from './ui.js';

const rootEl = document.getElementById('app');

let builtinFeels = [];
let builtinIds = [];
let userFeels = [];
let feelList = [];   // merged, ordered, tagged builtin:true/false
let feelsById = {};
let feelIds = [];
let state;
let app;

function recompute() {
  const merged = mergeFeels(builtinFeels, userFeels);
  feelList = merged.list;
  feelsById = merged.byId;
  feelIds = feelList.map((f) => f.id);
}

function commit() {
  save(state);
  reflectUrl(state);
  app.update(state, deriveOutput(state, feelsById), feelList);
}

// Build a clean feels/<id>.json-shaped object for export.
function toFeelFile(f) {
  const out = { '$schema': './feel.schema.json', id: f.id, name: f.name, degrees: f.degrees.slice() };
  if (typeof f.description === 'string') out.description = f.description;
  if (Array.isArray(f.tags)) out.tags = f.tags.slice();
  if (typeof f.source === 'string') out.source = f.source;
  out.schemaVersion = 1;
  return out;
}
function download(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const handlers = {
  onChange: (patch) => { state = validate({ ...state, ...patch }, feelIds); commit(); },
  onRandomize: () => { state = validate({ ...state, ...randomize(Math.random, feelIds) }, feelIds); commit(); },

  // Import a pasted/uploaded feel JSON. Returns { ok, name } or { ok:false, error }.
  onImportText: (text) => {
    let obj;
    try { obj = JSON.parse(text); } catch { return { ok: false, error: 'not valid JSON' }; }
    const v = validateFeel(obj);
    if (!v.ok) return { ok: false, error: v.errors[0] };
    const feel = normalizeFeel(obj);
    if (builtinFeels.some((b) => b.id === feel.id)) return { ok: false, error: 'id "' + feel.id + '" is a built-in feel; rename it' };
    userFeels = userFeels.filter((u) => u.id !== feel.id).concat(feel); // replace same-id user feel
    saveUserFeels(userFeels);
    recompute();
    state = validate({ ...state, feel: feel.id }, feelIds);
    commit();
    return { ok: true, name: feel.name };
  },

  onDeleteFeel: (id) => {
    userFeels = userFeels.filter((u) => u.id !== id);
    saveUserFeels(userFeels);
    recompute();
    if (!feelIds.includes(state.feel)) state = validate({ ...state, feel: DEFAULT_FEEL }, feelIds);
    commit();
  },

  onExportCurrent: () => {
    const f = feelsById[state.feel];
    if (f) download(f.id + '.json', toFeelFile(f));
  },
  onExportAll: () => download('songwriter-feels.json', feelList.map(toFeelFile)),
};

(async () => {
  const builtin = await loadBuiltinFeels();
  builtinFeels = builtin.feels;
  builtinIds = builtin.ids;
  userFeels = loadUserFeels();
  recompute();

  if (!feelList.length) {
    rootEl.textContent = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'max-width:520px;margin:60px auto;text-align:center;color:#8b93a3;font:600 15px/1.6 -apple-system,sans-serif';
    msg.textContent = 'Could not load feels. Check your connection and reload.';
    rootEl.appendChild(msg);
    return;
  }

  state = load(feelIds, builtinIds);
  app = mountApp(rootEl, handlers);
  commit();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
