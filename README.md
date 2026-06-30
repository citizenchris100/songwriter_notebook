# Songwriter Notebook

An offline, installable chord-progression generator. A clean-room rebuild of
[autochords.com](https://autochords.com), and the first phase of a larger songwriting tool.
Sibling of the [metronome](https://github.com/citizenchris100/metronome) and
[fretboard](https://github.com/citizenchris100/fretboard) PWAs.

- **Live app:** https://citizenchris100.github.io/songwriter_notebook/
- **Install:** open the live app on iPhone/iPad and Add to Home Screen. Works fully offline.

## What it does

Pick a **feel** (one of 16 progression templates) and a **key** (root + accidental + major/minor).
It shows:

- **Main Progression** — the feel voiced as the diatonic chords of your key.
- **Alternatives** — three neighbouring keys that tend to sit well with the main one (its relative,
  its dominant, and its subdominant), each running the same feel.
- **All Chords in Key** — the seven diatonic chords, in case you want to swap one in.

Every chord shows its three triad notes underneath. Settings are saved on the device and reflected
in the URL, so any state is a shareable deep link (e.g. `?feel=2&root=C&mode=minor`).

Phase 1 deliberately omits the original's audio playback and its ChordChord export.

## Architecture

No build step, no dependencies, native ES modules, fully offline. Unlike the single-file siblings,
this app is split into layers so it can grow:

```
js/theory/   pure music theory (pitch, speller, scale, chord) — DOM-free, the durable core
js/data/     plain data tables (modes, the 16 feels) — adding content never touches logic
js/generators/  progression strategies (main, alternatives) as a uniform, extensible list
js/derive.js    pure state -> output model (the primary test target)
js/session.js   state model: defaults, validation, randomize (pure)
js/persistence.js  localStorage + URL deep-link adapter
js/ui.js / js/main.js  the DOM and the wiring (the only impure, side-effectful modules)
```

The core is pure and imports nothing impure, so `node engine.test.js` loads it directly.

### One correction vs. the original

The original derived its alternatives through the circle of fifths with a sharp-biased note table,
which mis-spells the dominant and subdominant in flat keys (it labels the subdominant of F major as
"A♯ major" with an F♯♯m chord). This rebuild reads those neighbour keys straight off the
already-correctly-spelled diatonic scale, so the pitches are identical to the original everywhere
but the spelling is key-correct in every key (the subdominant of F major is B♭ major). A few key
selections are theoretical (e.g. B♯ major); they are spelled, not hidden.

## Develop & deploy

1. Edit files under `~/Documents/songwriter_notebook/`.
2. If you touched the engine, update and run `node engine.test.js` (must be green).
3. **Bump `const CACHE` in `sw.js`** (e.g. `sn-v3` → `sn-v4`) and keep `ASSETS` listing every
   shipped file — cache-first means anything not listed is unavailable offline.
4. Test locally: `python3 -m http.server 8740 --bind 127.0.0.1`, load `http://127.0.0.1:8740/`.
5. `git add -A && git commit && git push origin main`. GitHub Pages redeploys itself.

An installed home-screen copy may need a second launch to pick up a new cache.

## Verification

`node engine.test.js` — zero-dependency, imports the pure core and asserts ~80 vectors captured
from the live autochords app: all diatonic chords + triad notes across 12 keys in both modes, all
16 feels in C major and A minor (main + alternatives), and speller edge cases including theoretical
keys. Run it before every deploy.

## Out of scope for Phase 1

Audio, export, real chord diagrams (the Instrument picker is a persisted placeholder for a later
phase), build tooling/frameworks, modes beyond major and natural minor, and seventh/extended chords.

## License

© 2026 citizenchris100

Licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License (CC BY-NC-SA 4.0)**.

You are free to use, study, share, and adapt this — **as long as you keep it open under the same license, give credit, and do not sell it or use it commercially.** Full terms are in [`LICENSE`](LICENSE); plain-language summary at <https://creativecommons.org/licenses/by-nc-sa/4.0/>.
