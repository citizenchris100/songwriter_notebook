// js/tape/wav.js — PURE WAV codec: 44-byte RIFF/PCM16 header, float<->int16
// conversion, channel interleaving, and a parser for the files this app itself
// writes. No DOM/Blob/Worker — node-importable, so engine.test.js proves the
// encoder and parser round-trip exactly.
//
// The header's two size fields are also what js/tape/opfsWorker.js re-patches
// during a streaming recording (every ~1 s) and at crash recovery — SIZE_FIELDS
// is the shared contract between the encoder here and the byte-patcher there.
export const SIZE_FIELDS = [
  { offset: 4, bias: 36 },   // ChunkSize      = dataBytes + 36
  { offset: 40, bias: 0 },   // Subchunk2Size  = dataBytes + 0
];

const RIFF = 0x46464952;  // 'RIFF' little-endian u32
const WAVE = 0x45564157;  // 'WAVE'
const FMT_ = 0x20746d66;  // 'fmt '
const DATA = 0x61746164;  // 'data'

function writeAscii(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

// A 44-byte RIFF/PCM16 header for `dataBytes` of audio. Placeholder sizes are
// fine at open-time (the worker patches them in place as it streams).
export function wavHeader(channels, rate, dataBytes) {
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, dataBytes + 36, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);             // Subchunk1Size (PCM)
  view.setUint16(20, 1, true);              // AudioFormat = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);  // ByteRate
  view.setUint16(32, channels * 2, true);         // BlockAlign
  view.setUint16(34, 16, true);                   // BitsPerSample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return buf;
}

// Float32 [-1,1] -> Int16, asymmetric clamp (matches captureProcessor.js's
// duplicated in-worklet formula — keep the two in sync by comment there).
export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

// The exact inverse of floatToInt16's asymmetric scaling.
function int16ToFloat(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) {
    const v = i16[i];
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

// Interleave N same-length Float32Array channel buffers into one Float32Array
// (L,R,L,R,… for stereo). Mono (one channel) is returned as-is (interleaving is a
// no-op), though callers may also just skip calling this for a single stem.
export function interleave(chArrays) {
  if (chArrays.length === 1) return chArrays[0];
  const channels = chArrays.length;
  const frames = chArrays[0].length;
  const out = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) out[f * channels + c] = chArrays[c][f];
  return out;
}

// Parse a PCM16 RIFF file this app wrote. Rejects anything else with a clear
// error rather than trying to handle the general WAV format universe.
export function parseWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 44) throw new Error('parseWav: file too short to hold a WAV header');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint32(0, true) !== RIFF || view.getUint32(8, true) !== WAVE) throw new Error('parseWav: not a RIFF/WAVE file');
  if (view.getUint32(12, true) !== FMT_) throw new Error('parseWav: expected a "fmt " chunk at byte 12');
  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== 1) throw new Error('parseWav: only uncompressed PCM is supported (got format ' + audioFormat + ')');
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== 16) throw new Error('parseWav: only 16-bit PCM is supported (got ' + bitsPerSample + '-bit)');
  if (view.getUint32(36, true) !== DATA) throw new Error('parseWav: expected a "data" chunk at byte 36');
  const dataBytes = view.getUint32(40, true);
  const available = u8.length - 44;
  const usable = Math.min(dataBytes, available - (available % 2));
  const frameCount = usable / 2 / channels;
  const i16 = new Int16Array(u8.buffer, u8.byteOffset + 44, usable / 2);
  const samples = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Int16Array(frameCount);
    for (let f = 0; f < frameCount; f++) ch[f] = i16[f * channels + c];
    samples.push(int16ToFloat(ch));
  }
  return { channels, rate, samples };
}
