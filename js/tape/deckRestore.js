// js/tape/deckRestore.js — the tape deck's multi-store RECONCILIATION, extracted from the
// impure main.js so its composition is EXECUTABLE in the node engine test (this is the seam
// every prior recurrence hid in: three take stores — OPFS working manifest, the song .json's
// tapeDeck.takes, and the deprecated folder manifest.json — reconciled inline and only ever
// grep-"tripwired", never run). Pure decisions + one impure-by-INJECTION orchestrator whose I/O
// arrives as ports, so it has zero import-time side effects and node can load this file.
//
// SSOT model: the song .json is the ONLY written durable store. The folder manifest.json is never
// written going forward; it is read ONCE as legacy recovery, folded into the .json, then DELETED
// on contact (gated on a verified .json write). OPFS stays an ephemeral recording scratch.
import {
  activeAudioTakeCount, hydrateSavedTakes, projectTakesForJson, tapeDeckWithTakes, rekeyManifest,
  createManifest, normalizeManifest, validateManifest, tapeDeckRef, stemFileName, mixFileName,
  filledSlotKeys, maxSlotDuration, slotHasAudio, slotLoc, defaultStemSettings,
  referencedMidiFiles, referencedLoopFiles, midiRef, loopsRef, STEM_KEYS,
} from './takeModel.js';

// A manifest "references folder audio" iff any active take has a folder-loc filled slot or a folder
// bounce — i.e. listing it is free, but PLAYING it needs the song folder granted this session.
export function manifestReferencesFolderAudio(manifest) {
  const takes = (manifest && manifest.takes) || [];
  return takes.some((t) => t && t.status === 'active' && (
    STEM_KEYS.some((k) => slotHasAudio(t.stems && t.stems[k]) && slotLoc(t.stems[k]) === 'folder')
    || !!(t.bounce && t.bounce.file && t.bounce.loc === 'folder')
  ));
}

// The full deck-open precedence as ONE pure decision. Inputs are the already-gathered + normalized
// stores; the caller does the I/O. Returns the chosen source, the working manifest (never null), the
// banner flags (needsGrant to PLAY, offerRecover for an empty-but-recoverable deck), whether it is
// safe to re-seed OPFS, and — on a folder recovery — the tapeDeck to backfill into the .json.
//
// Precedence: OPFS(intact + non-empty = session truth, in-session deletes respected) -> .json
// hydrate (durable, permission-free) -> folder manifest (only supplied on a granted re-run) ->
// REBOOT HOLE: empty everywhere but a remembered-yet-ungranted folder MIGHT hold takes -> offer
// recover -> genuinely empty.
export function resolveDeckRestore(inputs) {
  const i = inputs || {};
  const slug = i.slug || '';
  const savedTakes = Array.isArray(i.savedTakes) ? i.savedTakes : [];
  const opfsManifest = i.opfsManifest || null;
  const opfsReadable = i.opfsReadable !== false;      // default true; false ONLY when the read threw (evicted)
  const folderManifest = i.folderManifest || null;
  const folderGranted = !!i.folderGranted;
  const hasFolderHandle = !!i.hasFolderHandle;

  const durableCount = activeAudioTakeCount({ takes: savedTakes });
  const mightHaveHiddenDurable = hasFolderHandle || durableCount > 0;

  let source; let manifest; let migratedFromFolder = false; let tapeDeckToStamp = null; let offerRecover = false;

  if (opfsReadable && opfsManifest && activeAudioTakeCount(opfsManifest) > 0) {
    source = 'opfs'; manifest = opfsManifest;                                    // session truth
  } else if (durableCount > 0) {
    source = 'json'; manifest = hydrateSavedTakes(slug, savedTakes);            // the .json SSOT
  } else if (folderManifest && activeAudioTakeCount(folderManifest) > 0) {
    source = 'folder';                                                          // legacy recovery (granted re-run)
    manifest = hydrateSavedTakes(slug, projectTakesForJson(folderManifest));
    migratedFromFolder = true; tapeDeckToStamp = tapeDeckWithTakes(slug, folderManifest);
  } else if (hasFolderHandle && !folderGranted) {
    source = 'fresh'; manifest = createManifest(slug); offerRecover = true;     // THE REBOOT HOLE
  } else if (opfsManifest) {
    source = 'opfs'; manifest = opfsManifest;                                   // a legitimately empty OPFS deck
  } else {
    source = 'fresh'; manifest = createManifest(slug);                          // genuinely empty
  }

  // Exactly main.js's okToWriteOpfs guard: never cache a json/folder hydrate (metadata only), and
  // never cache an EMPTY manifest while a durable copy (folder handle or .json takes) could exist.
  const canWriteOpfs = (source === 'json' || source === 'folder')
    ? false
    : manifest.takes.length > 0
      ? source === 'opfs'
      : !mightHaveHiddenDurable;

  const needsGrant = !folderGranted && (
    source === 'json' || source === 'folder'
    || (manifestReferencesFolderAudio(manifest) && hasFolderHandle)
  );

  return { source, manifest, needsGrant, offerRecover, canWriteOpfs, migratedFromFolder, tapeDeckToStamp, durableCount };
}

