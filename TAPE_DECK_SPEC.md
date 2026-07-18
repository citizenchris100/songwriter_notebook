# Tape Deck — 2-Track Recorder for the Songwriter Notebook PWA

**Specification & Implementation Plan (build-ready)**

> Status: **revision 3 — implemented and expanded to a 4-track portastudio.** The body below (§1–§9)
> is the original revision-2 2-track spec, preserved as the design record; the **Revision 3 changelog**
> immediately below supersedes it wherever the two conflict (4 tracks not 2, mono not stereo, multi-pass
> fill, overdub monitoring, per-track ping-pong bounce, group-scoped retake). Read the changelog first.

**Revision 2 changelog (2026-07-11).** Adversarial review against the real codebase produced these
changes, all user-arbitrated: (1) worklet/worker scripts are loaded via `fetch → Blob URL` because
worklet module fetches bypass service workers — the SW `ASSETS` listing alone does NOT make offline
recording work; (2) crash consistency redesigned — a take enters the manifest at record START
(status `"recording"`), stem headers are re-patched every ~1 s, and interrupted takes are recovered
as playable on next deck open; (3) the compressor is always-in-circuit with neutral params at
detent 0 (bypass routing created a ~6 ms inter-stem misalignment); (4) bounce normalization gain is
clamped and silence is never boosted; (5) the brick-wall limiter is now a designed pure module
(`limiter.js`), not a name; (6) per-take Delete added (storage relief valve), Retake prompt gains
Cancel; (7) mono/no-interface takes are single-stem by definition; (8) Screen Wake Lock held while
recording; (9) **Android (Chromium) is a full v1 target** — adds an input-device picker and a second
Phase-0 spike device; (10) `decodeAudioData` replaced by a pure `parseWav`; bounce always renders at
48 kHz; meters come from the capture worklet, not AnalyserNodes; audio flows worklet→worker over a
transferred MessagePort; (11) boot-time OPFS dir GC and the IndexedDB fallback are cut; (12) dial
input follows the capture-only/no-render idiom with debounced manifest persistence; (13) the
engine test suite currently reports 282 passing checks (the "456" claim was wrong).

---

## Revision 3 changelog (4-track portastudio; supersedes §1–§9 where they conflict)

The 2-track deck below was expanded, at the user's direction, into a **4-track cassette portastudio**
(Tascam-424 / Beatles bounce-down mental model). All of it is implemented and covered by
`node engine.test.js`. The changes:

1. **A take is a 4-track container, not a single pass.** A take owns four slots `stem1..stem4` (internal
   keys kept so pre-existing 2-track takes still resolve; the UI labels them "Track 1..4"). A take is
   filled over **multiple recording passes**; each pass writes one or more currently-free slots.
2. **Multi-pass fill with input→track routing.** Arming a pass, the user maps interface inputs → free
   slots (`min(interface inputs, free slots, 4)` at once — 2 on the EVO; 4 total via multiple passes).
   The capture worklet tags each channel's chunk with its **destination slot number**; the OPFS worker
   opens **only the pass's slot files**, so already-recorded tracks are never truncated.
3. **Overdub monitoring (new capability; reverses the rev-2 no-overdub non-goal).** While recording a
   pass, the deck plays the take's already-recorded tracks so the performer overdubs in time. Alignment
   is a **capture gate**: the worklet discards frames until `beginFrame = (startAt + monitorLatencySec) *
   rate`, so every stem file's sample 0 IS the shared timeline t=0 and playback/bounce need no alignment
   code. `monitorLatencySec` is **measured on-device** (input latency is unexposed by Web Audio) with
   `tools/latency-spike.html` (EVO loopback) and entered in the deck; a wrong value flams the overdub by
   a fixed offset. iOS Safari lacks `AudioContext.outputLatency` → calibration is the reliable path.
4. **Per-track ping-pong bounce.** Each track strip has a Bounce▸ button → pick a destination track; the
   source + destination are summed (both effected, **mono**, limiter-guarded, no LUFS normalize) into the
   destination's file, the destination resets to neutral settings, and the **source slot is freed** for
   more recording. Destructive on the source (Share/Export is the backstop). The whole-take **master
   bounce** (sum all tracks → one `_mix.wav` with the LUFS-target + limiter mastering) stays.
