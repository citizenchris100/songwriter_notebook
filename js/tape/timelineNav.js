// js/tape/timelineNav.js — PURE horizontal-scroll geometry for the Timeline nav arrows.
//
// The Timeline lanes live on a 48px-per-bar grid inside a horizontally-scrolling
// container; on a long take most bars sit off-screen. The ◀/▶ toolbar buttons page the
// viewport by one screenful. This module owns ONLY the integer-pixel clamp math — it
// reads no DOM (the impure shell in tapeView.js injects scrollLeft / clientWidth / gridW)
// and mutates no inputs, so it stays a zero-import leaf engine.test.js can load directly
// (same discipline as clipModel.js).

// The maximum horizontal scroll offset (px): how much wider the content is than the
// viewport. 0 when the content already fits (both arrows greyed). Never negative.
export function maxScrollPx(viewportW, contentW) {
  return Math.max(0, (contentW | 0) - (viewportW | 0));
}

// The next scroll offset (px) for a one-screenful nav step.
//   dir       -1 = left (toward bar 1), +1 = right (toward the end)
//   overlapPx how much of the current screen to keep visible (one bar = 48px)
// Pages by (viewportW - overlapPx), floored to 1 so it always advances even when the
// viewport is narrower than the overlap. Result clamped to [0, maxScrollPx].
export function pageScrollOffset(currentPx, dir, viewportW, contentW, overlapPx) {
  const page = Math.max(1, (viewportW | 0) - (overlapPx | 0));
  const next = (currentPx | 0) + (dir < 0 ? -page : page);
  return Math.max(0, Math.min(maxScrollPx(viewportW, contentW), next | 0));
}
