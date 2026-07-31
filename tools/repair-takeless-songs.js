// tools/repair-takeless-songs.js — one-time data repair (NOT part of the running app). Backfills a
// song .json whose tape-deck takes drifted out of it (the "duplicate loses its takes after a reboot"
// bug): if <slug>.json carries no tapeDeck.takes but takes/<slug>/manifest.json (the deprecated folder
// copy) still describes real, folder-saved WAVs, fold those records into the .json — after which the
// .json is the single source of truth — and DELETE the now-redundant folder manifest.json (the same
// "deprecate for real" the app now does on open). Never touches WAVs; re-validates before writing.
//
// It shares the app's PURE reconcileTakelessSong, so the script and the on-open recovery can't diverge.
//
// Usage:
//   node tools/repair-takeless-songs.js <sketchesDir>            # dry run (report only)
//   node tools/repair-takeless-songs.js --write <sketchesDir>    # apply
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { reconcileTakelessSong } from '../js/tape/deckRestore.js';
import { validateSong } from '../js/songs.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const dir = args.find((a) => a !== '--write');
if (!dir) {
  console.error('Usage: node tools/repair-takeless-songs.js [--write] <sketchesDir>');
  process.exit(2);
}

const slugDirs = readdirSync(dir).filter((name) => {
  try { return statSync(`${dir}/${name}`).isDirectory(); } catch { return false; }
});

let drifted = 0; let repaired = 0; let clean = 0; let skipped = 0; let missingWavs = 0;

for (const slug of slugDirs.sort()) {
  const base = `${dir}/${slug}`;
  // The song .json is <something>.json in the folder; prefer <slug>.json, else the first *.json.
  const jsonName = existsSync(`${base}/${slug}.json`)
    ? `${slug}.json`
    : (readdirSync(base).find((f) => f.endsWith('.json')) || null);
  if (!jsonName) { continue; }
  const jsonPath = `${base}/${jsonName}`;

  let song;
  try { song = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { console.log(`  ${slug}: SKIP (unreadable ${jsonName})`); skipped++; continue; }

  const songSlug = song.id || slug;
  const manifestPath = `${base}/takes/${songSlug}/manifest.json`;
  let folderManifestRaw = null;
  if (existsSync(manifestPath)) {
    try { folderManifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* corrupt — reconcile treats as no-op */ }
  }

  const r = reconcileTakelessSong(song, folderManifestRaw);
  if (!r.changed) {
    const has = !!(song.tapeDeck && Array.isArray(song.tapeDeck.takes) && song.tapeDeck.takes.length);
    // Even a clean song may still carry a redundant legacy manifest.json — drop it (delete-on-contact).
    if (has && existsSync(manifestPath)) {
      console.log(`  ${slug}: CLEAN (${song.tapeDeck.takes.length} takes) — drop redundant folder manifest.json`);
      if (write) rmSync(manifestPath);
    } else {
      console.log(`  ${slug}: ${has ? 'CLEAN (' + song.tapeDeck.takes.length + ' takes)' : 'no takes'}`);
    }
    clean++;
    continue;
  }

  // Audit: every referenced WAV must exist on disk (a manifest can outlive a deleted WAV).
  const missing = [];
  for (const t of r.tapeDeck.takes) {
    for (const k of ['stem1', 'stem2', 'stem3', 'stem4']) {
      const s = t.stems && t.stems[k];
      if (s && s.file && !existsSync(`${base}/takes/${songSlug}/${s.file}`)) missing.push(s.file);
    }
    if (t.bounce && t.bounce.file && !existsSync(`${base}/takes/${songSlug}/${t.bounce.file}`)) missing.push(t.bounce.file);
  }

  drifted++;
  console.log(`  ${slug}: DRIFTED → backfill ${r.takeCount} take(s)${missing.length ? ` (WARNING: ${missing.length} referenced WAV(s) missing: ${missing.join(', ')})` : ''}`);
  if (missing.length) missingWavs++;

  if (write) {
    const next = { ...song, tapeDeck: r.tapeDeck };
    const v = validateSong(next);
    if (!v.ok) { console.log(`    !! refusing to write ${jsonName}: ${v.errors[0]}`); skipped++; continue; }
    writeFileSync(jsonPath, JSON.stringify(next, null, 2));
    if (existsSync(manifestPath)) rmSync(manifestPath); // deprecate: the .json is now the source of truth
    console.log(`    ✓ wrote ${jsonName} + deleted folder manifest.json`);
    repaired++;
  }
}

console.log(`\n${write ? 'Applied' : 'Dry run'}: drifted ${drifted}, ${write ? `repaired ${repaired}, ` : ''}clean ${clean}, skipped ${skipped}${missingWavs ? `, ${missingWavs} with missing WAVs` : ''}.`);
if (!write && drifted) console.log('Re-run with --write to apply.');
