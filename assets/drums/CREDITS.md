# Drum machine — sample & impulse credits

The drum machine ships bundled one-shot samples (per kit) and convolution impulse responses
(for the effects pulldown). All samples are processed to mono, 16-bit, 44.1 kHz, trimmed of
leading silence, and peak-normalized to -3 dB (the machine responds to per-step MIDI velocity,
so one full-velocity one-shot per voice is stored and scaled down at play time). Cymbal/tom
tails are trimmed. Each kit's 12 voices are kick / snare / closed+open hi-hat / low+mid+high tom
/ crash / ride / clap / hi conga / lo conga.

## Kits (`assets/drums/kits/<kit>/<voice>.wav`)

| UI name | Source | Notes |
|---|---|---|
| **Kit 4** | **Muldjord Kit** (Freepats, CC-BY 4.0) + **World Percussion** (Freepats, CC0) for clap/congas | general acoustic |
| **Jazz Funk Kit** | **Orange Tree Samples** free Jazz-Funk drum library (royalty-free) | acoustic jazz kit; no dedicated crash (a crash-style ride hit is used) |
| **Abey Road Drums** | **PastToFuture Samples** (licensed) | full multisample kit |
| **Currentz Drums Vol2** | **PastToFuture Samples** (licensed) | includes its own clap |
| **Demarco Drums 3** | **PastToFuture Samples** (licensed) | |
| **Fleetwood Drums Vol2** | **PastToFuture Samples** (licensed) | |
| **Harvest Drums Vol 2** | **PastToFuture Samples** (licensed) | |
| **Sea Change Drums** | **PastToFuture Samples** (licensed) | |
| **60s Wrecking Crew Drums** | **PastToFuture Samples** (licensed) | |

Shared voices: **hi/lo conga** come from the CC0 World Percussion set across every kit; **clap**
is that same World-Percussion hand-clap where a kit had none. Kits with only two toms reuse the
rack (high) tom for the **mid tom** slot. The **PastToFuture** kits are the user's own licensed
purchases; sources noted here for provenance.

## Impulse responses (`assets/drums/ir/*.wav`)

Convolution reverbs from the **Voxengo** free IR pack (IMreverbs, https://www.voxengo.com/impulses/),
downmixed to mono and trimmed to ~3 s:

| Effect slot | IR |
|---|---|
| Room 1 | Small Drum Room | Room 2 | Nice Drum Room |
| Medium Hall 1 | French 18th-Century Salon | Medium Hall 2 | Masonic Lodge |
| Large Hall | Scala Milan Opera Hall | Studio | Highly Damped Large Room |
| Underground | Parking Garage | Spring | Ruby Room (bright-room stand-in; not a true spring IR) |

The lo-fi voicings (**Telephone / Intercom / Muffler**) are synthesized with biquad filter
chains and need no file.
