// js/tape/clipModel.js — PURE integer-bar clip geometry for the timeline lane.
//
// A LANE is { vol, eq, comp, clips: Clip[] }; a timeline CLIP is
//   { id, file, startBar, bars, durationSec, loc, group }.
// This module reasons ONLY about the integer-bar geometry (startBar/bars) and the
// NON-OVERLAP invariant (clips in a lane never overlap; they are kept ordered by
// startBar). It never touches bpm/seconds/samples and never mints ids: durations and
// ids are INJECTED by the impure shell (same discipline takeModel.js documents for its
// take numbers/timestamps). takeModel.js imports THIS module; never the reverse — so it
// stays a zero-import leaf that engine.test.js can load directly.
//
// "clip" here is a TIMELINE audio region, distinct from meter "clip(ping)" in meterModel.js.
//
// Every lane transform returns { lane, removed?, created?, copyFrom? }:
//   lane     the new immutable lane (settings preserved, clips re-sorted)
//   removed  clips whose WAV files the shell should delete
//   created  fresh clips (file:null / durationSec:null) the shell fills in after the byte op
//   copyFrom the source clip's file the shell byte-slices/copies to make the created clip(s)

// Half-open interval end: a clip occupies bars [startBar, startBar+bars).
export function clipEndBar(clip) {
  return clip.startBar + clip.bars;
}

// Two clips overlap iff their half-open bar intervals intersect. Adjacency (a ends where
// b begins) is NOT an overlap.
export function clipsOverlap(a, b) {
  return a.startBar < clipEndBar(b) && b.startBar < clipEndBar(a);
}

// The lane's length in bars = the furthest clip end (0 for an empty/absent lane).
export function laneLengthBars(lane) {
  const clips = (lane && lane.clips) || [];
  let max = 0;
  for (const c of clips) { const e = clipEndBar(c); if (e > max) max = e; }
  return max;
}

// The clips (in their current order) intersecting the region [startBar, startBar+bars).
export function clipsInRegion(clips, startBar, bars) {
  const region = { startBar, bars };
  return (clips || []).filter((c) => clipsOverlap(c, region));
}

// The lowest bar >= fromBar where a `bars`-long clip fits with NO overlap (shift-right-to-fit):
// walk the occupied intervals, jumping past any that would collide, until a clear window is found.
export function firstFreeBarFrom(clips, fromBar, bars) {
  let at = Math.max(0, fromBar | 0);
  const sorted = (clips || []).slice().sort((a, b) => a.startBar - b.startBar);
  let moved = true;
  while (moved) {
    moved = false;
    for (const c of sorted) {
      if (at < clipEndBar(c) && c.startBar < at + bars) { at = clipEndBar(c); moved = true; }
    }
  }
  return at;
}

// Re-key a lane with a new clips list (settings preserved by spread), kept ordered by startBar.
function withClips(lane, clips) {
  return { ...(lane || {}), clips: clips.slice().sort((a, b) => a.startBar - b.startBar) };
}

// A fresh clip derived from a source clip: new id, no file/duration yet (the shell writes the WAV
// and measures it), living in OPFS, same recording group + provenance, given geometry.
function derive(src, id, startBar, bars) {
  return { ...src, id, file: null, durationSec: null, loc: 'opfs', startBar, bars };
}

// RECORD: evict EVERY clip intersecting [startBar, startBar+bars) ENTIRELY (per the "replace
// ENTIRELY any clip the record head reaches" rule), then insert `clip`. Empty intersection ->
// nothing removed (the "record after existing = new clip after" case). `clip` is already fully
// formed by the caller (it owns the freshly-recorded WAV). Returns the evicted clips.
export function replaceRegionWithClip(lane, startBar, bars, clip) {
  const clips = (lane && lane.clips) || [];
  const removed = clipsInRegion(clips, startBar, bars);
  const removedIds = new Set(removed.map((c) => c.id));
  const kept = clips.filter((c) => !removedIds.has(c.id));
  return { lane: withClips(lane, kept.concat([clip])), removed };
}

// SLICE at bar boundary `bar`: split into left [start, bar) + right [bar, end). `bar` is clamped
// into (start, end) so neither half is empty. Two fresh clips replace the original; the shell
// byte-cuts copyFrom into the two files.
export function sliceClipAtBar(lane, clipId, bar, ids) {
  const clips = (lane && lane.clips) || [];
  const orig = clips.find((c) => c.id === clipId);
  if (!orig) return { lane: withClips(lane, clips), removed: [], created: [], copyFrom: null };
  const at = Math.max(orig.startBar + 1, Math.min(clipEndBar(orig) - 1, bar | 0));
  const left = derive(orig, ids.leftId, orig.startBar, at - orig.startBar);
  const right = derive(orig, ids.rightId, at, clipEndBar(orig) - at);
  const kept = clips.filter((c) => c.id !== clipId);
  return { lane: withClips(lane, kept.concat([left, right])), removed: [orig], created: [left, right], copyFrom: orig.file };
}

// TRIM one bar off a clip's 'first' or 'last' edge. 'first' -> startBar+1, bars-1 (bar 2 becomes the
// new first bar); 'last' -> bars-1. A clip already 1 bar long is deleted (created:[]). The shell
// byte-drops the trimmed bar from copyFrom into the new file.
export function trimClipEdge(lane, clipId, edge, ids) {
  const clips = (lane && lane.clips) || [];
  const orig = clips.find((c) => c.id === clipId);
  if (!orig) return { lane: withClips(lane, clips), removed: [], created: [], copyFrom: null };
  const kept = clips.filter((c) => c.id !== clipId);
  if (orig.bars <= 1) return { lane: withClips(lane, kept), removed: [orig], created: [], copyFrom: orig.file };
  const trimmed = edge === 'first'
    ? derive(orig, ids.newId, orig.startBar + 1, orig.bars - 1)
    : derive(orig, ids.newId, orig.startBar, orig.bars - 1);
  return { lane: withClips(lane, kept.concat([trimmed])), removed: [orig], created: [trimmed], copyFrom: orig.file };
}

// DELETE a clip entirely. Returns it so the shell deletes its WAV.
export function deleteClip(lane, clipId) {
  const clips = (lane && lane.clips) || [];
  const orig = clips.find((c) => c.id === clipId);
  if (!orig) return { lane: withClips(lane, clips), removed: [] };
  return { lane: withClips(lane, clips.filter((c) => c.id !== clipId)), removed: [orig] };
}

// DUPE: place a src-length copy at the first free bar >= targetBar (shift-right-to-fit, so it never
// overlaps the original or any clip). The shell full-copies copyFrom into the new file.
export function dupeClip(lane, clipId, targetBar, ids) {
  const clips = (lane && lane.clips) || [];
  const src = clips.find((c) => c.id === clipId);
  if (!src) return { lane: withClips(lane, clips), created: [], copyFrom: null };
  const copy = derive(src, ids.newId, firstFreeBarFrom(clips, targetBar, src.bars), src.bars);
  return { lane: withClips(lane, clips.concat([copy])), created: [copy], copyFrom: src.file };
}
