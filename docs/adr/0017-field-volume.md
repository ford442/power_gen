# ADR-0017: 3-D magnetostatic field volume from catalog sources

- **Status:** Accepted
- **Date:** 2026-11
- **Issue:** #255 (after #250, #252, #253, #254)

## Context

Every field picture in the lab was its own special case: the SEG RK4 tracer
re-evaluated every roller per step and re-traced from the seed for every
segment; the transformer drew an analytic torus metaphor; Halbach lines
existed on WebGL2 only; maglev, homopolar, Hall, Lorentz and jumping-ring had
none. None of them could answer "what is B *here*?", none was shared between
benches, and none could be tested against physics.

## Decision

1. **The catalog declares the sources.** Each bench with a field picture gets
   a `fieldSources` row in `physics/devices.json`: `unitM` (metres per scene
   unit), `bounds` (device-local AABB), a default `probe` point, a one-line
   `model`, an optional uniform `efield`, and `groups` of primitive sources —
   `dipole`, `segment` / `polyline`, `box`, `cylinder` — or a named builder
   (`segRollers`, `halbachRing`, `toroidCore`, …) for layouts that follow the
   plant. Each group may scale by a `drive` (a telemetry key or state field).
   Nine benches: seg, maglev, pulse-coil, homopolar, halbach-viz, transformer,
   hall, lorentz-sled, jumping-ring. Codegen validates and emits TS + WGSL.
2. **Exact kernels, one formula per source, two languages.**
   `src/physics/field-eval.ts` and `shaders/common/field-sources.wgsl` are
   line-for-line twins: magnetised sphere (dipole outside, uniform inside),
   finite-wire Biot–Savart with a wire core, uniformly magnetised cuboid by
   its surface-charge closed form, solenoid / axially magnetised cylinder by
   Derby–Olbert with Bulirsch's `cel`. No far-field approximations; vacuum
   only (an iron core enters as equivalent ampere-turns, and the row's
   `model` says so).
3. **One volume, every consumer.** On WebGPU the focused bench's field is
   swept into an n³ `rgba16float` texture (B.xyz, |B| in mT; 64³ at
   `medium`, 128³ at `high`/`ultra`), tiled through workgroup memory
   (`passes/field-volume.wgsl`). The streamline tracer (RK4 on trilinear
   samples), the slice plane (|B| heat / arrows / LIC), the |B| isosurface
   march and the Boris particle pusher all sample that texture. The SEG RK4
   tracer and the transformer torus lines remain the overview and low-tier
   fallback; in focus at `medium`+ the volume lines replace them, and the
   isosurfaces replace the hand-modelled Roschin–Godin wall shells while on.
4. **The probe is the exact sum, not a texel.** Readouts, record keys
   (`<bench>.field.probe.Bx|By|Bz|B`, `<bench>.field.drive.<group>`) and the
   probe knobs (`<bench>.field.probe.x|y|z`) evaluate the CPU kernels from
   plant state (`src/physics/field-probe.ts`) — headless, on both renderers,
   in both experiment runners. The GPU `field-probe.wgsl` exists for the
   golden test and `window.fieldVolume.probeGpu()`.
5. **Budget and gates.** Focus view only; `low` / `critical` tier skips the
   volume and the particles; overview never allocates it (frame-graph
   lifetime `field-volume`, released a few frames after the gate closes).
   A sweep starts only when the sources moved (rate-capped at 30 Hz for 64³,
   15 Hz for 128³) and 128³ is time-sliced over four frames from one source
   snapshot. The pass has its own compute pass, so `?gpuTiming=1` reports it
   separately. Target: ≤ 2 ms GPU at 64³ on the medium tier.
6. **WebGL2** gets the panel's probe readout and a CPU |B| slice (32² exact
   samples in a 2-D canvas, the same colour ramp); volume lines, isosurfaces
   and particles are listed in `intentionalGaps`.
7. **No library.** Ray march, LIC and tracer are hand-written WGSL (ADR-0003).

## Testing

No GPU in CI, so `scripts/lib/wgsl-mini.mjs` compiles the shaders' own WGSL
text (subset: no pointers, textures limited to the storage write) to JS with
f32 rounding and workgroup barriers as lockstep generator yields.
`npm run test:field-volume`:

- every kernel against an independent quadrature (Biot–Savart line sums,
  face-charge quadrature, a 200-loop stack for the solenoid);
- `field-probe.wgsl` against the CPU reference at 20 points per bench, < 1 %
  (observed ≈ 1e-6 relative);
- the tiled `field-volume.wgsl` kernel reproduces `buildFieldVolume` texels,
  including a bench with more sources than one workgroup tile.

`scripts/tests/field-pack.test.mjs` holds the uniform layouts to their WGSL
structs, the gate to the tier rules, the particle plan, Boris |v| and E×B
drift, and the probe record keys to the textbook solenoid. The reference
experiment `pulse-coil-field-vs-current` fits B_y at the coil centre against
the coil's signed current: slope μ0·N/√(L² + 4a²) within 1 %.

## Consequences

- One field model per bench, declared in data, tested against physics, and
  readable by experiments — the probe is as citable as any telemetry key.
- Particle motion is honest about time: protons and α resolve their
  gyration; electrons at bench fields are capped at 5 % of c and their
  gyroradius is below a pixel, so they step their guiding centre and the
  panel says the gyration is not resolved.
- The volume does not feed back into any plant (#255 §5 coupling is not
  done): plants keep their lumped models; the volume is a picture and a probe
  of the same sources, not a field solver.
- Fidelity stays uneven: SEG rollers are spheres, Halbach blocks are ideal
  N52 cuboids, iron is absent. Each row's `model` text is what the panel
  shows under the readout.
