// main.js — composition root. Wires controls -> state -> derive -> ui, and
// registers the service worker. The only stateful, side-effectful module.
import { deriveOutput } from './derive.js';
import { validate, randomize } from './session.js';
import { load, save, reflectUrl } from './persistence.js';
import { mountApp } from './ui.js';

let state = load();

const app = mountApp(document.getElementById('app'), {
  onChange: (patch) => { state = validate({ ...state, ...patch }); commit(); },
  onRandomize: () => { state = validate({ ...state, ...randomize() }); commit(); },
});

function commit() {
  save(state);
  reflectUrl(state);
  app.update(state, deriveOutput(state));
}

commit();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