// The repair core shared by on-open recovery AND tools/repair-takeless-songs.js: given a song whose
// .json carries no takes and its folder's (raw) manifest, decide the tapeDeck + working manifest to
// stamp. NEVER clobbers a song that already has takes (its .json stays the source of truth). Pure.
export function reconcileTakelessSong(song, folderManifestRaw) {
  const none = { changed: false, tapeDeck: null, manifest: null, takeCount: 0 };
  const existing = song && song.tapeDeck && Array.isArray(song.tapeDeck.takes) ? song.tapeDeck.takes : [];
  if (existing.length > 0) return none;
  const m = folderManifestRaw && validateManifest(folderManifestRaw).ok ? normalizeManifest(folderManifestRaw) : null;
  if (!m || activeAudioTakeCount(m) === 0) return none;
  const slug = (song && song.id) || m.slug;
  const tapeDeck = tapeDeckWithTakes(slug, m);
  if (!tapeDeck.takes.length) return none;
  return { changed: true, tapeDeck, manifest: hydrateSavedTakes(slug, tapeDeck.takes), takeCount: tapeDeck.takes.length };
}

// Filename-scan fallback (H4): reconstruct a minimal but valid manifest from the WAVs on disk when
// the folder manifest.json is corrupt/absent. Loses per-slot EQ/comp/duration (defaults applied) and
// flags every take `recovered` — the last-resort recovery so intact WAVs are never orphaned.
export function reconstructManifestFromFiles(slug, fileNames) {
  const files = Array.isArray(fileNames) ? fileNames : [];
  const esc = String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stemRe = new RegExp('^' + esc + '_(\\d+)_(stem[1-4])\\.wav$');
  const mixRe = new RegExp('^' + esc + '_(\\d+)_mix\\.wav$');
  const byTake = new Map();
  const ensure = (n) => { if (!byTake.has(n)) byTake.set(n, { stems: {}, bounce: null }); return byTake.get(n); };
  for (const f of files) {
    let m = stemRe.exec(f);
    if (m) { ensure(Number(m[1])).stems[m[2]] = f; continue; }
    m = mixRe.exec(f);
    if (m) ensure(Number(m[1])).bounce = f;
  }
  const takes = [];
  for (const [take, rec] of [...byTake.entries()].sort((a, b) => a[0] - b[0])) {
    const stems = {};
    for (const k of STEM_KEYS) stems[k] = rec.stems[k] ? { file: rec.stems[k], group: 1, durationSec: 0, loc: 'folder', ...defaultStemSettings() } : null;
    if (!STEM_KEYS.some((k) => stems[k])) continue; // a bounce with no stems is not restorable as tracks
    takes.push({ take, status: 'active', recovered: true, createdAt: '', durationSec: 0, sampleRate: 48000, stems, bounce: rec.bounce ? { file: rec.bounce, bouncedAt: '', lufs: null, loc: 'folder' } : null });
  }
  return normalizeManifest({ schemaVersion: 2, slug, takes });
}