5. **Group-scoped retake.** Every slot a pass writes is stamped with a monotonic `group`. "Retake"
   re-records **only the last recorded group** (the filled slots whose group is the max present): it
   frees those slots, deletes their audio, and re-arms a pass into exactly them (earlier groups play as
   backing). Supersedes the rev-2 whole-take Keep/Discard/Cancel + take-menu flow (the take menu is
   removed — passes stay within one take, so there's no cross-take ambiguity to resolve).
6. **Explicit "+ New take."** Record fills the current take's free slots; a separate "+ New take" starts
   a fresh empty container; a full take (4/4) disables Record (bounce a track to free one, or new take).
7. **MONO FOREVER (supersedes D18).** The app has no panning/stereo concept and never will (Phil Spector
   mono). The master bounce renders in a 1-channel `OfflineAudioContext` → `wavHeader(1,…)`; every track
   file is mono. This replaces the rev-2 "stereo, pan-ready" bounce.
8. **Manifest schema v2 + migration.** The manifest is `schemaVersion:2`; each slot gains `group` +
   per-slot `durationSec` (take `durationSec` = max filled slot). `normalizeManifest` migrates any v1
   take (scalar `channels`, no per-slot group) in place on first deck-open: stem1 (and stem2 iff
   `channels===2`) → group-1 slots with `durationSec = take.durationSec`; stem3/stem4 → free. **Stem
   filenames are unchanged**, so real on-device WAVs resolve; a migrated 2-track take opens as a partial
   4-track take (2 filled, 2 free), ready to overdub or bounce.
9. **New/changed pure transforms** (`takeModel.js`, all node-tested): `STEM_KEYS` = 4 + `MAX_TRACKS`;
   `makeTake` (empty container), `appendPassTracks`, `nextGroup`, `lastGroupSlotKeys`, `freeSlotKeys`/
   `filledSlotKeys`, `takeHasAudio`, `maxSlotDuration`, `defaultRouting`, `finalizePass` (replaces
   `finalizeTake`), `finalizeRecoveredPass` (replaces `finalizeRecoveredTake` — recovers per pending
   slot, frees empty ones, tombstones only an all-empty pass), `discardGroup`, `bounceTrackToTrack`;
   `setStemSettings` now preserves `group`/`durationSec`; `mostRecentKeptTake` gates on `takeHasAudio`.
10. **Capture ceiling raised to 4** (`devices.js` `channelCount:4` ideal; never over-constrains the 2-in
    EVO). The ">2 inputs" warning becomes ">4 inputs." `sw.js` `CACHE` bumped to `sn-v20` (no new files
    — all edits are to the existing ten `js/tape/*` modules; `tools/latency-spike.html` is a throwaway
    diagnostic, not part of the app).

**Still not a general DAW:** no timeline editing, no per-clip trimming, no plugin concept, no panning,
and take audio never enters the song export bundle (Share/Export per file only).

---

## 1. Context

The Songwriter Notebook PWA (this repo, deployed to GitHub Pages, installed on iPad) currently
generates chord progressions and lets a song carry uploaded `.m4a` *sketch* attachments. It has
no recording capability.

The user wants a bespoke, spec-controlled **2-track "tape deck"** attached to each song: record
**two live mics simultaneously** off a class-compliant 2-input USB interface (e.g. Audient EVO 4),
captured as one stereo stream split into two clean mono stems. This is explicitly **not a DAW**
and **not overdub-based** — both mics are recorded live in one pass. After recording, the user can
adjust per-stem level / 3-band EQ / one-knob compression *after the fact* (non-destructive), then
**bounce** the stems to a single loudness-normalized `.wav`. All DSP is **built in** — there is no
plugin concept and the user never installs or configures effects.

**Target platforms (v1).** Installed-PWA on **iPad (Safari/WebKit, iPadOS 17+)** — the primary
device — **and Android (Chrome/Chromium)**. Both run the Phase-0 capability spike and the Phase-8
acceptance walkthrough. Desktop Chromium works incidentally; Firefox is untargeted.

**Scope note / sanctioned expansion.** The `songwriter-pwa` skill currently lists a hard
non-negotiable: *"audio is limited to per-song sketch attachments (no synthesis, effects, or DAW)."*
This feature deliberately expands that boundary, at the user's explicit direction. Part of the work
is to **update that skill's scope rule** so the non-negotiable reflects the new tape-deck capability
(recording + built-in EQ/compression/bounce, still not a general DAW). This does not touch the
sketches feature, which remains as-is.

---

## 2. Scope & non-goals

**In scope**
- Per-song tape-deck view reached by a button on the active song.
- Simultaneous 2-mic capture → two clean mono stems (raw, no effects baked in). One-channel
  capture (no interface) → a **single-stem** take.
- Per-stem, non-destructive **volume**, **3-band EQ** (bass/mid/treble), **one-knob compressor**.
- Take lifecycle: record, stop, play/replay, retake (keep/discard/cancel), take menu, take history
  with discarded-take tombstones, monotonic take numbering, **per-take Delete**, **crash recovery**
  (an interrupted take is finalized and playable on next deck open).
- **Bounce** to a single stereo `.wav` with fixed automatic loudness "mastering" (LUFS-target +
  designed brick-wall safety limiter).
- Storage in **OPFS** with a displayed virtual path; per-take WAV **Share/Export**.
- Offline-first (works installed, airplane mode, on both target platforms).
- **Input-device picker** where the platform exposes multiple inputs (Android; hidden on iOS).
- **Screen Wake Lock** while recording.

**Non-goals (v1)**
- Overdubbing / punch-in / multi-pass layering.
- More than 2 simultaneous input channels (EVO 4 is 2-in; >2-input devices record only the first two).
- Software input monitoring (user monitors via the interface's hardware direct-monitor knob).
- Click track / metronome / tempo field. No recording length cap (streaming keeps memory flat;
  wake lock + the low-space warning cover the long-take case).
- Per-stem panning (bounce sums both stems to center; pan is the first obvious future extension).
- Editing/trimming/splicing audio, fades, automation, or any timeline UI.
- Including take audio in the song export bundle (takes are OPFS-only; exported per-WAV on demand).
- Dither on 16-bit conversion (documented nicety, not v1).
- An IndexedDB storage fallback. v1 requires OPFS + `createSyncAccessHandle` (present on both
  targets); an unsupported browser gets a clear "recording needs a current Safari/Chrome" note on
  the deck instead of a degraded half-feature.

---

## 3. Finalized requirements & acceptance criteria

Refined from the user's user story with every locked decision folded in. Format: Given / When / Then.

### 3.1 Navigation & device state

**AC-1 Open the deck.** *Given* I am viewing a saved song, *when* I tap the **Tape Deck** button,
*then* I am taken to that song's tape-deck view.
- The button is **disabled for an unsaved draft** (a draft has no slug/id, so no OPFS path); its
  tooltip says "Save the song first."

**AC-2 Interface present.** *Given* I am on a song's tape deck *and* a standards-compliant 2-input
device is connected (and selected, where a picker is shown), *when* I tap **Record**, *then* the
deck records the stereo stream from that device (input 1 → stem 1, input 2 → stem 2).

**AC-3 More than two inputs.** *Given* a compliant device with **>2 inputs**, *when* I tap **Record**,
*then* I get a message that **only the first two inputs will be recorded**, and recording proceeds on
those two. (This warning is capability-dependent; see §7 detection limits.)

**AC-4 No compliant device.** *Given* I do **not** have a compliant device connected, *when* I tap
the **Tape Deck** button, *then* I still land on the tape-deck view **and a disclaimer banner** is
shown ("No 2-input audio interface detected — the built-in mic records one channel only"). Recording
is **not blocked**; it proceeds on whatever default input exists and produces a **single-stem take**
(§5.2): one stem strip in the UI, `stems.stem2 = null`, and a bounce that renders the one stem to
both channels.

**AC-25 Input picker.** *Given* the platform exposes **more than one** audio-input device after the
permission grant (typical on Android, where the default is often the built-in mic even with a USB
interface attached), *then* the deck shows an **Input** selector listing the devices by label. The
preselected device is: the last-used input (remembered per §5.5), else the first label matching a
USB-interface heuristic, else the platform default. With exactly one device (typical iOS), the
selector is hidden.

**AC-26 Mic permission denied.** *Given* I denied the microphone permission, *then* the deck shows
a clear status ("Microphone access is blocked — enable it in Settings for this site"), Record is
disabled, and nothing throws. Granting later (re-opening the deck) restores normal behavior.

### 3.2 Recording & transport

**AC-5 Transport while recording.** *When* I tap **Record**, *then* one **stem track strip appears
per captured channel** (two with an interface, one without), each showing a **volume slider**, a
**3-dial EQ** (bass, mid, treble), and a **single-dial compressor**; a **Stop** button appears; and
an **elapsed timer + per-stem level meters** show recording progress.
- The vol/EQ/comp dials are settable but **preview only on playback** — there is no live software
  monitoring while the tape is rolling; the captured stems are always raw/clean.

**AC-6 Stop.** *Given* I am recording, *when* I tap **Stop**, *then* the Record/Stop controls are
replaced by **Play / Stop / Replay** controls, and a **Retake** button and a **Bounce** button appear.

**AC-24 Screen stays awake.** *While* recording, the app holds a **Screen Wake Lock** so the
device's auto-lock cannot interrupt the take; the lock is released on Stop. If the API is
unavailable, a one-line hint suggests disabling auto-lock for long takes.

**AC-27 Recording locks navigation.** *While* recording, in-app navigation away from the deck is
disabled (the Back control and the top tab strip are inert until Stop). OS-level interruptions
(lock, call, backgrounding) still stop the take cleanly (§5.8).

### 3.3 Retake, take menu, take history

**AC-7 Retake.** *Given* a recording is present, *when* I tap **Retake**, *then* I am prompted
**Keep / Discard / Cancel** for the last take (**only the last take** is affected). On **Discard**,
that take's audio is deleted from disc but its **tombstone record remains** (timestamp, length, take
number). On Keep or Discard, a **new take is armed and recording begins** with a Stop button. On
**Cancel**, nothing changes.

**AC-8 Take menu on stop.** *Given* I retook and am recording, *when* I tap **Stop**, *then* a **take
menu** is presented listing all takes (active + tombstones), and I choose which take loads into the
deck. The newest take is preselected; dismissing the menu loads the newest. Tombstones are listed
but not selectable.

**AC-9 Monotonic numbering.** Take numbers **increase monotonically and are never reused**, even when
a take is discarded or deleted — including takes that died mid-recording (they are in the manifest
from record start, §5.3). Discard/delete removes audio only, never the event record.

**AC-10 Take history.** The deck shows a **take-history** section listing each take with a
**human-readable timestamp** and its **length**. Active rows offer **Load**, **Share**, and
**Delete**; discarded takes appear as **tombstone rows** (no play/bounce/share), which is what makes
a gap in numbering legible. A recovered take (AC-23) carries a "(recovered)" marker.

**AC-22 Per-take delete.** *Given* any active take in the history, *when* I tap its **Delete** and
confirm inline, *then* its stems and bounce are deleted from disc and the take becomes a
**tombstone** (same semantics as Retake→Discard, available for every take, any time). If the deleted
take was loaded in the deck, the most recent remaining kept take loads (or the deck returns to its
empty/record state). This is the storage relief valve implied by AC-21.

**AC-11 Open loads most recent.** *When* I open a song's tape deck that already has takes, the **most
recent kept (active) take** loads, ready to play, with its saved vol/EQ/comp applied.

**AC-23 Crash recovery.** *Given* a recording was interrupted without a clean stop (tab kill, crash,
forced quit), *when* I next open that song's deck, *then* the take is **finalized automatically and
playable** up to the point of interruption: its header is patched from the bytes on disc, its
duration is computed from file size, and it becomes an **active** take marked "(recovered)". A
crashed take whose stem files hold no audio (≤ header size) becomes a tombstone instead.

### 3.4 Effects (non-destructive) & bounce

**AC-12 Non-destructive settings.** Stems are stored **clean**. Vol/EQ/comp are **saved settings**
applied live at **playback** and re-applied at **bounce**; they can be re-tweaked and re-bounced forever.

**AC-13 Bounce.** *Given* a recording is present, *when* I tap **Bounce**, *then* the stems are summed
per their **current vol/EQ/comp** into a single `.wav` saved on disc **alongside the stems**. The
transport shows a **"Bouncing…"** busy state until the file is written (or an error is surfaced).

**AC-14 Bounce mastering.** The bounced mix has **automatic, fixed** loudness "mastering"
(LUFS-target normalization to −14 LUFS + a brick-wall safety limiter at −1 dBFS). This is not
user-adjustable. Normalization gain is **clamped** (−12…+20 dB) and a near-silent take (below the
−50 LUFS floor) is written un-normalized — quiet room noise is never blasted to −14.

**AC-15 Re-bounce overwrites.** Re-bouncing a take **overwrites** that take's single `_mix.wav`. A take
has exactly one current bounce.

### 3.5 Naming, persistence, files

**AC-16 Naming.** Stems and bounces are named `<song-slug>_<take>_<tag>.wav` where `<tag>` ∈
`stem1 | stem2 | mix`, e.g. `blue-eyes_3_stem1.wav`, `blue-eyes_3_stem2.wav`, `blue-eyes_3_mix.wav`.
`<song-slug>` is the song's existing immutable lowercase-hyphen id. A single-stem take has no
`_stem2` file.

**AC-17 Take records.** Each take stores its audio **and** metadata: per-stem vol/EQ/comp, timestamp,
duration, sample rate, take number, and status (recording|active|discarded). This is a **discrete
schema** stored as a per-song `manifest.json` in OPFS (§5.2), separate from the song record.

**AC-18 UI shows identity.** The deck displays the **song name**, the current **take number**, and the
**OPFS path** where the take's files live (a real virtual path such as `takes/blue-eyes/`).

**AC-19 Song schema reference.** The song's stored record gains a small reference
`tapeDeck: { path: "takes/<slug>/" }`; the take audio and take records are **not** in the song record
and **not** in the song export bundle.

**AC-20 Share/Export.** Any take's stems or bounce can be **Shared/Exported** as real `.wav` files
(share sheet or download) — the only way take audio leaves the app.

**AC-21 Storage management.** Storage is **manual**: kept takes are never auto-deleted. The deck shows
remaining-space info and **warns on low space or write failure**; the app requests persistent storage.
Per-take Delete (AC-22) is how space is reclaimed.

---

## 4. Decision log (for scrutiny)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **OPFS** for take audio (not IndexedDB, not File System Access) | Only OPFS gives a real, displayable virtual **path** on iPad Safari; File System Access API is unsupported on iOS. |
| D2 | Take records in a per-song **`manifest.json` in OPFS** | The user's "discrete data format stored as a file system path"; travels with the audio. |
| D3 | Takes **excluded** from the song export bundle; per-WAV Share instead | WAV is large; base64-inlining 100MB+ into the single-file bundle would make it fragile on iPad. |
| D4 | **Non-destructive** effects (raw stems + saved settings) | Direct requirement: adjust level/EQ/comp *after the fact*. |
| D5 | **Hardware-monitor-only**, no software monitoring | Zero latency, no feedback path; simplest. Effect dials preview on playback. |
| D6 | Record allowed even with **no detected interface** + disclaimer | Matches "navigate + disclaimer"; detection is heuristic so never hard-block. |
| D7 | **LUFS-target (−14) + safety limiter** for bounce mastering | Truest read of "relative loudness tended to"; consistent across takes. |
| D8 | Retake = **keep/discard/cancel last → roll new take → take menu on stop** | User-selected flow; Cancel added in review (an accidental Retake tap must not force a recording). |
| D9 | Naming `<slug>_<take>_stem1|stem2|mix` | User-selected. |
| D10 | Discarded takes shown as **tombstone rows** | User wants the event record preserved. |
| D11 | **16-bit PCM WAV** (processing in float, stored 16-bit); stems at the capture rate, mix at 48 kHz | User-selected; smallest files, CD-grade. |
| D12 | Record UI = **timer + per-stem level meters** | User-selected. |
| D13 | Open deck → **most recent kept take** | User-selected. |
| D14 | Re-bounce **overwrites** single mix | User-selected. |
| D15 | **No click track** | User-selected ("nothing fancy"). |
| D16 | **Manual** storage mgmt + low-space warning | User-selected; takes are precious. |
| D17 | Compressor = native **`DynamicsCompressorNode`**, one-knob mapping; **always in circuit**, detent 0 = neutral params (threshold 0, ratio 1, knee 0 = unity curve) | REVISED in review: the node carries a fixed internal lookahead (~6 ms). Bypass *routing* at detent 0 would time-shift a compressed stem against an uncompressed one in playback AND bounce (inter-mic comb). Always-through keeps both stems at identical latency by construction; the unity curve is verified in Phase 0. |
| D18 | Bounce is a **stereo** WAV (both stems centered) | Universal compatibility; pan-ready. Effectively mono until panning is added. |
| D19 | Capture via **AudioWorklet**, not MediaRecorder | MediaRecorder yields compressed/mono on Safari; worklet gives raw per-channel float PCM. |
| D20 | OPFS writes via **`createSyncAccessHandle` in a dedicated Worker** | Only reliable OPFS write path on iOS Safari; also enables streaming (flat memory). |
| D21 | Worker + worklet scripts loaded via **`fetch(url)` → `Blob` → object URL** | Worklet module fetches **bypass service workers** (spec'd; the classic offline-AudioWorklet trap) and `Worker()` interception is historically patchy — `ASSETS` alone does not make offline recording work. `fetch()` IS SW-intercepted, so the source is served from cache offline. Plain-URL fallback if blob loading fails; both verified in Phase 0. |
| D22 | **Manifest-at-start + periodic header patch + recovery-on-open** | A take enters the manifest (status `"recording"`) before the first audio byte; the worker re-patches WAV sizes every ~1 s; on next deck open a `"recording"` take is finalized as an active "(recovered)" take (or tombstoned if empty). Kills the orphan-file / reused-take-number / invalid-header class of crash bug. User-selected: recover as playable. |
| D23 | **Per-take Delete → tombstone**, any take, any time | AC-21 made storage manual but the only relief valve was discard-last-at-Retake; a full disc was otherwise unrecoverable in-app. User-selected. |
| D24 | Mono (no-interface) capture = **single-stem take** (`stems.stem2 = null`) | Honest about what was captured; half the disc; one strip in the UI; bounce renders the one stem to both channels. User-selected. |
| D25 | Brick-wall limiter is a **designed pure module (`limiter.js`)**, and bounce gain is **clamped** (−12…+20 dB, skip below −50 LUFS) | "Limiter" was previously a name with no design — a builder would reach for a second DynamicsCompressorNode, which overshoots. Pure lookahead limiter is deterministic and unit-testable; the clamp prevents the silence → +∞ dB blow-up. |
| D26 | Playback decodes stems with a pure **`parseWav`**, not `decodeAudioData` | We wrote these files; parsing int16 directly into an AudioBuffer is deterministic, round-trip-testable against the encoder, and removes the platform decoder + its implicit resampling from the story. |
| D27 | Bounce always renders in a **48 kHz `OfflineAudioContext`** | Pins the mix WAV and the BS.1770 K-weighting coefficients to one rate forever (no per-rate coefficient branch). Cross-rate stems are resampled by `AudioBufferSourceNode` as spec'd. |
| D28 | Level meters come **from the capture worklet** (per-batch peaks), not AnalyserNodes | The worklet already touches every sample; meters then show exactly what is written to disc, the mono case needs no special graph, and the splitter + two analysers disappear. |
| D29 | **Screen Wake Lock** held while recording | Device auto-lock mid-take is the first real-session killer. iOS 16.4+/Chrome-old support; released on stop. |
| D30 | **No boot-time OPFS GC; no boot reconcile** | Dir-GC ("delete dirs no song references") was the one destructive automation: an empty/failed `sn_songs` load would wipe every take. Deleting a song still GCs its dir (with confirm); a dangling `tapeDeck` ref self-heals on next deck open (load-or-create). Orphan dirs are rare and inert — acceptable for "takes are precious". |
| D31 | **Android (Chromium) is a full v1 target**; input-device picker added | User-selected. iOS auto-routes the system to the USB interface; Android exposes multiple inputs and often defaults to the built-in mic, so device selection is required for real Android support. Phase 0 + Phase 8 run on both platforms. |
| D32 | Dials use the **capture-only/no-render idiom**; manifest persisted **debounced on change** | `input` events fire dozens/sec; a full re-render mid-drag breaks the drag (same reason lyrics/notes textareas are capture-only), and per-tick manifest writes would hammer OPFS. |
| D33 | Audio flows **worklet → worker over a transferred MessagePort** (main-thread relay is the fallback) | The UI thread should not sit in the audio-durability path; with a direct pipe, main-thread jank cannot back up capture data. The worklet's own node port carries only small meter/clock messages to the UI. Port transfer verified in Phase 0; fallback = relay via main thread. |

---

## 5. Technical design

### 5.1 Module layout (respects the pure-core / impure-shell boundary)

All new files live under `js/tape/` (consistent with existing `js/theory/`, `js/generators/`,
`js/data/` subdirs). **Pure** modules are node-importable (no DOM / storage / AudioContext / Blob /
Worker / `Date` / `crypto`) and are covered by `engine.test.js`. **Impure** modules are browser-only,
never imported by the test, and **must** be listed in `sw.js` `ASSETS`.

**Pure (node-testable):**
- `js/tape/takeModel.js` — take & manifest schema (`validateTake/normalizeTake`,
  `validateManifest/normalizeManifest`); immutable manifest transforms (`appendTake` — used at
  record START with status `"recording"`, `finalizeTake(manifest, takeNo, durationSec)` — stop path,
  `finalizeRecoveredTake(manifest, takeNo, dataBytes, rate)` — recovery path (computes duration
  `dataBytes / (2 * rate)`, sets `status:"active", recovered:true`; tombstones instead when
  `dataBytes === 0`), `discardTake(manifest, takeNo)` — Retake-discard AND per-take Delete (nulls
  stem/bounce file fields, sets `status:"discarded"`), `markBounced`, `setStemSettings`);
  `makeTake(fields, now)`; **monotonic** `nextTakeNumber(manifest)` (scans *all* takes: active,
  discarded, AND `"recording"`); `mostRecentKeptTake(manifest)`; naming helpers
  `stemFileName(slug, take, stemKey)`, `mixFileName(slug, take)`; `tapeDeckRef(slug)`;
  effect-settings model `defaultStemSettings()` / `clampStemSettings(s)`; DSP mapping constants +
  math `EQ_BANDS`, `EQ_GAIN_DB`, `compressorParams(c)` (must return the neutral
  `{threshold:0, ratio:1, knee:0}` shape at `c=0`, D17); `LUFS_TARGET = -14`,
  `LUFS_FLOOR = -50`, `BOUNCE_GAIN_DB_MIN = -12`, `BOUNCE_GAIN_DB_MAX = 20`,
  `LIMITER_CEILING_DB = -1`; `STEM_KEYS`, `TAKE_STATUS = ['recording','active','discarded']`.
- `js/tape/wav.js` — pure WAV codec: `wavHeader(channels, rate, dataBytes)` (44-byte RIFF/PCM16),
  `floatToInt16(Float32Array)`, `interleave(chArrays)`, **`parseWav(uint8)`** →
  `{ channels, rate, samples: Float32Array[] }` (PCM16 RIFF only — it parses files this app wrote;
  reject anything else with a clear error), and the **header size-field constants** the worker
  patches with: `SIZE_FIELDS = [{offset:4, bias:36}, {offset:40, bias:0}]` (uint32 LE =
  `dataBytes + bias`). Encoder↔parser round-trip is unit-tested.
- `js/tape/lufs.js` — pure BS.1770 K-weighting (two cascaded biquads, **48 kHz coefficients only** —
  bounce always renders at 48 kHz, D27) + 400 ms / 75 %-overlap gated integrated loudness over
  Float32 channel arrays. Returns `-Infinity` for silence (callers clamp per D25).
- `js/tape/limiter.js` — pure brick-wall lookahead limiter over Float32 channel arrays, in place:
  5 ms lookahead (gain applied to the delayed signal is the minimum required over the lookahead
  window so no sample exceeds the ceiling), ~1 ms attack smoothing on gain reduction, ~50 ms
  release, ceiling −1 dBFS, followed by a hard clamp at the ceiling (true brick wall even under
  smoothing error). Unit-testable: a +3 dBFS sine comes out with peak ≤ −1 dBFS; material already
  under the ceiling passes bit-identical.

**Impure (browser-only, cached in `sw.js`):**
- `js/tape/audioEngine.js` — `AudioContext` lifecycle; capture graph; playback graph with live
  effects; 48 kHz `OfflineAudioContext` bounce render; wake-lock handling. Public:
  `makeTapeDeck({...}) → { probe, record, stop, play, replay, stopPlay, bounce, applySettings,
  dispose }`. Owns loading the worklet + worker via the D21 fetch→Blob rule.
- `js/tape/takeStore.js` — OPFS facade over the worker: `readManifest`/`writeManifest`,
  `openTakeFiles`/`finalizeTakeFiles` (streamed stem writes), `finalizeExisting` (recovery header
  patch, returns data-byte count), `writeFile` (mix/manifest, truncating), `readFile`,
  `deleteTakeAudio(slug, take)`, `deleteSongTakes(slug)`, `estimateSpace()`
  (wraps `navigator.storage.estimate()`; returns `null` when unavailable → caller suppresses the
  warning), `onWriteError(cb)`. Feature-detects `navigator.storage.getDirectory` +
  `createSyncAccessHandle` support; when absent the deck shows the unsupported-browser note and
  Record is disabled (no fallback store, §2).
- `js/tape/opfsWorker.js` — **self-contained classic Worker, zero imports** (loadable from a Blob
  URL with no module-resolution concerns): owns every `createSyncAccessHandle`; streamed stem
  appends with **periodic size-field patch + `flush()` every ~1 s**; finalize (patch + close);
  one-shot truncating writes; reads; deletes; file-size queries. It contains **no WAV knowledge**:
  the main thread sends the prebuilt 44-byte header and the `SIZE_FIELDS` offsets/biases from
  `wav.js` (§5.3 protocol).
- `js/tape/captureProcessor.js` — `AudioWorkletProcessor`, dependency-free: batches input into
  ~8192-frame per-channel chunks, converts float→int16 **in the worklet** (same clamp formula as
  `wav.js floatToInt16` — duplicated by necessity, keep the two in sync by comment), posts audio
  chunks to the **transferred worker port** (D33) and small `{frames, peaks:[…]}` meter/clock
  messages to its node port at ~10 Hz.
- `js/tape/devices.js` — post-grant `enumerateDevices`/`getSettings`/`getCapabilities` heuristics →
  `{ channels, label, isLikelyInterface, warnMoreThanTwo, inputs:[{deviceId,label}] }`; input
  preference order (last-used → USB-label heuristic → default); persists last-used deviceId to
  `localStorage['sn_tape_input']`.
- `js/tape/tapeView.js` — the deck UI (built with `dom.js`'s `h()`), mounted like `sketchesView.js`,
  with the persistent `makeTapeDeck` controller kept **outside** the rebuilt DOM subtree, and a
  small **imperative live layer** (timer text + meter bars mutated directly from engine callbacks,
  never via `render()`).

Styling: extend the existing `styles.css` (stem strips, dials, meters, tombstone rows, banners) —
no new CSS file, no framework; `styles.css` is already in `ASSETS` so the Phase-7 cache bump ships it.

### 5.2 Data model

**Song record (localStorage `sn_songs`)** gains one optional field:
```json
{ "...": "...", "tapeDeck": { "path": "takes/blue-eyes/" } }
```
Pinned to the **immutable `id`**, not the display name (rename keeps `id` stable — `songs.js`
`renameSong`, asserted by `engine.test.js`), so the OPFS folder never needs to move on rename.

**Per-song manifest (OPFS `takes/<slug>/manifest.json`)** — its own schema, `schemaVersion:1`:
```json
{
  "schemaVersion": 1,
  "slug": "blue-eyes",
  "takes": [ /* Take records */ ]
}
```
**Take record:**
```json
{
  "take": 3,                       // monotonic; never reused; tombstones retain their number
  "status": "active",              // "recording" | "active" | "discarded"
  "recovered": false,              // true when finalized by crash recovery (AC-23)
  "createdAt": "2026-07-11T18:04:00.000Z",
  "durationSec": 74.2,             // null while status is "recording"
  "sampleRate": 48000,             // the capture context rate
  "channels": 2,                   // captured channels: 2 = two stems, 1 = single-stem take
  "capturedWithoutInterface": false,
  "stems": {
    "stem1": { "file": "blue-eyes_3_stem1.wav", "vol": 1.0,
               "eq": { "bass": 0, "mid": 0, "treble": 0 }, "comp": 0 },
    "stem2": { "file": "blue-eyes_3_stem2.wav", "vol": 1.0,
               "eq": { "bass": 0, "mid": 0, "treble": 0 }, "comp": 0 }
  },
  "bounce": { "file": "blue-eyes_3_mix.wav", "bouncedAt": "…", "lufs": -14.0 }  // null until bounced
}
```
- A **single-stem take** (`channels: 1`, D24) has `stems.stem2 = null` and no `_stem2` file.
- A **tombstone** (discarded/deleted) keeps `take`/`status:"discarded"`/`createdAt`/`durationSec`
  and sets `stems`/`bounce` file fields to null (audio deleted).
- A **`"recording"`** take exists in the manifest from record start (D22) with
  `durationSec: null`; a clean stop finalizes it to `active` + duration; crash recovery (§5.3)
  finalizes it on next deck open.
- Effect-setting ranges (clamped in `clampStemSettings`): `vol` 0–1.5 (default 1.0), each `eq`
  band −12…+12 dB (default 0 = flat), `comp` 0–1 (default 0 = neutral curve, D17).

**Last-used input** (`localStorage['sn_tape_input']`): the bare deviceId string; advisory only
(deviceIds are origin-stable after a grant on Chromium; if stale, the preference falls through to
the heuristic).

### 5.3 OPFS storage & the worker write path

- Root: `navigator.storage.getDirectory()`. Layout: `takes/<slug>/manifest.json`,
  `takes/<slug>/<slug>_<take>_stem1.wav`, `_stem2.wav`, `_mix.wav`.
- **Reliable write path = `createSyncAccessHandle()` inside a dedicated Worker** (Safari does not
  support main-thread `createWritable` reliably; sync access handles are worker-only). The main
  thread does control/DSP; `js/tape/opfsWorker.js` does all file I/O. A useful side effect: a sync
  access handle **locks the file**, so a second tab that tries to record the same take fails loudly
  instead of interleaving writes (accepted multi-tab posture; manifest writes stay last-write-wins).
- **Script loading (D21):** `takeStore` and `audioEngine` load the worker and the worklet by
  fetching their source (`fetch('./js/tape/opfsWorker.js')` etc. — SW-cache-served offline),
  wrapping it in a `Blob`, and passing an object URL to `new Worker(...)` /
  `audioWorklet.addModule(...)`. If blob loading throws, fall back to the plain URL (fine online)
  and surface a "recording may not work offline" note. Both paths are Phase-0-verified per platform.
  The raw files stay in `ASSETS` — that is what makes the `fetch()` work offline.
- **Streaming stems, crash-consistent (D22):**
  1. `onRecordTake` first **appends the take to the manifest with `status:"recording"`** and writes
     the manifest, then opens the stem files.
  2. `openTake` gives the worker the prebuilt 44-byte header (placeholder sizes) per stem and the
     `SIZE_FIELDS` patch spec from `wav.js`.
  3. Audio arrives at the worker directly from the worklet (D33) as int16 chunks; the worker
     appends at the write cursor. **Every ~1 s** it re-patches both size fields from its running
     byte count and `flush()`es — so at any instant the on-disc file is a valid WAV missing at most
     the last second.
  4. Clean stop → `finalizeTake`: final patch + flush + close, reply with per-stem data bytes; main
     thread finalizes the manifest record (status `active`, duration).
  5. Peak RAM is a few in-flight chunks, never the take.
- **Crash recovery (on deck open, before AC-11 loads a take):** for each manifest take with
  `status:"recording"`: ask the worker to `finalizeExisting` each stem file (measure size, patch
  size fields, close) → data bytes; apply `finalizeRecoveredTake` (active + `recovered:true` +
  computed duration, or tombstone when empty/missing); write the manifest. Recovery is idempotent
  and runs before `mostRecentKeptTake`.
- **Manifest writes** are one-shot truncating `writeFile` ops through the worker (re-bounce and
  setting rewrites must not leave trailing bytes).
- `estimateSpace()` wraps `navigator.storage.estimate()` (may be absent → `null` → no warning);
  `ensurePersist()` (reuse `main.js:38`) is called before the first write.
- **No boot reconcile, no dir GC (D30).** A dangling `tapeDeck` ref self-heals: `onOpenTapeDeck`
  load-or-creates the manifest at that path. Deleting a song deletes its dir (§5.7). Orphan dirs
  (possible only via a failed delete-GC) are accepted residue.
- Write errors reject to the UI; a mid-record write error triggers the stop-clean path with a
  "Recording stopped (storage error)" status (matching `audioStore.js`'s reject-on-failure posture).

**Worker message protocol** (all requests carry a correlation `id`; replies echo it; `bytes` are
transferred, never copied):

| op | payload | reply |
|---|---|---|
| `openTake` | `dir`, `files:{stem1, stem2?}`, `header:ArrayBuffer`, `sizeFields:[{offset,bias}]` | `{ok}` |
| `append` *(fire-and-forget, from worklet port)* | `stem:1|2`, `bytes:ArrayBuffer` | — (async `{type:'writeError'}` push on failure) |
| `finalizeTake` | — | `{ok, dataBytes:{stem1, stem2?}}` |
| `finalizeExisting` | `path`, `sizeFields` | `{ok, dataBytes}` (0 when missing/empty) |
| `writeFile` | `path`, `bytes` | `{ok}` |
| `readFile` | `path` | `{ok, bytes}` |
| `deleteFiles` | `paths:[…]` (best-effort, missing ok) | `{ok}` |
| `deleteDir` | `dir` | `{ok}` |

### 5.4 Audio engine

**Capture graph** (recording; no monitoring path):
```
getUserMedia({ audio: { deviceId: <picked, when a picker is shown>,
                        echoCancellation:false, noiseSuppression:false, autoGainControl:false,
                        channelCount:2 } })
  → MediaStreamAudioSourceNode
      → AudioWorkletNode(captureProcessor,
            channelCount: <probed 1|2>, channelCountMode:'explicit', channelInterpretation:'discrete')
            → [transferred MessagePort] → opfsWorker (int16 chunk appends)      // audio path, D33
            → node.port → main thread ~10 Hz {frames, peaks}                     // meters + timer
      → silent GainNode(gain:0) → destination        // guarantees the worklet is pulled; verify need on-device
```
- All of `echoCancellation/noiseSuppression/autoGainControl` **must be false** — any of them on makes
  iOS Safari collapse the track to **mono** (and Android routes it through processed paths).
  `channelCount:2` is an ideal constraint (never over-constrains a mono device).
- After the grant, read `getSettings().channelCount`; **pin the worklet node to exactly that count**
  with `channelCountMode:'explicit'` + `channelInterpretation:'discrete'` (the default `'max'` mode
  would silently follow route changes). 1 channel → single-stem take (D24). A device/route change
  mid-record → stop-clean.
- Port plumbing: `audioEngine` creates a `MessageChannel`, transfers one port to the worklet
  (`node.port.postMessage({port}, [port])`) and the other to the worker. Fallback (Phase 0): if
  port transfer into the worklet fails, the worklet posts audio chunks on its node port and the
  main thread relays them to the worker (functionally identical, jank-sensitive).
- The elapsed timer derives from the worklet's cumulative frame count (`frames / sampleRate`) —
  tape time, immune to UI-thread scheduling; meters render the posted per-batch peaks.
- Wake lock (D29): `navigator.wakeLock.request('screen')` on record start, release on stop; if the
  API is missing, show the one-line auto-lock hint (AC-24).

**Playback graph** (live, non-destructive; effect nodes persist, sources are per-play):
```
per stem:  AudioBufferSource → Gain(vol) → Biquad lowshelf(bass) → Biquad peaking(mid)
                             → Biquad highshelf(treble) → DynamicsCompressor(compressorParams(c))
                             → Gain(makeup)
all stems → sum → destination
```
- Stems load via `takeStore.readFile` → `wav.js parseWav` → `AudioBuffer` (D26). No `decodeAudioData`.
- Knob turns call `param.setTargetAtTime(v, ctx.currentTime, 0.01)` (click-free) — never rebuild the
  graph. Buffer sources are one-shot: fresh per play, effect nodes persistent. All stems
  `start(ctx.currentTime + 0.1)` together so they stay sample-locked.
- **The compressor is always in circuit (D17).** `compressorParams(0)` = `{threshold:0, ratio:1,
  knee:0}` (unity gain curve, identical fixed latency on every stem). A single-stem take builds one
  strip's chain. Playback master is deliberately un-limited — if the dials sum over full scale, you
  hear it (only bounce is protected).

**Bounce** (always a 48 kHz `OfflineAudioContext`, D27; same topology + mapping as playback so they
cannot diverge):
```
OfflineAudioContext(2, ceil((durationSec + 0.05) * 48000), 48000)   // +50 ms pad for comp latency tail
  render summed effected mix (mono take: its one chain, upmixed center)
→ measure integrated LUFS (lufs.js, 48 kHz coefficients)
→ gainDb = clamp(LUFS_TARGET − measured, −12, +20); skip (0 dB) when measured < LUFS_FLOOR (−50) or −∞
→ apply gain → limiter.js (ceiling −1 dBFS, 5 ms lookahead)
→ wav.js interleave + floatToInt16 → 16-bit stereo encode
→ takeStore.writeFile(<slug>_<take>_mix.wav)   (truncating overwrite, AC-15)
```
The transport shows "Bouncing…" and disables itself for the duration (AC-13); errors surface in
`deckStatus`. The ≤6 ms of compressor pre-delay lead-in is common to both stems and inaudible;
it is not trimmed.

**3-band EQ** (constants in `takeModel.js`): `lowshelf @100 Hz`, `peaking @1 kHz Q≈0.9`,
`highshelf @3.5 kHz`; each ±12 dB, detent 0 = flat (unity).

**One-knob compressor** `c∈[0,1]` → `compressorParams(c)`: `c=0` ⇒ neutral
`{threshold:0, ratio:1, knee:0}` (D17); for `c>0`: `threshold −6 − 30c` dB, `ratio 1.5 + 6.5c`,
`knee 30 − 24c`, `attack 0.020 − 0.017c` s, `release 0.400 − 0.250c` s; makeup on the separate
`Gain` ≈ `0.5·(−threshold)·(1 − 1/ratio)` dB (0 dB at c=0; pragmatic, tune by ear — final loudness
is fixed by the LUFS bounce).

**WAV codec** (`wav.js`): RIFF/PCM 16-bit; stems mono at the capture context rate, mix stereo at
48 kHz. Float→int16: `s=clamp(-1,1,x); s<0 ? round(s*0x8000) : round(s*0x7FFF)`. Stems are encoded
incrementally (header from main, int16 chunks from the worklet, sizes patched by the worker);
the bounce is encoded on the main thread from the offline buffer.

### 5.5 Devices, permissions & the probe (`devices.js`)

Run on entering the deck, inside the tap's gesture (labels/settings are empty before a grant):
1. `getUserMedia` (constraints as §5.4, no deviceId yet) → on **denial**, set the AC-26 blocked
   state (Record disabled) and stop. On success:
2. Read `track.getSettings().channelCount` → `channels`. If `!== 2` → the **no-interface
   disclaimer** (AC-4) and single-stem arming — this is the reliable signal.
3. `getCapabilities().channelCount?.max > 2` → the **">2 inputs" warning** (AC-3). `getCapabilities`
   may be absent (iOS Safari) → warning is best-effort; accepted limitation, noted in-app.
4. `enumerateDevices()` → `audioinput` list. **>1 device → show the Input selector** (AC-25),
   preselect last-used (`sn_tape_input`) → else first USB-ish label ("EVO"/"Audient"/"USB"/
   "Interface"…) → else default. Exactly 1 device (typical iOS: the system route) → no selector.
5. **Stop the probe tracks** — no live mic indicator while the user just looks at the deck.
6. **Record re-acquires fresh** (with the picked `deviceId` when a picker is shown) and re-reads
   `channelCount` — the interface may have been (un)plugged since the probe; arm 1-or-2 stems from
   the fresh reading. Changing the picker selection re-probes that device.

Label matching only *strengthens* disclaimer copy; never a hard gate. On Android, a stereo built-in
mic pair that reports 2 discrete channels simply records as two stems — the disclaimer keys off
channel count, not marketing truth.

### 5.6 UI & navigation integration

- **Navigation:** add a per-song **sub-view flag** `songSubView: 'sections' | 'tapedeck'` (in `main.js`
  state + `songViewModel()`), **not** a new top-level `currentView` — the deck lives inside a song like
  the sketches master-detail, and must not appear in the top tab strip.
- **Button:** in `songsView.js`, add a `🎛 Tape Deck` button near the action row; `disabled` for
  drafts. Its handler calls `onOpenTapeDeck()`. The deck view renders a "‹ Back to song" control
  (`onCloseTapeDeck`).
- **Persistent controller:** create the `makeTapeDeck` controller **once** per mount, in its own
  container kept outside the subtree `songsView.update()` wipes (same discipline as
  `makeSketchPlayer`'s `<audio>`), so the `AudioContext`/graph survive re-renders. One controller,
  one `AudioContext`, re-targeted as songs/takes change.
- **Transport state machine:** deck with **no kept take** (empty or all-tombstone manifest) shows
  **Record**; a loaded take shows **Play / Stop / Replay + Retake + Bounce** (recording again goes
  through Retake, AC-7). While `status === 'recording'`: Stop only, Back inert, top tabs inert
  (AC-27; `main.js onTab` guards on the recording flag). While bouncing: transport disabled with
  "Bouncing…" (AC-13).
- **Dial discipline (D32):** vol/EQ/comp inputs are **capture-only on `input`** — update the audio
  params (`applySettings`) + in-memory settings, **no `render()`** (the lyrics/notes idiom;
  a mid-drag rebuild breaks the drag on iPad). On `change` (pointer-up), persist to the manifest
  **debounced ~300 ms** and render.
- **Live layer:** the timer text and meter bars are DOM nodes the engine mutates directly from the
  ~10 Hz worklet messages (rAF-aligned) — never through `render()`.
- **Deck view contents:** header (song name, current take #, OPFS path — AC-18), disclaimer banner /
  blocked-mic state / unsupported-browser note (as applicable), Input selector (AC-25, when >1
  device), transport, the stem strips (one per captured channel: vol slider, 3 EQ dials, comp dial)
  + timer + meters during record, the take menu (on stop-after-retake: newest preselected, dismiss
  = newest, tombstones inert — AC-8), take-history list (active rows: timestamp, length,
  "(recovered)" marker when set, **Load / Share / Delete-with-inline-confirm**; tombstone rows
  inert — AC-10/22), Share/Export controls for the loaded take's stems + bounce (AC-20), low-space
  warning, and the one-line eviction honesty note ("Takes live on this device — Share/Export any
  take you can't lose").
- Deleting the loaded take stops playback first, then loads `mostRecentKeptTake` (or the empty
  record state). Delete/discard ordering matches the sketches discipline: manifest first (drop the
  reference), file deletion second, best-effort.

### 5.7 App integration points (exact edits)

- **`js/tape/*`** — ten new files per §5.1.
- **`js/main.js`**
  - Import `* as takeModel from './tape/takeModel.js'` (pure) and `* as takeStore from
    './tape/takeStore.js'` (impure).
  - New state: `songSubView`, `currentTake`, `deckManifest`, `deckStatus`, `spaceWarning`,
    `deckInputs`; add them to `songViewModel()`.
  - New `handlers.songs` methods: `onOpenTapeDeck` (guards `!a.id`; `ensurePersist()`;
    load-or-create manifest; **run crash recovery** (§5.3); `mostRecentKeptTake`; stamp
    `song.tapeDeck` via `updateActive` on first open), `onCloseTapeDeck` (guarded while recording),
    `onRecordTake`, `onStopTake`, `onKeepTake`, `onDiscardLastTake`, `onCancelRetake`,
    `onDeleteTake` (AC-22), `onSelectTake`, `onSelectInput` (AC-25), `onSetStemSetting`,
    `onBounceTake`, `onShareTake`. Manifest edits persist to OPFS via `takeStore.writeManifest`
    (not `updateActive`); only the tiny `tapeDeck` ref goes through `updateActive`. Deck handlers
    call `render()` (not `commit()`), except the dial `input` path which does not render at all (D32).
  - **`onDeleteSong`**: after the existing sketch-blob GC, `takeStore.deleteSongTakes(gone.id)`
    behind an inline "also delete N takes?" line in the existing delete-confirm strip.
  - **`importOneSong`**: **strip** any `tapeDeck` field post-normalize (bundle carries no take audio,
    and a slug may be re-slugged on import) — reopening the deck recreates the manifest.
  - **No `reconcileTakes`** (D30) — nothing new on the boot line.
  - **Refactor:** extract `shareOrDownloadBlob(blob, name, mimeType)` from the existing
    `writeJsonSink` share/download tiers (`main.js:281-303`) and reuse it for `onShareTake`
    (`audio/wav`) and JSON export (behavior unchanged).
- **`js/songs.js`** (pure) — whitelist `tapeDeck` or it is silently stripped by `normalizeSong`:
  - `validateSong`: optional-object check with a non-empty `tapeDeck.path` string.
  - `normalizeSong`: spread `{ tapeDeck: { path: str(s.tapeDeck.path) } }` only when present
    (absent key when no deck).
  - **`schemaVersion` stays 1** (purely additive, exactly like `sketches` was added).
- **`songs/song.schema.json`** — document the new optional `tapeDeck` property (documentation only;
  not fetched).
- **`sw.js`** — add ALL ten new files to `ASSETS` (pure and impure: `takeModel.js`, `wav.js`,
  `lufs.js`, `limiter.js`, `audioEngine.js`, `takeStore.js`, `opfsWorker.js`,
  `captureProcessor.js`, `devices.js`, `tapeView.js`); bump `CACHE` `"sn-v16" → "sn-v17"`.
  The worker and worklet sources are loaded via `fetch()` (D21) — the `ASSETS` listing is what
  makes that fetch resolvable offline; without it, recording breaks **only offline** — still the
  worst-bug class, now actually mitigated.
- **`engine.test.js`** — new "Tape deck (pure)" section covering `takeModel` (monotonic
  `nextTakeNumber` across active + tombstones + `"recording"`, naming helpers, `tapeDeckRef`,
  `makeTake`, `clampStemSettings`, transforms incl. `finalizeTake`/`finalizeRecoveredTake`
  (recovered + empty→tombstone) /`discardTake`-on-any-take, `mostRecentKeptTake`,
  `compressorParams(0)` neutrality, the LUFS/bounce constants), `wav.js` (header bytes,
  float→int16 clamp, interleave, `SIZE_FIELDS`, **encode↔`parseWav` round-trip**), `lufs.js`
  (a synthesized −14 LUFS tone ≈ −14; silence → −∞), the bounce gain rule (clamp bounds; skip below
  floor), and `limiter.js` (+3 dB sine → ≤ −1 dBFS; under-ceiling passthrough bit-identical).
  Extend the existing sw-asset loop (`engine.test.js:189-193` pattern) with a `tape/…` file loop.
  Add `validateSong`/`normalizeSong` `tapeDeck` assertions (accept good ref, reject bad `path`,
  preserve on normalize, omit when absent). The suite currently reports **282 passing checks**;
  it grows from there.

### 5.8 Lifecycle & edge cases

- **Draft has no slug** → deck button disabled; `onOpenTapeDeck` guards `!a.id`. Prevents `takes//`.
- **Rename keeps `id`** → OPFS path (pinned to `id`) never moves. No rename-dir code exists.
- **Delete song** → GC its OPFS `takes/<slug>/` immediately (with the inline confirm). No boot GC (D30).
- **Import** → strip `tapeDeck` (audio absent on this device; possible re-slug). Deck self-heals.
- **Interrupted recording** (screen lock / call / background / route change) → on `ctx`
  `suspended`/`interrupted`/`visibilitychange`-hidden, **stop cleanly** (finalize headers +
  manifest) and show "Recording stopped (interrupted)"; do not resume mid-take. Wake lock (AC-24)
  prevents the self-inflicted case.
- **Crash / tab kill mid-record** → the `"recording"` manifest entry + ~1 s header patching (D22)
  make the take recoverable; next deck open finalizes it as "(recovered)" (AC-23).
- **Mic permission denied** → AC-26 blocked state; no throw.
- **Navigation mid-record** → inert (AC-27); song delete is unreachable while recording (the deck
  replaces the song view and Back is inert).
- **Storage write error mid-record** → worker pushes `writeError` → stop-clean + "storage error"
  status; the take keeps everything written before the failure.
- **Re-bounce** → `mixFileName` has no instance suffix; `writeFile` truncates (overwrite, AC-15).
- **Low space** → `estimateSpace()` on deck open + before each record; **warn when free < 500 MB**
  (~20 min of 2-stem 48 kHz recording headroom); suppress when the API is unavailable. Reclaim via
  per-take Delete (AC-22).
- **Two tabs on one deck** → the second recorder's sync-handle open fails loudly (file lock);
  manifest writes are last-write-wins. Accepted limitation, noted here, not defended in code.
- **Playback clipping** → the live sum is un-limited by design (D17 note); only bounce is protected.
- **OPFS eviction** → `persist()` is best-effort; Share/Export is the durable backstop; the deck
  carries the one-line honesty note (§5.6).

---

## 6. Platform gotchas (design already accounts for)

**iOS Safari (primary):**
1. Create/resume `AudioContext` **inside the user gesture** (Record/Play tap); `await ctx.resume()`.
2. **Do not hard-code the capture rate** — `new AudioContext()` then read `ctx.sampleRate`; stems
   use it (WAV header). The bounce is always 48 kHz (D27) regardless.
3. `getUserMedia` prompts under a gesture; device labels/settings are empty until granted → probe
   after grant (§5.5), stop probe tracks after reading.
4. Background/lock/interruption suspends the context → stop-clean handler (§5.8); streaming +
   periodic patch keep the partial file valid.
5. Long-recording memory ceiling → per-batch streaming to OPFS; RAM stays flat at any length.
6. **Worklet module fetches bypass the service worker** → the D21 fetch→Blob loading rule. The
   `ASSETS` listing feeds the `fetch()`, not `addModule` directly.
7. An AudioWorkletNode with no destination path may not be pulled → silent `Gain(0)→destination`
   sink (verify need in Phase 0).
8. Sync access handles are worker-only; keep every OPFS byte behind the worker protocol (§5.3).

**Android Chrome (full v1 target, D31):**
1. **Input routing is not automatic** — multiple `audioinput` devices are exposed and the default
   is frequently the built-in mic even with a USB interface attached → the AC-25 picker +
   `deviceId` constraint is required equipment, not polish.
2. **Stereo capture variance** — some device/OS combinations force mono or processed capture paths;
   processing-off + explicit `channelCount` generally yields 2 discrete channels on modern Chrome
   with a USB-C class-compliant interface, but this is exactly what the Phase-0 spike must confirm
   on the real phone/tablet.
3. Wake Lock, OPFS sync handles, share-with-files, `storage.estimate` — all long-supported on
   Chromium; no special handling expected.
4. A stereo built-in mic pair legitimately reports 2 channels → records as two stems; the
   no-interface disclaimer keys off channel count and the label heuristic only softens copy.

---

## 7. Risks / must-verify on real hardware (the Phase-0 spike gates everything)

**Top risks — measure on BOTH platforms before building the engine:**
- **`ctx.sampleRate` + `getSettings().channelCount === 2` with processing off, and channel mapping**
  (is input 1 always Left?) on the actual interface — iPad + Audient EVO, and the Android device +
  the same interface. Verify with a known signal in each input.
- **`createSyncAccessHandle` in a Worker + positioned size-field patch writes** on current iOS
  Safari (Android Chrome is established).
- **Blob-URL loading**: `new Worker(blobURL)` and `audioWorklet.addModule(blobURL)` on both
  platforms, **offline** (airplane mode, installed PWA) — the D21 linchpin. Fallbacks if a platform
  rejects blob `addModule`: data: URL, else plain URL + accept online-only worklet load (would
  demote offline recording — treat as a blocker to solve, not accept).
- **MessagePort transfer into the worklet** (D33) on both platforms; fallback = main-thread relay.
- **`DynamicsCompressorNode` neutrality at `compressorParams(0)`** — offline-render a test signal
  through the neutral compressor: assert unity gain curve and measure the fixed latency (expected
  ~6 ms / 256 frames). This validates D17's alignment guarantee.
- **AudioWorklet pulled without a destination connection** (whether the silent sink is required).

**Lower-severity / accepted limitations:**
- `getCapabilities().channelCount` may be absent on iOS → the ">2 inputs" warning may not fire
  (AC-3 best-effort).
- OPFS is **evictable** (storage pressure / long idle); `persist()` is best-effort → Share/Export is
  the durable backstop; stated in-app.
- `DynamicsCompressorNode` realtime vs offline timing may differ subtly → a bounce can sound
  marginally different from live monitoring (one gentle knob; low severity). The mastering chain
  itself (LUFS + limiter) is pure JS and deterministic (D25).
- Makeup-gain formula is a pragmatic approximation; the limiter is sample-peak, not oversampled
  true-peak.
- No dither on 16-bit conversion (v1).

---

## 8. Phased implementation plan

**Phase 0 — On-device capability spike (gate; do first, BOTH devices).** A throwaway page run on
the iPad + Audient AND the Android device + the same interface: opens stereo `getUserMedia`
(processing off, picked deviceId on Android), logs `ctx.sampleRate` + `getSettings().channelCount`
+ channel mapping; records a few seconds via an AudioWorklet **loaded from a blob URL**, pipes
int16 chunks over a **transferred MessagePort** to a **blob-URL Worker** writing WAV via
`createSyncAccessHandle` with periodic size patching; reads the file back and plays it; renders a
signal through `compressorParams(0)` offline and asserts unity + measures latency; repeats the
record test **offline** (airplane mode, installed). Confirms every top risk in §7. **Do not build
the engine until this passes on both platforms.**

**Phase 1 — Pure core + tests.** `takeModel.js`, `wav.js` (incl. `parseWav` round-trip), `lufs.js`,
`limiter.js`; extend `engine.test.js` per §5.7; `node engine.test.js` green. No UI.

**Phase 2 — OPFS layer.** `takeStore.js` + `opfsWorker.js`: the §5.3 protocol — manifest read/write,
streamed stem writes with periodic patch, `finalizeExisting` recovery, reads, deletes, blob-URL
loading, `estimateSpace`, write-error push. No fallback store.

**Phase 3 — Capture + detection.** `captureProcessor.js`, `devices.js` (probe, picker, permission
states), and the record path of `audioEngine.js`: two raw stem WAVs to OPFS (one for mono) with
worklet-driven timer + meters, wake lock, stop-clean paths, manifest-at-start.

**Phase 4 — Playback + live effects.** Playback graph in `audioEngine.js`: `parseWav` loading,
vol/EQ/comp applied live (always-through comp), sample-locked stems, single-stem variant.

**Phase 5 — Bounce.** 48 kHz `OfflineAudioContext` render → LUFS measure → clamped normalize →
`limiter.js` → encode → overwrite `_mix.wav`. Busy state, silence rule.

**Phase 6 — Deck UI.** `tapeView.js`: transport state machine (record→stop→play/replay/retake/
bounce; nav lock while recording), retake keep/discard/cancel, take menu defaults, take-history
with tombstones + recovered markers + per-take Load/Share/Delete, dial discipline (capture-only
input, debounced persist), imperative timer/meter layer, disclaimer/blocked/unsupported banners,
input picker, >2-input + low-space warnings, path display, Share/Export, `styles.css` additions.

**Phase 7 — App wiring.** `main.js` state/handlers/import+delete edits + `shareOrDownloadBlob`
extraction; `songsView.js` button + sub-view routing; `songs.js` schema whitelist;
`song.schema.json` doc; `sw.js` ASSETS + `CACHE` bump (`sn-v17`); update the `songwriter-pwa`
skill's audio-scope non-negotiable.

**Phase 8 — Verify + deploy.** `node engine.test.js` green; on-device AC walkthrough on **both**
the iPad and the Android device (§9); deploy to Pages; reinstall on both and confirm **offline**
recording end-to-end.

---

## 9. Verification

**Automated (must pass before deploy):**
- `node engine.test.js` — the existing suite (currently 282 passing checks) + the new
  tape-deck/wav/lufs/limiter/schema/sw-asset assertions, all green.

**Manual on-device (installed PWA; run the full list on iPad + Audient, then the recording-path
subset on the Android device; airplane-mode pass on both):** walk every AC — open deck (AC-1),
record 2 mics (AC-2), >2-input message where capabilities report it (AC-3), disclaimer + single-stem
take with no interface (AC-4), per-channel strips + transport + meters (AC-5/6), wake lock holds
through a long take (AC-24), nav inert while rolling (AC-27), retake keep/discard/cancel + take
menu defaults (AC-7/8), monotonic numbering across a discard (AC-9), take history + tombstone +
recovered marker (AC-10/23 — force-kill the app mid-take to test recovery), per-take delete frees
space (AC-22), open-loads-most-recent (AC-11), tweak EQ/comp mid-drag without a re-render hiccup
and hear it on playback (AC-12), bounce + busy state + verify a single `_mix.wav` beside the stems
(AC-13), compare bounce loudness across two takes + confirm a near-silent take is not boosted
(AC-14), re-bounce overwrites (AC-15), filenames incl. single-stem case (AC-16), path shown
(AC-18), Share a WAV to Files (AC-20), low-space warning (AC-21), input picker preselects the
interface on Android (AC-25), denied-mic state (AC-26). Confirm recording works **offline** after
install on both platforms.

**Deploy recipe (per the songwriter-pwa skill):** bump `CACHE` (done in Phase 7), ensure every new
file is in `ASSETS`, `node engine.test.js`, commit, push `main`; Pages serves root; reinstall/
hard-refresh on the devices to pull `sn-v17`.

---

## 10. Open questions / future extensions (not v1)

- Per-stem **panning** (bounce becomes genuinely stereo) — the most obvious next step (D18).
- Streaming playback for very long takes (avoid loading whole stems into RAM at play time).
- TPDF **dither** on 16-bit conversion.
- Oversampled **true-peak** limiting.
- Optional **auto-prune** retention cap (currently manual, D16/AC-22).
- A storage view listing per-song take disc usage (the manual-management quality-of-life follow-up).
