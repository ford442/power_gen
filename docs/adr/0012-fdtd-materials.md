# ADR-0012: FDTD material cells (μ_r / σ), still 2D, still not FEM

- **Status:** Accepted
- **Date:** 2026-09
- **Epic:** #203 Workstream C
- **Extends:** [ADR-0010](./0010-fdtd-slice.md), which explicitly required a new
  ADR before any material model

## Context

ADR-0010 shipped a 2D TM_z Yee slice in the `pulse-coil` focus view and listed
its own most-conspicuous gap under *Consequences → Negative*:

> Vacuum only, so the coil's iron armature and any core are invisible to the
> field; the 2D slice treats each winding as an infinite line current
> perpendicular to the plane.

That gap is exactly where a classroom asks its next question. The picture shows
a disturbance spreading from a changing current, but the slug of soft iron the
coil is *built around* — the thing the whole apparatus exists to pull — has no
effect on it at all, and the copper the current flows in is transparent. A
viewer who notices that is right to distrust the picture.

The obvious escalation is the wrong one. 3D Yee, a PML to spec, or anything
called a solver would multiply the cost and — worse — invite the claim that the
output means something quantitative. The epic's own table says so: **do** μ_r / σ
cell flags on the same 256² grid; **do not** do 3D Yee, PML-to-spec, or
commercial-solver parity.

## Decision

1. **Two material numbers per cell, nothing more.** A single
   `array<vec2f>` alongside the three field buffers holds
   `(1/μ_r, electric half-step loss)`. Built on the CPU by
   `buildFdtdMaterialMap` from a short list of rectangles and disks; rasterized
   **once** at init, because the armature and the windings do not move.

2. **Where they enter the update** (`src/physics/fdtd-tmz.ts` and
   `passes/fdtd-tmz-compute.wgsl`, which stay line-for-line equivalent):

   | Quantity | Effect |
   |---|---|
   | μ_r | `ν = 1/μ_r` multiplies the Ez curl in the **H** update, averaged across the two Ez nodes each staggered H component sits between |
   | σ | its half-step loss `s = σ·S/2` is **added** to the sponge's electric loss in the **E** update |

   Both are monotone in the safe direction. μ_r ≥ 1 can only *reduce* the
   effective Courant number (a permeable cell slows the local wave,
   v = 1/√(εμ) < c), and σ only damps, so **materials cannot destabilise a grid
   that was stable in vacuum**. No new stability analysis, no per-material time
   step.

3. **Vacuum stays the reference.** With no map, an all-vacuum map, or
   `?fdtdMaterials=0`, `params.materialFlags` has the material bit clear, the
   shader never reads the buffer, and the update is bit-for-bit the ADR-0010
   kernel. `npm run test:fdtd` asserts that identity rather than trusting it.

4. **Display values, not SI, and the UI says so.** Real soft iron is
   μ_r ≈ 2000–5000 and real copper σ ≈ 6·10⁷ S/m. On a 256² normalized grid
   either number is useless: μ_r = 2000 slows the wave ~45× so the armature
   simply goes black within a frame, and that σ is a perfect mirror one cell
   thick. `FDTD_MATERIAL_PRESETS` therefore ships **teaching** values —
   μ_r = 24 for the armature, σ = 3 for the turns — chosen so the refraction and
   the exclusion are *visible*. The panel legend and the device gallery label
   them as display values.

5. **An optional second drive, not a second solver.** `?fdtdDrive=transformer`
   modulates the same winding cross-sections with the transformer bench's
   normalised core flux (`transformerFluxN`) instead of the pulse coil's
   discharge current. Continuous AC rather than one transient, so the panel
   shows successive fronts — the better picture for "why does a changing current
   radiate?". The geometry never changes; only the amplitude source does, and it
   falls back to the coil when that bench is not in the lab.

   Borrowing across benches costs one thing worth stating: the render loop skips
   `update()` for every unfocused device, so the transformer's flux would be
   frozen at 0 while the pulse coil is focused. `_stepBorrowedDrivePlant` therefore
   steps **that bench's physics only** — no particles, meshes, uniforms or GPU
   work — for as long as the slice is reading it, and stands aside when the WASM
   or replay path already owns every device's state. Two consequences: the
   transformer's own telemetry advances while the flag is on (honest — the bench
   *is* running), and the flag is WebGPU-only, because the WebGL2 readout
   subscribes to TelemetryHub and owns no device instances to step
   (`docs/WEBGL2.md`).

6. **WebGL2 gets a CPU micro-grid, not a GLSL port.**
   `src/fdtd-heatmap-overlay.ts` runs the *same* `FdtdTmzGrid` kernel — the one
   the contract test checks — on a 64² grid, 2 Yee steps per frame, with the same
   material map and sources, and paints it into a 176 px canvas in the corner of
   the pulse-coil focus view. Measured at **0.23 ms/frame** in CI. It is a
   readout, not a render path: no GL state, no shader, no interaction with the
   WebGL2 renderer beyond a TelemetryHub subscription. `?fdtd=0` kills it.

7. **No new GPU device, no new pass, no new libraries.** Same device
   (ADR-0007), same two compute entry points, same panel pipeline; bindings 4
   (compute) and 6 (slice) are added to the existing layouts, and
   `npm run check:bindings` pins them. Still no Eigen / deal.II / FEniCS, and the
   whole material addition is ~60 lines of TS and ~15 of WGSL.

## Consequences

- **Positive:** The armature refracts and the copper excludes, both visibly, and
  the panel draws the material outline so the bend has a cause the viewer can
  see. The CI check now pins the *claim* and not just the arithmetic: that μ_r
  slows the front on the material side while leaving the vacuum side
  untouched, and that a σ block holds ≲10 % of the energy just outside it.
  WebGL2 stops being blank on the one thing the slice teaches.
- **Negative:** The numbers are further from SI than ADR-0010's were — there we
  had normalized *vacuum*, which is at least exactly right up to scaling; here
  the material constants are chosen for legibility. Anyone reading μ_r = 24 as
  iron would be wrong. Staircased boundaries also mean a diagonal face has
  ~1-cell artefacts, which at 256² is invisible and at 64² is not.
- **Neutral:** ADR-0005's "Full Maxwell FEM in-browser" non-goal stands, and this
  ADR does not open the door to 3D FDTD, dispersive or anisotropic materials, or
  design use. The `materialFlags` word has 31 spare bits; spending one is not
  precedent for spending the rest.

## Related

- ADR-0001 (WebGL2 is opt-in), ADR-0007 (one GPU device), ADR-0010 (the slice),
  ADR-0011 (cross-device coupling — the same "borrow another bench's number,
  label it, clamp it" pattern as the transformer drive)
- `docs/DEVICE_GALLERY.md#pulse-coil`, `docs/BINDINGS.md` (`fdtdCompute`,
  `fdtdSlice`), `docs/WEBGL2.md`
- `npm run test:fdtd` — `scripts/test-fdtd-slice.mjs`
- A. Taflove, S. C. Hagness, *Computational Electrodynamics: The FDTD Method*
  (3rd ed., 2005), ch. 3 — lossy and magnetic media in the Yee update
- K. S. Yee, *IEEE Trans. Antennas Propag.* **14** (1966)
