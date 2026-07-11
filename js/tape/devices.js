// js/tape/devices.js — IMPURE device probe + input-selection heuristics (§5.5).
// Runs inside the Record/tap gesture (labels/settings are empty pre-grant).
// Browser-only — never imported by the node engine test.

const LAST_USED_KEY = 'sn_tape_input';
const USB_LABEL_HINTS = ['evo', 'audient', 'usb', 'interface'];

// All of echoCancellation/noiseSuppression/autoGainControl MUST be false — any
// one of them on collapses the track to mono on iOS Safari and routes Android
// through processed paths (§5.4). channelCount:2 is an ideal constraint — never
// over-constrains a mono device.
const captureConstraints = (deviceId) => ({
  audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  },
});

export function getLastUsedInput() {
  try { return localStorage.getItem(LAST_USED_KEY); } catch { return null; }
}
export function setLastUsedInput(deviceId) {
  try { if (deviceId) localStorage.setItem(LAST_USED_KEY, deviceId); } catch { /* ignore */ }
}

function isUsbLike(label) {
  const l = (label || '').toLowerCase();
  return USB_LABEL_HINTS.some((hint) => l.includes(hint));
}

// last-used -> first USB-ish label -> platform default (AC-25 preselection order).
function pickPreferred(inputs, lastUsedId) {
  if (lastUsedId && inputs.some((d) => d.deviceId === lastUsedId)) return lastUsedId;
  const usbLike = inputs.find((d) => isUsbLike(d.label));
  if (usbLike) return usbLike.deviceId;
  return inputs[0] ? inputs[0].deviceId : null;
}

// Acquire a track (optionally on a specific device), read its settings +
// capabilities, enumerate the input list, then STOP the probe track (step 5 —
// no live mic indicator just for looking at the deck).
// Returns { ok:true, channels, label, isLikelyInterface, warnMoreThanTwo, inputs, preselectedId }
//      or { ok:false, denied:true }  (AC-26).
export async function probe(deviceId) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(captureConstraints(deviceId));
  } catch {
    return { ok: false, denied: true };
  }
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  const channels = settings.channelCount || 1;
  const label = track.label || '';
  const isLikelyInterface = isUsbLike(label);

  // getCapabilities may be absent on iOS Safari — best-effort only (§7).
  let warnMoreThanTwo = false;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : null;
    if (caps && caps.channelCount && typeof caps.channelCount.max === 'number') warnMoreThanTwo = caps.channelCount.max > 2;
  } catch { /* best-effort */ }

  let inputs = [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    inputs = all.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
  } catch { /* no picker if enumeration fails */ }

  stream.getTracks().forEach((t) => t.stop());

  const preselectedId = inputs.length ? pickPreferred(inputs, getLastUsedInput()) : null;
  return { ok: true, channels, label, isLikelyInterface, warnMoreThanTwo, inputs, preselectedId };
}

// Record re-acquires fresh (step 6) — same constraints, kept LIVE this time; the
// caller owns the resulting stream for the actual capture graph. The interface
// may have been (un)plugged since the probe, so the caller must re-read
// channelCount from this stream rather than trusting the earlier probe.
export async function acquireForRecording(deviceId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(captureConstraints(deviceId));
    if (deviceId) setLastUsedInput(deviceId);
    return { ok: true, stream };
  } catch {
    return { ok: false, denied: true };
  }
}