// Dupe's take-source decision (pure): WHICH durable takes travel and WHICH files to copy, sourcing
// from the source's embedded tapeDeck.takes ELSE its (recovered) folder manifest ELSE a folder scan
// (H1 — a legacy source whose takes live only in the folder must not silently vanish). Returns the
// copy plan + a candidate rekeyed tapeDeck; the impure caller copies resiliently (H3) and passes the
// files that actually landed to pruneTapeDeckToCopied so only real audio is embedded (H2).
export function planDupeTakes(args) {
  const a = args || {};
  const srcId = a.srcId || '';
  const newId = a.newId || '';
  const embedded = Array.isArray(a.embeddedTakes) ? a.embeddedTakes : [];
  let sourceMan = null;
  if (embedded.length) sourceMan = { schemaVersion: 2, slug: srcId, takes: embedded };
  else if (a.folderManifest && validateManifest(a.folderManifest).ok && activeAudioTakeCount(normalizeManifest(a.folderManifest)) > 0) sourceMan = normalizeManifest(a.folderManifest);
  else if (Array.isArray(a.folderFiles) && a.folderFiles.length) sourceMan = reconstructManifestFromFiles(srcId, a.folderFiles);

  const projected = sourceMan ? projectTakesForJson(sourceMan) : [];
  if (!projected.length) return { copies: [], midiCopies: [], loopCopies: [], tapeDeck: null, needsSourceGrant: false };

  const srcDp = tapeDeckRef(srcId).path;
  const dstDp = tapeDeckRef(newId).path;
  const copies = [];
  for (const t of projected) {
    for (const key of filledSlotKeys(t)) {
      const dstFile = stemFileName(newId, t.take, key);
      copies.push({ src: srcDp + t.stems[key].file, dst: dstDp + dstFile, dstFile, take: t.take, slot: key });
    }
    if (t.bounce && t.bounce.file) {
      const dstFile = mixFileName(newId, t.take);
      copies.push({ src: srcDp + t.bounce.file, dst: dstDp + dstFile, dstFile, take: t.take, slot: 'bounce' });
    }
  }
  const rekeyed = rekeyManifest({ schemaVersion: 2, slug: srcId, takes: projected }, newId);
  const tapeDeck = tapeDeckWithTakes(newId, rekeyed);
  const midiCopies = [...referencedMidiFiles(rekeyed)].map((nm) => ({ src: midiRef(srcId) + nm, dst: midiRef(newId) + nm }));
  const loopCopies = [...referencedLoopFiles(rekeyed)].map((rel) => ({ src: loopsRef(srcId) + rel, dst: loopsRef(newId) + rel }));
  return { copies, midiCopies, loopCopies, tapeDeck, needsSourceGrant: copies.length > 0 };
}

// Reduce a candidate dupe tapeDeck to only the takes whose WAVs actually copied (H2/H3): null a slot
// whose file isn't in `copiedDstFiles`, drop the bounce likewise, flag a thereby-partial take
// `recovered`, and drop a take left with zero slots. Never embeds a ref to a file that isn't there.
export function pruneTapeDeckToCopied(tapeDeck, copiedDstFiles) {
  const copied = copiedDstFiles instanceof Set ? copiedDstFiles : new Set(copiedDstFiles || []);
  const takes = [];
  for (const t of (tapeDeck && tapeDeck.takes) || []) {
    const stems = {};
    let kept = 0; let lost = false;
    for (const key of STEM_KEYS) {
      const s = t.stems && t.stems[key];
      if (slotHasAudio(s) && copied.has(s.file)) { stems[key] = { ...s }; kept += 1; }
      else { stems[key] = null; if (slotHasAudio(s)) lost = true; }
    }
    if (!kept) continue;
    const bounce = t.bounce && t.bounce.file && copied.has(t.bounce.file) ? { ...t.bounce } : null;
    takes.push({ ...t, stems, bounce, durationSec: maxSlotDuration({ stems }), recovered: !!t.recovered || lost });
  }
  return { path: tapeDeck && tapeDeck.path, schemaVersion: 2, takes };
}

