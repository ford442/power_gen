# ADR-0010: 2D FDTD wave slice (not FEM)

- **Status:** Accepted
- **Date:** 2026-09
- **Epic:** #193 Workstream A

## Context

ADR-0005 lists "Full Maxwell FEM in-browser" as a non-goal, and the WASM plant
stays lumped ODEs (ADR-0002). Every field picture in the lab so far is either
an analytic superposition (Halbach heatmap, SEG RK4 flux lines) or a
quasi-static proxy. None of them shows the one thing a classroom cannot see on
a bench: an electromagnetic disturbance *propagating* at a finite speed away
from a changing current.

A 2D finite-difference time-domain slice shows exactly that, and it is a very
different product from a design solver:

| | FEM / MoM / 3D FDTD design tool | This slice |
|---|---|---|
| Question answered | "What is the field of *this* geometry, to N %?" | "What does a changing current do to the field around it?" |
| Dimensionality | 3D | One 2D plane, TM_z (Ez, Hx, Hy) |
| Materials | Permeable cores, conductors, dielectrics | Vacuum only |
| Units | SI, calibrated | Normalized (ε = μ = c = Δx = 1), light slowed for display |
| Boundaries | PML / radiation conditions to spec | Graded-loss sponge, ~0.5 % reflected amplitude |
| Cost | Mesh + sparse solve | 256² explicit stencil, a few ms of GPU per frame |

## Decision

1. Ship a **2D TM_z Yee slice** (`src/physics/fdtd-tmz.ts`,
   `passes/fdtd-tmz-compute.wgsl`, `passes/fdtd-slice.wgsl`) as a focus-view
   pass **owned by the `pulse-coil` plugin**, not a new catalog device. No
   `shaderMode` / `wasmMode` is allocated, no telemetry keys change, the
   14-device overview is untouched.
2. **Drive source:** the pulse coil's axial cross-section. Each of six turns
   crosses the plane twice, at ±coil radius, as a soft J_z source with opposite
   sign on each side. Amplitude is the plant's displayed coil current
   (`pulseCoilCurrentA / 80 A`, clamped to ±1.5), slewed over ~4 frames so the
   source stays band-limited on the grid.
3. **Grid time is decoupled from plant time.** The grid advances a fixed 6 Yee
   steps per frame (Courant 0.5), so a front crosses the panel in about a
   second. A real millisecond coil pulse radiates wavelengths far larger than
   the bench; the slice slows light by many orders of magnitude so the
   propagation is visible. The UI and gallery say so.
4. **Quality gate:** WebGPU, `pulse-coil` focus, `high` (or a future `ultra`)
   tier only; `?fdtd=0` kills it at any tier. The pass is built **lazily** the
   first time the gate could open, so default boot compiles and allocates
   nothing new.
5. **Same GPU device** (ADR-0007). Fields live in three `array<f32>` storage
   buffers, separate from the 16 B / 32 B particle layouts.
6. **WebGL2 skips the slice** (ADR-0001). The dependency-free CPU kernel in
   `fdtd-tmz.ts` is the reference for `npm run test:fdtd` and the seed if a
   micro-grid heatmap is ever wanted there.
7. **No libraries.** The whole update is ~40 lines of WGSL and TS each; no
   header-only Yee helper, Eigen, deal.II or FEniCS.

## Consequences

- **Positive:** A teachable wave picture with an explicit drive, honest units,
  and a CI check that the CPU and GPU agree on layout, workgroups, loss profile,
  stability and edge absorption. Measured on Dawn/SwiftShader, GPU Ez matches the
  CPU kernel to < 1e-6 after 240 steps.
- **Negative:** Pictures are qualitative. Vacuum only, so the coil's iron
  armature and any core are invisible to the field; the 2D slice treats each
  winding as an infinite line current perpendicular to the plane.
- **Neutral:** The FEM non-goal in ADR-0005 stands. This ADR does not open the
  door to 3D FDTD, material models, or design use; those need a new ADR.

## Related

- ADR-0001, ADR-0002, ADR-0005 (FEM non-goal), ADR-0007, ADR-0008
- `docs/DEVICE_GALLERY.md#pulse-coil`, `docs/BINDINGS.md` (`fdtdCompute`, `fdtdSlice`)
- K. S. Yee, "Numerical solution of initial boundary value problems involving
  Maxwell's equations in isotropic media", *IEEE Trans. Antennas Propag.* 14 (1966)
- A. Taflove, S. C. Hagness, *Computational Electrodynamics: The FDTD Method* (3rd ed., 2005)
