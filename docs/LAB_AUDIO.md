# Lab sonification (`?audio=1`)

Sparks, coil discharges and MHD flow are all visible in the lab and were all
silent. A lab you can watch but not hear reads as a diagram; a few honest cues
make it read as *occupied*.

This is **sonification, not sound design**. Every pitch and level is a number the
dashboard already shows, mapped through a clamped function. Nothing here claims a
real coil sounds like this.

## Opt-in, and silent by default

| Step | What happens |
|------|--------------|
| Default boot | Nothing is constructed. No `AudioContext`, no hub subscription, no badge |
| `?audio=1` | The graph is *armed*: a hub subscription and a header badge reading **Audio: tap** |
| First user gesture (anywhere) | `AudioContext` opens, voices start, bus ramps up — badge reads **Audio on** |
| Click the badge | Mute / unmute (ramped, never a step) |

Two reasons the gesture is not optional: browsers refuse to start an
`AudioContext` without one, and autoplaying a lab at someone is rude regardless.
Aliases for the flag: `audio=1` / `on` / `true` / `yes`. Everything else,
including `audio=0`, stays silent.

## The graph

```
  saw osc ── bandpass ──┐        SEG rotor drone    (segOmega)
  saw osc ── lowpass  ──┤        pulse-coil buzz    (pulseCoilCurrentA)
  noise   ── bandpass ──┼── busGain ── compressor ── destination
  noise   ── bandpass ──┘        spark clicks       (one-shot, per event)
                                 flow bed           (mhdFlowU, mhdCurrent)
```

Four oscillator/noise voices, three filters, one compressor, one master gain.
**No sample pack.** The noise bed is one second of `Math.random()` written into an
`AudioBuffer` at startup and looped — smaller than any WAV and more honest,
because there is no recording pretending to be this bench. `npm run test:audio`
fails if an audio file appears under `src/public/` or an audio library appears in
`package.json`.

## Mapping

Hosted in `src/audio/lab-audio-mapping.ts`, which is pure and dependency-free
because it is the part that can be wrong.

| Voice | Telemetry | Behaviour |
|-------|-----------|-----------|
| SEG rotor drone | `seg.segOmega` | 48 → 82 Hz; gain ∝ t² so a slow rotor is quiet, not just low |
| Pulse-coil buzz | `devices['pulse-coil'].pulseCoilCurrentA` | 90 → 310 Hz over ±80 A (the same current scale the FDTD slice uses) |
| Flow bed | `devices.mhd.mhdFlowU`, `mhdCurrent` | Flow sweeps a bandpass 260 → 1160 Hz; current sets the level, so flow with no load is quieter than flow doing work |
| Kelvin spark | `devices.kelvin.kelvinSparkTimer` | **Event.** The plant sets a countdown at breakdown, so a rising edge is the spark. 2.6 kHz click, level from V/V_break |
| VDG spark | `devices.vdg.vdgSparkHz` | **Rate.** The hub publishes a 1 s-window average, not an event, so clicks are *scheduled* at 1/Hz. 1.5 kHz — a bigger gap reads lower |

The Kelvin/VDG split is deliberate and documented rather than papered over: one
is an event in the snapshot and one is a rate. Scheduling from a rate is
arguably better for audio anyway, because the click rate then does not depend on
the frame rate — a 30 fps tab and a 144 Hz one sound the same.

House rules, all checked:

- clamp both ends, always;
- NaN / ±Infinity / undefined behave as **silence**, never as a default tone;
- per-voice gains sum (with a spark at full tilt) to under unity after the master
  gain, so the compressor is insurance and not the only thing between a full lab
  and clipping.

## Silence

| Trigger | Effect |
|---------|--------|
| `visibilitychange` → hidden | Context suspended. **No background drone** |
| `pagehide` | Context suspended |
| Hardware twin disconnects | Bus muted, so a dropped bench does not hold its coil tone |
| Badge click | Mute (ramped over 80 ms) |
| `LabAudio.destroy()` | Voices stopped, nodes disconnected, context closed |

Spark voices are one-shot: each click builds its own buffer source and tears it
down in `onended`, so the graph stays flat and nothing accumulates over a long
session. A click is also rate-limited (30 ms) so a packed lab cannot request
clicks faster than they are distinguishable.

## Code

| Piece | Path |
|-------|------|
| Mapping (pure, Node-tested) | `src/audio/lab-audio-mapping.ts` |
| Web Audio graph | `src/audio/lab-audio.ts` |
| Header badge / mute switch | `src/audio/lab-audio-badge.ts` |
| Contract test | `npm run test:audio` → `scripts/test-lab-audio.mjs` |
| Agent hook | `window.labAudio` (`start()`, `toggleMuted()`, `setMuted()`) |

Both renderers get it: the module reads `TelemetryHub` only, so WebGPU and WebGL2
behave identically and it costs the renderers nothing.

## Not doing

- **Tone.js / Howler.** A 20-line oscillator graph is smaller than either.
- **Sample packs.** See above; the test enforces it.
- **Auto-play on first paint.** Out of scope by design, and impossible anyway.
- **Positional / spatial audio per bench.** A `PannerNode` per device would want
  a listener tied to the camera and a real mix; the value is in *hearing the
  bench at all*, which one bus delivers.
- **Claiming acoustic fidelity.** These are cues mapped from plant numbers.