// The impure-by-INJECTION deck-open orchestrator: gather the stores via injected ports, run the pure
// decision, then apply the ordered, crash-safe writes. All decision logic stays in resolveDeckRestore;
// ports do ONLY I/O, so this whole composition runs in node against in-memory fakes.
//
// ports: { readOpfsManifest(path)->raw|throws, readFolderManifest(path)->raw|null, recoverPass(m)->m,
//   stampTapeDeck(id, tapeDeck), stampTapeDeckRef(id), writeSongJson(id)->bool, deleteFolderManifest(path),
//   writeOpfsManifest(path, m) }.
export async function runDeckRestore(inputs, ports) {
  const i = inputs || {};
  const slug = i.slug || '';
  const savedTakes = Array.isArray(i.savedTakes) ? i.savedTakes : [];
  const folderGranted = !!i.folderGranted;
  const hasFolderHandle = !!i.hasFolderHandle;
  const hasTapeDeckRef = !!i.hasTapeDeckRef;

  // 1. OPFS working manifest (throws when evicted — distinct from "readable but empty").
  let opfsManifest = null; let opfsReadable = true;
  try {
    const raw = await ports.readOpfsManifest(i.path);
    opfsManifest = raw && validateManifest(raw).ok ? normalizeManifest(raw) : null;
  } catch { opfsReadable = false; }

  // 2. First-pass decision — the passive open never reads the folder manifest (never prompts).
  let d = resolveDeckRestore({ slug, savedTakes, opfsManifest, opfsReadable, folderManifest: null, folderGranted, hasFolderHandle });

  // 3. Granted re-run: when the folder is ALREADY granted and NOTHING durable surfaced (the resolved
  //    manifest is empty — whether source 'fresh' or a readable-but-empty 'opfs'), read the legacy
  //    folder manifest ONCE and re-decide. This is the path onGrantFolder re-enters after the reboot
  //    hole's grant.
  if (activeAudioTakeCount(d.manifest) === 0 && folderGranted && hasFolderHandle) {
    const raw = await ports.readFolderManifest(i.path);
    const folderManifest = raw && validateManifest(raw).ok ? normalizeManifest(raw) : null;
    if (folderManifest) d = resolveDeckRestore({ slug, savedTakes, opfsManifest, opfsReadable, folderManifest, folderGranted, hasFolderHandle });
  }

  // 4. Backfill the .json from a folder recovery, then DELETE the legacy manifest — but ONLY after a
  //    VERIFIED .json write (H6: writeSongJson returns false without throwing on iOS/no-handle, where
  //    the manifest is the only durable record). Otherwise, first-ever open stamps the bare path ref.
  if (d.migratedFromFolder && d.tapeDeckToStamp) {
    ports.stampTapeDeck(slug, d.tapeDeckToStamp);
    const jsonWritten = await ports.writeSongJson(slug);
    if (jsonWritten) await ports.deleteFolderManifest(i.path);
  } else if (!hasTapeDeckRef) {
    ports.stampTapeDeckRef(slug);
  }

  // 5. Crash-recover any pass a prior session left mid-record.
  d.manifest = await ports.recoverPass(d.manifest);

  // 6. Re-seed OPFS only when the decision says it is safe (never a json/folder hydrate, never an empty
  //    manifest while a durable copy could still exist).
  if (d.canWriteOpfs) await ports.writeOpfsManifest(i.path, d.manifest);

  return d;
}
