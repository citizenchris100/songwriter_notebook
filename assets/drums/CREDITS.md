# Drum machine — sample & impulse credits

The drum machine ships bundled one-shot samples and (for the effects pulldown) convolution
impulse responses. All are royalty-free; sources and licenses are listed here. **CC-BY
sources require attribution** — this file plus the in-app credits line satisfy that.

All samples are processed to mono, 16-bit, 44.1 kHz, trimmed of leading silence and
level-matched (the drum machine responds to per-step MIDI velocity, so one full-velocity
one-shot per voice is stored and scaled down at play time).

## Kits (`assets/drums/kits/<kit>/<voice>.wav`)

### Kit 4 — general acoustic
- **Kick, snare, closed/open hi-hats, low/mid/high toms, crash, ride** — from the
  **Muldjord Kit** by Freepats. License: **CC-BY 4.0**
  (https://creativecommons.org/licenses/by/4.0/). Source: https://freepats.zenvoid.org/Percussion/acoustic-drum-kit.html
  — top velocity layer of each instrument, mono downmix.
- **Clap, hi conga, lo conga** — from **Freepats World Percussion**. License: **CC0 1.0**
  (public domain). Source: https://freepats.zenvoid.org/Percussion/world-and-rare-percussion.html

### Jazz / RnB / Latin — TODO (sourcing + audition pending)

## Impulse responses (`assets/drums/ir/*.wav`) — TODO (sourcing pending)

The convolution reverbs (Room/Hall/Spring/Studio/Underground) will use CC0/CC-BY impulse
responses; the lo-fi voicings (Telephone/Intercom/Muffler) are synthesized with biquad
filters and need no file.
