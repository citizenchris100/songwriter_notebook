// js/tape/drumKits.js — IMPURE sample + impulse-response loader for the drum machine.
// Browser-only (fetch + AudioContext.decodeAudioData); never imported by engine.test.js.
// Fetches the bundled one-shot WAVs (assets/drums/kits/<kit>/<voice>.wav) and reverb
// impulse WAVs (assets/drums/ir/<file>), decodes them to AudioBuffers, and caches per kit /
// per effect so a re-open is instant. Decoded AudioBuffers are context-agnostic, so the one
// cache serves the live AudioContext (record + playback) AND the OfflineAudioContext bounce
// (a cross-rate buffer is resampled by the AudioBufferSourceNode).
//
// Every asset is listed in sw.js ASSETS, so the plain fetch() is served from the service-
// worker cache offline — the same rule the tape worklet/worker sources rely on.

import { VOICE_IDS, EFFECTS } from './drumModel.js';

const KIT_BASE = './assets/drums/kits/';
const IR_BASE = './assets/drums/ir/';

const kitCache = new Map();   // kitId    -> Promise<{ [voiceId]: AudioBuffer|null }>
const irCache = new Map();    // effectId -> Promise<AudioBuffer|null>

async function fetchDecode(ctx, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('drum asset ' + url + ' -> HTTP ' + res.status);
  const bytes = await res.arrayBuffer();
  return await ctx.decodeAudioData(bytes);
}

// Load (and cache) every voice buffer for a kit. A missing/undecodable voice resolves to
// null (that voice is simply silent) rather than failing the whole kit.
export function loadKit(ctx, kitId) {
  if (kitCache.has(kitId)) return kitCache.get(kitId);
  const p = (async () => {
    const out = {};
    await Promise.all(VOICE_IDS.map(async (id) => {
      try { out[id] = await fetchDecode(ctx, KIT_BASE + kitId + '/' + id + '.wav'); }
      catch { out[id] = null; }
    }));
    return out;
  })();
  kitCache.set(kitId, p);
  return p;
}

// Load (and cache) the impulse response for an effect id. 'none' and biquad-kind effects
// (telephone/intercom/muffler — no IR file) resolve to null.
export function loadEffect(ctx, effectId) {
  const eff = EFFECTS.find((e) => e.id === effectId);
  if (!eff || eff.kind !== 'ir' || !eff.file) return Promise.resolve(null);
  if (irCache.has(effectId)) return irCache.get(effectId);
  const p = fetchDecode(ctx, IR_BASE + eff.file).catch(() => null);
  irCache.set(effectId, p);
  return p;
}

// Drop the decoded-buffer caches (buffers are otherwise kept for the app's lifetime).
export function clearDrumCaches() { kitCache.clear(); irCache.clear(); }
