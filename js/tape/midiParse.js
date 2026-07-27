// js/tape/midiParse.js — PURE Standard MIDI File (SMF) reader for drum import.
// Zero deps, no DOM: bytes in, note events out, so engine.test.js loads it headlessly
// (same discipline as clickModel.js / takeModel.js). It parses the files a drummer exports
// from a DAW/notation app: format 0 or 1, PPQ (ticks-per-quarter) division, running status,
// and meta/sysex events skipped by length. SMPTE (frame-based) division is rejected — the
// drum grid is PPQ/tick based. Only NOTE-ON (velocity > 0) events feed the grid; note-offs
// (0x8n, or 0x9n with velocity 0) are dropped. Mapping GM notes -> drum voices and
// quantizing to 16th steps lives in drumModel.js (it owns the GM map), so this file has no
// drum knowledge at all.

const readU16 = (b, p) => ((b[p] << 8) | b[p + 1]) >>> 0;
const readU32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

// Variable-length quantity: 7 bits per byte, high bit set = "more bytes follow". At most 4
// bytes (28 bits) per the SMF spec. Returns { value, next } (next = index past the VLQ).
export function readVarLen(bytes, pos) {
  let value = 0, p = pos;
  for (let i = 0; i < 4; i++) {
    const byte = bytes[p++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: p };
}

// Parse an SMF into { format, ntrks, ppq, tracks:[[ {tick,type,...} ]] } with ABSOLUTE
// ticks per event. `type` is 'noteOn' | 'noteOff' | 'meta' | 'sysex' | 'other'; note events
// carry {channel, note, velocity}; a tempo meta carries {metaType:0x51, usPerQuarter}.
export function parseSMF(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 14 || readU32(b, 0) !== 0x4d546864) throw new Error('not a MIDI file (missing MThd)');
  const headerLen = readU32(b, 4);
  const format = readU16(b, 8);
  const ntrks = readU16(b, 10);
  const division = readU16(b, 12);
  if (division & 0x8000) throw new Error('SMPTE time division is not supported (need PPQ)');
  const ppq = division & 0x7fff;
  if (ppq <= 0) throw new Error('invalid PPQ division');
  let pos = 8 + headerLen;                 // MThd data starts at 8; header is normally 6 bytes
  const tracks = [];
  for (let t = 0; t < ntrks && pos + 8 <= b.length; t++) {
    const chunkLen = readU32(b, pos + 4);
    if (readU32(b, pos) !== 0x4d54726b) { pos += 8 + chunkLen; continue; } // skip a non-MTrk chunk
    const end = Math.min(pos + 8 + chunkLen, b.length);
    let p = pos + 8, tick = 0, running = 0;
    const events = [];
    while (p < end) {
      const dv = readVarLen(b, p); tick += dv.value; p = dv.next;
      let status = b[p];
      if (status & 0x80) { p++; running = status < 0xf0 ? status : 0; } // system status clears running
      else { status = running; }                                        // running status: data starts here
      const hi = status & 0xf0, channel = status & 0x0f;
      if (hi === 0x90) {
        const note = b[p++], velocity = b[p++];
        events.push({ tick, type: velocity > 0 ? 'noteOn' : 'noteOff', channel, note, velocity });
      } else if (hi === 0x80) {
        const note = b[p++], velocity = b[p++];
        events.push({ tick, type: 'noteOff', channel, note, velocity });
      } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
        p += 2; events.push({ tick, type: 'other' });
      } else if (hi === 0xc0 || hi === 0xd0) {
        p += 1; events.push({ tick, type: 'other' });
      } else if (status === 0xff) {
        const metaType = b[p++]; const ml = readVarLen(b, p); p = ml.next;
        const dataStart = p; p += ml.value;
        if (metaType === 0x51 && ml.value === 3) {
          events.push({ tick, type: 'meta', metaType, usPerQuarter: (b[dataStart] << 16) | (b[dataStart + 1] << 8) | b[dataStart + 2] });
        } else {
          events.push({ tick, type: 'meta', metaType });
        }
      } else if (status === 0xf0 || status === 0xf7) {
        const sl = readVarLen(b, p); p = sl.next + sl.value; // sysex: skip by its declared length
        events.push({ tick, type: 'sysex' });
      } else {
        break; // unknown/garbage status — stop this track rather than loop forever
      }
    }
    tracks.push(events);
    pos = end;
  }
  return { format, ntrks, ppq, tracks };
}

// Every track's NOTE-ON (velocity > 0) merged into one list, sorted by absolute tick.
export function notesFromSMF(bytes) {
  const { tracks } = parseSMF(bytes);
  const notes = [];
  for (const events of tracks) for (const e of events) if (e.type === 'noteOn') notes.push({ note: e.note, tick: e.tick, velocity: e.velocity });
  notes.sort((a, b) => a.tick - b.tick);
  return notes;
}
