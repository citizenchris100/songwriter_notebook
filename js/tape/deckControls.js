// js/tape/deckControls.js — IMPURE DOM builders for the portastudio deck face:
// rotary knobs, vertical faders, segmented LED meters, and the LED counter window.
// Built with dom.js's h(); browser-only (pointer events), never imported by the node
// engine test. All the metering MATH lives in the pure meterModel.js — these widgets
// are deliberately dumb: a knob rotates an indicator line, a meter sets one CSS var.
//
// Knobs and faders honor the deck's D32 two-phase contract: onPreview fires live on
// every drag tick (the caller applies it to the audio graph with NO render/persist),
// onCommit fires once on release (the caller persists + renders). Double-tap resets to
// the control's detent. touch-action:none in CSS keeps a vertical drag from scrolling
// the page (and suppresses iOS double-tap zoom); pointer capture keeps the gesture even
// if the finger slides off the small target.
import { h } from '../dom.js';

const KNOB_SWEEP_DEG = 270;   // total rotation across the value range (-135deg..+135deg)
const KNOB_RANGE_PX = 170;    // vertical drag distance for a full-range sweep
const TAP_SLOP_PX = 4;        // movement under which a pointerup counts as a tap, not a drag
const DTAP_MS = 320;          // max gap between the two taps of a double-tap
const DTAP_PX = 14;           // max distance between the two taps of a double-tap

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function clampStep(v, min, max, step) {
  let x = clamp(v, min, max);
  if (step > 0) x = Math.round(x / step) * step;
  return clamp(x, min, max);
}

// A rotary knob. { label, value, min, max, step, detent, disabled, onPreview, onCommit }
// -> { el, set(v) }. The indicator line rotates; nothing else repaints during a drag.
export function buildKnob({ label, value, min, max, step = 0.01, detent = 0, disabled = false, onPreview, onCommit }) {
  const el = h('div', 'knob' + (disabled ? ' disabled' : ''));
  const face = h('div', 'knob-face');
  face.appendChild(h('div', 'knob-ind'));
  el.append(face, h('span', 'knob-lbl', label));

  let cur = clampStep(value, min, max, step);
  const angleFor = (v) => -KNOB_SWEEP_DEG / 2 + KNOB_SWEEP_DEG * ((v - min) / (max - min));
  const apply = (v) => { face.style.transform = 'rotate(' + angleFor(v).toFixed(1) + 'deg)'; };
  apply(cur);

  if (!disabled) {
    let pid = null, sy = 0, sx = 0, sVal = 0, dist = 0;
    let lastTap = 0, lastX = 0, lastY = 0;

    el.addEventListener('pointerdown', (e) => {
      pid = e.pointerId; sy = e.clientY; sx = e.clientX; sVal = cur; dist = 0;
      try { el.setPointerCapture(pid); } catch { /* ignore */ }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      dist = Math.max(dist, Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy));
      cur = clampStep(sVal + (sy - e.clientY) / KNOB_RANGE_PX * (max - min), min, max, step); // up = increase
      apply(cur);
      onPreview && onPreview(cur);
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      try { el.releasePointerCapture(pid); } catch { /* ignore */ }
      pid = null;
      if (dist <= TAP_SLOP_PX) {
        if (cur !== sVal) { cur = sVal; apply(cur); onPreview && onPreview(cur); } // undo any sub-slop preview
        const t = now();
        if (t - lastTap <= DTAP_MS && Math.abs(e.clientX - lastX) <= DTAP_PX && Math.abs(e.clientY - lastY) <= DTAP_PX) {
          cur = clampStep(detent, min, max, step); apply(cur); onCommit && onCommit(cur); lastTap = 0; return; // double-tap -> detent
        }
        lastTap = t; lastX = e.clientX; lastY = e.clientY;
        return; // a single tap doesn't change the value
      }
      onCommit && onCommit(cur);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  return { el, set: (v) => { cur = clampStep(v, min, max, step); apply(cur); } };
}

// A vertical fader. { value, min, max, detent, disabled, onPreview, onCommit } ->
// { el, set(v) }. Grab-anywhere (the cap jumps to the touch), soft detent snap near
// unity, double-tap resets to detent.
export function buildFader({ value, min = 0, max = 1.5, detent = 1.0, disabled = false, onPreview, onCommit }) {
  const el = h('div', 'fader' + (disabled ? ' disabled' : ''));
  const cap = h('div', 'fader-cap');
  const unity = h('div', 'fader-unity');
  unity.style.bottom = ((detent - min) / (max - min) * 100) + '%';
  el.append(h('div', 'fader-slot'), unity, cap);

  let cur = clamp(value, min, max);
  const place = (v) => { cap.style.bottom = ((v - min) / (max - min) * 100) + '%'; };
  place(cur);

  if (!disabled) {
    let pid = null, sx = 0, sy = 0, dist = 0;
    let lastTap = 0, lastX = 0, lastY = 0;
    const valAt = (clientY) => {
      const r = el.getBoundingClientRect();
      let v = clamp(min + (r.bottom - clientY) / r.height * (max - min), min, max);
      if (Math.abs(v - detent) < 0.04) v = detent; // soft detent at unity
      return v;
    };
    el.addEventListener('pointerdown', (e) => {
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; dist = 0;
      try { el.setPointerCapture(pid); } catch { /* ignore */ }
      cur = valAt(e.clientY); place(cur); onPreview && onPreview(cur);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      dist = Math.max(dist, Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy));
      cur = valAt(e.clientY); place(cur); onPreview && onPreview(cur);
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      try { el.releasePointerCapture(pid); } catch { /* ignore */ }
      pid = null;
      const isTap = dist <= TAP_SLOP_PX;
      const t = now();
      if (isTap && t - lastTap <= DTAP_MS && Math.abs(e.clientX - lastX) <= DTAP_PX && Math.abs(e.clientY - lastY) <= DTAP_PX) {
        cur = detent; place(cur); onCommit && onCommit(cur); lastTap = 0; return; // double-tap -> unity
      }
      if (isTap) { lastTap = t; lastX = e.clientX; lastY = e.clientY; }
      onCommit && onCommit(cur);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  return { el, set: (v) => { cur = clamp(v, min, max); place(cur); } };
}

// A segmented LED ladder. { segments } -> { el, set(lit, clip) } where lit is a 0..1
// fraction (already dB-spaced + quantized by the caller via meterModel) and clip flips
// the whole ladder red. Updates are one CSS-var write + a class toggle — no layout.
export function buildLedMeter({ segments = 12 } = {}) {
  const el = h('div', 'ledmeter');
  el.style.setProperty('--seg', String(segments));
  el.style.setProperty('--lit', '0');
  el.append(h('div', 'led-off'), h('div', 'led-on'));
  return {
    el,
    set(lit, clip) {
      el.style.setProperty('--lit', String(clamp(lit || 0, 0, 1)));
      el.classList.toggle('clip', !!clip);
    },
  };
}

// The LED counter window. { time, take, stat } -> { el, timeEl, takeEl, statEl }.
export function buildCounter({ time = '0:00', take = '', stat = '' } = {}) {
  const el = h('div', 'tapecounter');
  const timeEl = h('div', 'tc-time', time);
  const takeEl = h('div', 'tc-take', take);
  const statEl = h('div', 'tc-stat', stat);
  el.append(timeEl, takeEl, statEl);
  return { el, timeEl, takeEl, statEl };
}
