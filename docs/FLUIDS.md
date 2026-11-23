# Fluids and heat — what is solved, what is drawn

Four core benches are about moving liquid or moving heat: `heron`, `kelvin`,
`mhd`, `peltier`. This page says, per bench, which numbers come from a model
and which pixels are only a picture. It is updated as the fluids epic lands;
anything not listed as solved here is not solved.

Every plot and overlay these benches add carries the same line the rest of
the lab uses: **simulated, not a measurement**.

| Bench | Plant (authoritative numbers) | Picture | Solved in the picture? |
|-------|-------------------------------|---------|------------------------|
| `mhd` | One lumped mean speed `Ū` with `σB²`-style braking and wall friction as tuned coefficients; `V = B·Ū·w` | Timelines on the **analytic Hartmann profile** at the plant's `Ū` and `Ha`, plus a profile card | Exact steady solution, evaluated — not a numerical flow solve |
| `heron` | Head ODE; exit speed from Bernoulli with a discharge coefficient and Darcy–Weisbach pipe friction | **WebGPU, in focus:** the jet as a simulated liquid (MLS-MPM), fed at the plant's exit speed, drawn as particles. WebGL2: ballistic droplets in SI, each on its own. WebGPU overview or `fluid=off`: stand-in droplets on a fixed path, labelled as such | The jet and its fall, yes. The vessels and the basin's own water, no |
| `kelvin` | Capacitive charging + spark | Independent droplets; charge does not deflect them | No |
| `peltier` | **1-D finite-volume leg**: 24 cells + cold block, two plates, heat sink (`ros23`) | Three bodies coloured by their node temperatures; sparse air parcels beside them | The temperatures are the model's. The air is illustrative |

The liquid solver (**MLS-MPM**, below) runs on one bench so far:
[Heron's fountain](#herons-fountain). `kelvin` still draws the independent
droplets in the table.

## Liquid solver (MLS-MPM)

`src/fluids/` and `src/shaders/passes/mpm-*.wgsl` — ADR-0022.

### The model

Particles carry mass, velocity, an affine velocity matrix `C` (APIC) and their
own volume ratio `J = V/V₀`. A background grid carries momentum for one
substep. Per substep:

```text
clear   fixed-point grid ← 0
p2g     each particle → its 27 nodes: mass, and momentum = m·(v + C·d) − dt·V·(4/h²)·σ·d
grid    v = momentum / mass + g·dt; wall nodes let nothing flow into the wall
g2p     each particle ← its 27 nodes: v, C; x += v·dt; J ← J·exp(dt·tr C)

σ = −p·I + μ·(C + Cᵀ)        p = B·(J^−γ − 1), never negative (no tension)
```

Weights are quadratic B-splines. The liquid is weakly compressible: Tait's
equation with γ = 7 and the stiffness `B` the step can carry.

### Units and scale

SI inside the solver: metres, seconds, kilograms, pascals; gravity is
9.80665 m/s². Positions are local to the box `[0, gridN·cellM]`. The solver
has no scene scale of its own — the bench that uses it documents its
metres-per-scene-unit.

| Tier (`fluid=`) | Grid | Particles | GPU memory | Momentum resolution |
|------|------|-----------|------------|---------------------|
| low | 32³ | 15 000 | 2.1 MiB | `maxSpeedMS` / 170 000 |
| default | 64³ | 40 000 | 11.1 MiB | `maxSpeedMS` / 64 000 |
| high | 96³ | 120 000 | 36.2 MiB | `maxSpeedMS` / 21 000 |

The grid column is a node budget; a bench shapes its own box inside it
(Heron's `classic` preset is 61³ with 12.5 mm cells at the default tier, the
`tower` preset 49 × 111 × 49 with 15.7 mm cells).

`fluid=auto` (the default) takes the **default** tier at the `high` quality
tier, the **low** tier at `medium` and `low`, and nothing at `critical`.
`fluid=low` / `fluid=high` force a tier; `fluid=off` (or `0`) is no solver.
`auto` never picks `high` by itself: the frame cost of 96³ has not been
measured on hardware. There is no device sniffing — a phone lands on the low
tier or off because its quality tier does.

| `fluid=auto` at quality tier | `high` | `medium` | `low` | `critical` |
|------------------------------|--------|----------|-------|------------|
| no lab mode, or Lab | default | low | low | none |
| Showroom (asks for the most) | high | default | low | none |
| Twin (asks for none) | none | none | none | none |

**`auto` steps down and does not climb back.** A solver is held at the tier
it was built at while the profiler allows at least that much — a rebuild
empties the fountain. When the profiler falls below the tier that is running,
that tier is not built again on this page: the liquid is rebuilt at what the
profiler allows, and falling to `critical` costs one more step, so the next
attempt is smaller and the third is none (`liquidCeilingAfter`). The profiler
cannot tell whether the liquid was the cause; stepping down anyway is the
safe side of that. A tier asked for by hand is left alone at any frame rate.
`window.getRendererInfo().fluid` reports `choice`, `preset` and `ceiling`.

### What is exact and what is not

- **Mass** is exact: a particle scatters its own mass to the count, and the
  particle count only changes at an emitter or a sink.
- **Momentum** is conserved by the transfers to the fixed-point resolution:
  over 100 substeps, 5·10⁻⁶ of the total at a 4096-particle budget and
  2·10⁻⁴ at the high tier's scales.
- **Gravity is real.** A free block falls by `½·g·dt²·n(n+1)` in `n`
  substeps to 1 part in 10⁴ — the discrete law of the integrator.
- **Hydrostatics.** A settled column reads the weight of the liquid above
  per unit area — ρ·g·h — within 0.5 % in the bulk, on the CPU reference and
  on the GPU. The bottom two cells carry the floor's reaction and read up to
  10 % off.

### Limits

- **Compressible, by an amount set by the step.** The speed of sound is at
  most `0.5·h/dt`. On a 64³ grid over 0.64 m, a 1/240 s substep gives 1.2 m/s:
  a 10 cm pool is squeezed 28 % at its base and a 2 m/s jet is supersonic.
  At 1/2400 s it is 12 m/s and 0.7 %. `mpmColumnCompression` gives the figure
  for any configuration; ADR-0022 has the table. A bench chooses its step —
  and whether it therefore runs slower than real time — and says so here.
- **Far more viscous than water.** The scheme's own damping is about
  2·10⁻³ m²/s at a 1 cm cell, a thousand times water. The `viscosityPaS`
  setting adds exactly what it should on top, which only shows for syrups.
- **No surface tension**: no beading, no capillary pinch-off.
- **`J` is integrated, never corrected** against the particle spacing, and
  fixed-point noise makes free-flying liquid swell slightly (0.35 % in 400
  substeps at the high tier's scales). Recycling through sinks and emitters
  resets both.
- **Solids are analytic primitives** (boxes, cylinders, tubes, open vessels)
  sampled as a signed-distance field on the grid nodes, free-slip. A wall has
  to be about two cells thick to hold water. They are not baked from the GLB
  props: the benches' drawn vessels are instances of one fixed cylinder, and
  the props are optional decoration. No body-force hook yet.
- **Emitters are round nozzles in plug flow; sinks are boxes that remove
  whatever is inside them.** A sink has no rate of its own: in steady state
  it passes what arrives.
- **Points, not a surface.** Screen-space surface rendering is a later step.
- **WebGPU only.** There is no WebGL2 liquid solver and there will not be
  one; `MpmCpu` is a test reference, far too slow to stand in.
- **The frame cost is unmeasured.** The epic's target is ≤ 2 ms of GPU time
  on an integrated GPU at the default tier. Tests here run on a CPU
  rasteriser, which cannot tell.

### Around the core: solids, nozzles, drains, read-back

| Pass | When | Does |
|------|------|------|
| `mpm-emit.wgsl` | once a frame, before the substeps | a live particle inside a sink box becomes an empty slot; empty slots take the frame's new particles |
| `mpm-probe.wgsl` | when a read-back is wanted | sums the liquid's mass per horizontal layer of the grid, plus the emitted / drained totals, into a buffer of a few hundred bytes |
| `mpm-export.wgsl` | once a frame, after the substeps | writes the 16-byte records the existing particle pipeline draws, in scene units |

A nozzle owes `Q·t / V₀` particles for the time a frame simulates; fractions
carry over, so the count is exact in the long run. New particles are placed at
rest density in the cylinder the jet sweeps that frame, so successive frames
stack into a continuous stream.

Which empty slot a new particle lands in depends on the order the GPU runs
the slots in. Nothing else does: a particle's place in the nozzle, its
velocity and its dither counter are functions of its id. On two runs of the
same case the liquid is identical particle for particle while most of them sit
in different slots (`test:gpu-golden` checks exactly that).

The profile is how a bench reads the liquid back without a readback of the
particles: the top of a jet is the highest layer holding more than a tenth of
the nozzle's own cross-section, and `emitted − drained` is what is in the box.
It is copied out asynchronously and never blocks a frame.

### The surface

From the `medium` quality tier up the bulk of a liquid is drawn as a surface,
not as particles (`src/visualizer/fluid-surface-pass.ts`, `passes/fluid-*.wgsl`,
part of the liquid chunk). It is a screen-space method: nothing is meshed.

| Step | Pass | What it does |
|------|------|--------------|
| 1 | `fluid-splat.wgsl` `fsDepth` | each bulk particle as a sphere impostor into the liquid's own depth target, nearest wins — the front of the liquid |
| 2 | `fluid-splat.wgsl` `fsThickness` | the same impostors, added up: how much liquid lies along each view ray |
| 3 | `fluid-filter.wgsl` × 2 | a narrow-range filter (Truong & Yuksel 2018) along x, then y, between two depth targets |
| 4 | copy | the scene colour as it stands, for refraction |
| 5 | `fluid-composite.wgsl` | normals from the filtered depth, then refraction of the copy, Beer–Lambert absorption on the thickness, the environment the metal reads (the frame group's IBL) by Schlick's Fresnel term, and the key light's highlight — blended over the scene colour |

It sits in the frame graph as `fluid-surface`, after the scene pass and the
MSAA depth resolve and before TAA, SSR and bloom, so those treat the liquid as
part of the scene. Its four full-resolution targets (two `depth32float`, one
`r16float`, one copy of the scene colour — 9 MB at 800 × 826) are a lifetime
of their own: allocated the first frame the pass runs, released with the
graph's hysteresis, never in overview.

- **Depth is linear.** The liquid's depth targets hold distance along the
  view axis over the far plane, not the projection's z. The filter averages
  it and the composite takes its differences; both want it linear.
- **Thickness is a volume.** A splat sphere is one particle spacing in radius
  (so neighbours close into a surface), 4.2 times a particle's volume. Each
  chord is scaled by the ratio, so the thickness target integrates to the
  liquid's volume: 0.999 of it for one sphere on a GPU (`golden-fluid-surface`).
- **Far away a sphere is smaller than a pixel.** At the fitted Heron view a
  default-tier particle is 0.8 px in radius. A splat is never drawn under
  1.5 px and is thinned by the cube of the ratio, so it still stands for its
  volume (0.999 for a sheet of 0.08 px spheres).
- **The filter is narrow-range.** A neighbour more than δ (three splat radii)
  in front is another surface and is left out; one more than δ behind — or no
  liquid at all — counts as δ behind. A jet in front of a pool is not smeared
  into it, and a silhouette is rounded back instead of dragged to the far
  plane. The support is a size in the scene (four radii), capped at 16 px.
- **Spray stays particles.** The solver's export classifies each particle by
  the grid mass at its position over rest density (`mpm-export.wgsl`): under
  0.15 it is spray and is always drawn by the particle pipeline, whiter. A
  lone particle reads about 0.05; a single layer of them 0.30. So the top of
  a jet and a broken sheet stay points, as the epic asks. At the default
  tier most of Heron's *falling* water is spray: the sheet thins as it spreads.
- **The liquid is dyed.** Water's own absorption (0.4 /m in the red) does not
  show in a jet centimetres thick; with it the liquid would be visible only
  by reflection. The looks use a dye's (`FLUID_LOOK_OPTICS`) and the bench's
  note says so:

  | Look | Absorption /m (R, G, B) | 3 cm transmits | Roughness |
  |------|-------------------------|----------------|-----------|
  | `studio` | 16, 5, 1.6 | 62 %, 86 %, 95 % | 0.08 |
  | `lab` | 8, 2.6, 1.0 | 79 %, 92 %, 97 % | 0.05 |
  | `drama` | 22, 8, 2.2 | 52 %, 79 %, 94 % | 0.14 |

Limits: one refraction lookup, not a ray through the liquid; no caustics, no
shadow cast by the liquid; thickness counts liquid behind an opaque object
that stands behind the liquid's front; under TAA the surface is reprojected
with the camera only, like every moving thing in the scene. **Not looked at
on a real GPU**: the structure is checked by the tests below and on a
software rasteriser, the colours are not tuned.

### Fixed point

WGSL has no float atomics, so the scatter accumulates `atomic<i32>`. Two
things make that sound:

1. **The scales are sized from the particle budget** so that even with every
   particle on one grid node the sums fit. There is no overflow check because
   there is no overflow.
2. **Rounding carries its remainder** from one of a particle's 27 nodes to
   the next, from a hashed start. Without it, anything slower than one count
   is rounded away each step: a settling column creeps and reads 3 % low.

Integer sums are order-independent, so two runs give the same bytes.

### Tests

| Command | Holds |
|---------|-------|
| `npm run test:mpm` | the CPU reference: overflow bound for any budget and the worst-case fill; WGSL struct layouts; mass, momentum; free fall at `g`; ρ·g·h within 5 % at default- and high-tier scales; viscous decay at `2νk²`; walls |
| `npm run test:gpu-golden` (`golden-mpm`) | the WGSL passes on a real GPU against that reference: grid after one substep, 240 substeps of a dropped block within 2 % of a cell, momentum, ρ·g·h within 5 %, the default budget on one node without a wrap, two runs byte-identical, all three tiers allocate and step |
| `npm run test:mpm-io` | solids, emitters and sinks on the CPU reference: signed distances, the baked field, the uniform against its WGSL struct, a cup that holds water, a drain that empties it, a jet at `v²/2g`, the budget running out |
| `npm run test:gpu-golden` (`golden-mpm-io`) | the same on a real GPU: a block dropped into a cup (GPU ≈ CPU to 0.001 cells, nothing inside the solid), two nozzles (GPU ≈ CPU by particle id; two runs identical by id), sink counts, the profile, the draw export, a jet at 1.005 × `v²/2g` |
| `npm run test:pipelines` | the six pipelines compile against the `mpm` and `mpmIo` layouts |

## Heron's fountain

### The plant

One state, the driving head `H`, with the exit speed from an energy balance
over the supply pipe and the nozzle:

```text
dH/dt = pumpRate·drive − drainCoeff·v            0 ≤ H ≤ H_max (preset)
H = v²/2g · ( 1/C_d² + f·(L/D)·(A_n/A_p)² )      f: Swamee–Jain at the pipe's Reynolds number
Q = A_n·v          p = ρ·g·H          jet (ideal) = v²/2g
```

`cpp/src/plant/heron_plant.cpp` and `computeHeronHydraulics`
(`src/heron-layout.ts`) are the same arithmetic, and `test:golden` holds them
to each other on two presets.

**This replaced a plant that did not work.** The JS plant took the friction
loss at the *ideal* exit speed over the whole pipe, `f·(L/D)·H`. With the
presets' `L/D` of 40–145 that is 2–7 times the head, so the exit speed, the
flow and the energy level were identically zero at every head, on every
preset, and the head sat on its ceiling. The C++ plant used a different
formula (15 % of that loss) and its own built-in pipe (12 mm), ignored the
layout preset, and reported about 1.6 m/s and 11 L/min whichever one was
selected. Nothing compared the two. Now the friction is at the pipe's own
speed (continuity through the nozzle), the active preset is sent to the C++
plant (`setHeronLayout`), and there is a golden case.

Numbers at the head ceiling, `classic` preset: `v` = 3.26 m/s, `Q` =
246 L/min, ideal jet 0.54 m. The discharge coefficient (0.30–0.38 across the
presets) dominates; pipe friction takes 0.9 % off the exit speed on `classic`
and up to 6.7 % on `spiral`, the longest and narrowest pipe.

### Units and scale

| Quantity | Value | Source |
|----------|-------|--------|
| Metres per scene unit | 0.64 | `physics/constants.json` → `heron.metresPerSceneUnit` |
| Gravity | 9.80665 m/s² | `physical.G` — no separate scene gravity |
| Liquid time scale | 1/6 (shown at one sixth of real speed) | `heron.liquidTimeScale` |

Every preset's declared head over the drawn span of its vessel stack comes to
0.62–0.67 m per scene unit, so one figure serves all five. The C++ droplets
(`heron_particle_step`) used `g × 0.35` as a "scene-scaled" gravity with the
exit speed taken as scene units per second; they are now SI divided by this
scale, so a droplet launched at `v` rises `v²/2g` metres.

### The jet as a liquid

`src/fluids/heron-liquid.ts` builds the scene from a layout preset: a box
0.7 m wide around the nozzle, tall enough for the riser and 1.2 × the tallest
jet the preset can make; the nozzle as a round emitter at the plant's exit
speed; and the box floor as the basin — a perforated tray that drains
whatever settles on it.

| Tier (`classic`) | Grid | Cell | Cells across the nozzle | Substeps a frame | Sound speed |
|------|------|------|------|------|------|
| low | 32 × 33 × 32 | 25.2 mm | 1.6 | 2 | 9.1 m/s |
| default | 61³ | 12.5 mm | 3.2 | 4 | 9.0 m/s |
| high | 88 × 89 × 88 | 8.3 mm | 4.8 | 6 | 9.0 m/s |

The fastest `classic` jet is 3.29 m/s, so the liquid's sound speed is 2.7 ×
that at every tier; a 5 cm layer of it compresses 0.6 % under its own weight.

| Choice | Why |
|--------|-----|
| **One sixth speed** | The solver is explicit. At this scale a real-time step gives the liquid a sound speed of about 1 m/s, slower than the jet. A sixth of real time keeps it at 2.7 × the fastest jet with 2–6 substeps a frame. The plant still runs in real time, so after a change of drive the jet takes its rise time × 6 to follow. |
| **The basin does not fill** | The falling water lands up to 0.3 m off the axis. A basin wide enough to catch it holds far more than the particle budget if it is allowed to fill, and a small one that could fill is missed by most of the water. So the tray drains through its whole floor. |
| **The vessels are not particles** | Their levels are the plant's head. |

Measured on a GPU (`test:gpu-golden`, low tier, at 80 % of each preset's head
ceiling): the jet's top is 0.995 (`classic`), 0.983 (`compact`) and 0.937
(`tower`) of `v²/2g`. The tower's cell is 34 mm, 7 % of its jet, which is
most of that last figure. In every run the particles in the box equal
emitted minus drained, exactly.

**Volume over a minute.** The basin is a drain, so "the volume in the scene"
is the jet in the air, fed by the nozzle and emptied by the tray. Over 60 s
on screen (`classic`, same test): the nozzle made 36.62 L, the plant's
`Q·t = A_nozzle·v·t` is 36.62 L (gate 1 %); every particle made is either in
the box or counted as drained; and the liquid in the air averaged 1,065
particles over seconds 30–45 and 1,065 over 45–60 (−0.03 %, gate 1 %) — it
neither builds up nor runs down.

### In the app

`src/visualizer/heron-liquid-pass.ts` is the gate and
`heron-liquid-runtime.ts` the pass that owns the solver. The runtime, the
solver (`src/fluids/`), its six shaders (`fluids/mpm-shaders.ts`) and the
surface pass with its three are one chunk of about 104 kB (25 kB gzip) that
the gate imports the first frame it opens; the WebGPU chunk every visit downloads holds none of it, and
`check:entry-chunk` fails if it does. The offline shell precaches the chunk
like any other. The pass is built the first
frame Heron is in focus with `fluid` allowing it, allocated by the frame graph
(lifetime `heron-liquid`), stepped in its own pass, and released after the
graph's hysteresis once the bench is left. **Overview allocates none of it** —
`test:e2e:webgpu` asserts that with every bench on the floor. A change of
layout preset rebuilds it; it is then empty until the jet rises again.

- The nozzle follows the plant every frame: `heronVExit` in, and the top of
  the jet read back into **`heronJetHeightM`** next to the plant's
  **`heronJetIdealM`** (`v²/2g`). The read-back is a few frames old and reads
  0 — "not measured" — whenever no solver runs (WebGL2, overview, `fluid=off`,
  headless plants, the first second after focus).
- Substeps are fixed in size and their number follows the displayed time at
  the time scale, at most twice the nominal count a frame: a slow frame slows
  the liquid, it does not queue a burst.
- The particles are drawn by the bench's existing particle pipeline from the
  solver's export. The mist clusters and impact ripples the bench used as
  stand-ins are not pushed while the liquid is drawn.
- The focus camera is fitted to the layout preset, from the platform to the
  top of the tallest jet. The old fixed view looked at the floor of the bench
  and cut the fountain off above the upper vessel on every preset.

### Limits

- **A surface from the `medium` quality tier up, points below** (see
  [The surface](#the-surface)). At the low solver tier (32³-class, 25 mm cells
  on `classic`) the jet is 1.6 cells across: its surface is a thin column
  with a cap, and the falling water is spray.
- **The basin is a drain**, and the tray that stands for it is not drawn.
- **The jet lags the plant** by its rise time × 6; a fast change of drive
  shows as a jet that is briefly too tall or too short for the readout.
- **Not in a snapshot, not replayed.** A restore or a scrub re-grows the jet
  from the plant's current exit speed.
- **Frame cost unmeasured on hardware** (see the solver's limits). On the CPU
  rasteriser the e2e runs on, the low tier takes about 2 ms a substep.

### Tests

| Command | Holds |
|---------|-------|
| `npm run test:golden` | the plant: TS ≈ native C++ on `classic` at a partial head and `tower` at full drive |
| `npm run test:heron-liquid` | the scene on all five presets × three tiers: budgets, sound speed against the fastest jet, the nozzle, riser and drain; which tier a `fluid` choice gets, with a lab mode's say and the profiler's step-down; the gate (Heron focus only); the focus camera holding platform and jet; the note's text; the WebGL2 droplets (apex at `v²/2g`, a stream after a spin-up from rest at 60 and 20 fps) |
| `npm run test:gpu-golden` (`golden-heron-liquid`) | on a GPU: the jet within 10 % of `v²/2g` on three presets, the particle books, a taller jet for a higher head, nothing below a dribble; over 60 s on screen the emitted volume is the plant's `Q·t` within 1 % (36.62 L of 36.62 L on `classic`), every particle is in the box or drained, and the liquid in the air holds steady (−0.03 % between the last two quarters) |
| `npm run test:fluid-surface` | the surface without a GPU: the uniform block against its WGSL struct; splat geometry; the narrow-range filter's CPU twin (flat stays flat, bumps under δ are smoothed, a step over δ is not blurred across, a silhouette is rounded by at most δ); scene depth ↔ distance; the looks' optics; which tiers get a surface; spray against liquid on the CPU density twin |
| `npm run test:gpu-golden` (`golden-fluid-surface`, `golden-mpm-io`) | the app's own surface pass on a GPU: a sphere's front at its centre distance minus its radius (3.8004 for 3.8), its disc the size the projection says, thickness integrating to the particle's volume (0.999); sub-pixel spheres held at 1.5 px with their volume (0.999); both filter passes against the CPU twin texel for texel (9e-9); pixels without liquid untouched to the bit; liquid hidden behind a wall and drawn in front of one; thicker liquid absorbing red before blue. The export's bulk / spray / under-a-surface types against the CPU density twin, particle for particle |
| `npm run test:e2e:webgpu` | in the app: the liquid passes dispatch in Heron focus with no validation error and finite numbers, the measured jet reaches the hub; at the low tier no surface pass and none of its targets, from `medium` its four pipelines draw; overview holds no fluid resources and releases them after leaving the bench |

## MHD duct

### The model

The plant (`cpp/src/plant/mhd_plant.cpp`, TS mirror `devices/core/mhd-mesh.ts`)
integrates one state, the mean speed `Ū`:

```text
dŪ/dt = drive·pump − (lorentzK·B² + frictionK)·Ū        B = 0.2 T + 0.8 T·drive
V_oc  = B·Ū·w                                          Ha = B·a·√(σ / ρν)
```

`lorentzK` and `frictionK` are tuned classroom coefficients. They are **not**
derived from the profile below; that is a later step of the epic.

The profile across the gap is the fully developed laminar solution for a duct
much wider than its gap, with insulating walls at `y = ±a` and a uniform field
along `y` (Hartmann 1937):

```text
u(y) / Ū = (cosh Ha − cosh(Ha·y/a)) / (cosh Ha − sinh(Ha)/Ha)
```

`Ha → 0` is the Poiseuille parabola `1.5·(1 − (y/a)²)`. Large `Ha` is a flat
core with a Hartmann layer `a/Ha` thick at each wall. One implementation per
language, held together by tests:

| Where | Used for |
|-------|----------|
| `src/physics/hartmann.ts` | the profile card, the WebGL2 parcels, tests |
| `hartmannShape` in `passes/particle-compute.wgsl` | the WebGPU parcels (`posMhd`) |
| `namespace hartmann` in `cpp/src/plant/mhd_plant.h` | `mhd_particle_step` (offline runner) |

All three evaluate it with decaying exponentials (no overflow at any `Ha`) and
switch to a two-term series in `Ha²` below `Ha = 0.25`, where the closed form
cancels in single precision.

### Units and scale

| Quantity | Value | Source |
|----------|-------|--------|
| Half-gap `a` (between the Hartmann walls, along `B`) | 0.5 mm | `physics/constants.json` → `mhd.halfGapM` |
| Electrode spacing `w` | 0.1 m | `mhd.widthM` |
| Electrode length along the flow | 0.4 m | `mhd.lengthM` (picture only) |
| Working fluid | `σ` = 10⁶ S/m, `ρ` = 870 kg/m³, `ν` = 8·10⁻⁷ m²/s (NaK-like) | `mhd.*` |
| Hartmann number | ≈ 18.95 per tesla → **3.8 at 0.2 T, 19 at 1.0 T** | derived |
| `Re/Ha` at steady state | < 250 over the drive range | `test:hartmann` |

The duct is a thin slot on purpose. The gap was 5 cm until this epic, which
made `Ha` 380–1900: a slug at every field setting, with nothing for the
profile to show. At 0.5 mm the aspect ratio is 100:1, so the 1-D solution is
the right one, `Re/Ha` stays below the Hartmann-layer transition (≈ 380), and
`Ha` spans the range where the profile visibly changes. `halfGapM`, `σ`, `ρ`
and `ν` enter the plant only through the reported `Ha`; the plant's dynamics
did not move.

The **drawn** duct is not to scale: the 1 mm gap is drawn 0.84 render units
tall against a 4.2-unit length, hundreds of times taller than it is. Parcel
motion is shown 6× slower than the plant (`MHD_PARCEL_SLOWDOWN`): a real
centre-line transit takes about 0.2 s. Speeds stay proportional to `u(y)`.

### What the parcels are

Timelines — the hydrogen-bubble technique. A line of markers is released
across the gap at the inlet; each moves at the local `u(y)` and nothing moves
across the stream, so the line bends into the velocity profile as it travels.
Eight are in the duct at once.

```text
x(η) = x_in + L · τ · u(η)/u(0)        τ = fract(travel + line/8),  η = y/a
```

`travel` is centre-line transits, integrated from the plant's `Ū` each frame
(`advanceMhdTravel`), so a change of speed changes how fast the lines move
and never where they are. It lives on the view side: it is not plant state,
is not in a snapshot, and re-settles from the plant after a restore.

Before this, parcels relaxed to one speed with a field-scaled swirl. Fully
developed laminar duct flow has no swirl.

### Limits

- **Analytic, steady, fully developed.** No entry length, no response of the
  profile to a changing `Ū` or `B` — the shape follows `Ha` instantly.
- **1-D.** No side (Shercliff) layers at the electrodes, no fringing field at
  the duct ends, no end-current loops, no M-shaped profiles.
- **Insulating Hartmann walls**, laminar flow.
- **The plant does not use it.** Braking and friction are still lumped and
  tuned; the profile is drawn from `Ha`, the plant is not computed from it.
- A timeline is re-released as a whole when its centre reaches the outlet, so
  the slow wall markers of an old line vanish mid-duct. That is the
  stroboscope, not the fluid.

### Tests

| Command | Holds |
|---------|-------|
| `npm run test:hartmann` | profile vs the textbook form, limits, unit mean, wall shear; C++ twin vs TS; parcels keep lanes and move at `u(y)`; `Ha` range and `Re/Ha` for the catalog constants; overlay curves |
| `npm run test:gpu-golden` (`golden-particles`) | `posMhd` on a real GPU against `mhdParcelPosition`, position for position; a larger `Ha` flattens the line |
| `sim_core_test --mode hartmann` | native profile table and the stateful parcel step |

## Peltier cooler

### The model

A thermoelectric module run as a cooler (ADR-0021). One equivalent leg carries
the whole module — `S = seebeckVK·couples`, `R`, `K` — cut into 24 finite
volumes, with four lumped nodes closing the ends:

```text
[0] cold block ─ [1] cold plate ─ [2 … 25] leg cells ─ [26] hot plate ─ [27] heat sink ─ ambient
     ↑ load W        ↑ −S·I·T                               ↑ +S·I·T            ↑ sinkWK
```

Per cell: Fourier conduction to its neighbours and Joule heat `I²R/24`. At the
junctions: Peltier heat `S·I·T`, absorbed on the cold side and released on the
hot side. Optionally the Thomson heat, when `seebeckSlopeVK2` gives `S` a slope
(off by default). The discrete system conserves energy exactly, so at steady
state `Q_h = Q_c + I·V`, and with constant properties it reduces to the
textbook lumped result `Q_c = S·I·T_c − ½·I²R − K·ΔT`.

It is linear in `T` for a fixed current and stiff — cells relax in
milliseconds, the sink in tens of seconds — so it runs on `ros23`
([`INTEGRATORS.md`](./INTEGRATORS.md)). `cpp/src/plant/peltier_plant.h` and
`src/devices/core/peltier-plant.ts` are the same arithmetic term for term; the
Jacobian is written out in both (tridiagonal; `PeltierPlant::jacobian`,
`peltierJacobian`), and each is checked against differences.

Inputs: the drive slider sets `|I|` up to `iMaxA` (8 A, deliberately past the
optimum); the `peltierPolarity` setpoint its sign; `peltierLoad` feeds heat
into the cold block.

### Numbers (physics/constants.json `peltier`)

| Quantity | Value |
|----------|-------|
| Module Seebeck `S` | 127 × 0.44 mV/K = 0.0559 V/K |
| `R`, `K` | 2.5 Ω, 0.5 W/K |
| Figure of merit `Z = S²/(R·K)` | 2.5·10⁻³ /K |
| `ΔT_max = Z·T_c²/2` | ≈ 76 K on this bench, at `I_opt = S·T_c/R` ≈ 5.5 A |
| Coldest block (zero load) | ≈ 241.6 K (−32 °C) at 4 A — lower current than `I_opt`, because the sink warms with every watt |
| Heat sink | 4 W/K to a 293 K room, 40 J/K |
| 10 W load at 4 A | block ≈ 15 K warmer, COP 0.19 |

### Units, scale and the picture

Temperatures are kelvin throughout; nothing is normalised in the plant. The
three drawn bodies (sink below, module, block above) are one instance cylinder
each and are coloured by node 27, the mean of the two plates, and node 0: blue
60 K below ambient, grey at ambient, red 80 K above. Reverse the current and
the colours swap because the temperatures do. The leg's own profile is in the
state but not drawn yet (the IR view step of the epic).

The air parcels beside the two end bodies drift up beside a warm body and down
beside a cold one at a rate ∝ √|ΔT|. They are **illustrative**: a hand-written
path with the right sign and a plume-like scaling, not a convection solve, and
they do not feed back into the plant. Whether they stay is decided with the IR
view.

### Limits

- **One equivalent leg**, not 127 couples; constant `S`, `R`, `K` unless the
  Thomson slope is switched on.
- **The cold block is insulated** (`coldLeakWK` 0): the load setpoint is its
  only heat source. A bare plate in room air would leak a watt or two.
- No contact resistance inside the module, no radiation, no frost.
- Temperatures are clamped 150 K below and 250 K above ambient. A reversed
  current into the insulated block has no other limit; a real module has
  failed long before.
- Until this epic the bench was a two-node thermoelectric *generator* (heater
  in, Seebeck power out). `peltierPowerW` is now electrical **input** and
  `peltierCOP` the cooling COP. Snapshots from before are migrated
  ([`SNAPSHOTS.md`](./SNAPSHOTS.md#plant-state-version)).

### Tests

| Command | Holds |
|---------|-------|
| `npm run test:peltier` | the four textbook checks (`ΔT_max`, `I_opt`, COP vs current, `Q_h = Q_c + P_in` to 1e-3) on native, the shipped WASM and TS; the leg alone at fixed plates against the textbook `COP(I)` peak; exact Jacobian; Thomson energy closure; array snapshots; the version-1 migration; mesh colours |
| `npm run test:golden` | TS ≈ native on three schedules, all on `ros23`: default, a 12 W load, reversed current |
| `npm run test:integrators` | `ros23` ≥ 10× fewer RHS calls than fine-stepped RK4 on the leg; the LU pivoting case this plant exposed |
| `sim_core_test --mode peltier-textbook` | the same sweep natively, with its own assertions |

## WebGL2

There is no liquid solver on WebGL2 and there will not be one: no compute, no
atomics. Heron's droplets there are ballistic in SI (`stepParticles`, mode 1 in
`renderers/shared/particle-physics.ts`): launched at the plant's exit speed,
`g = 9.80665` over the bench's 0.64 m per scene unit, no drag, so each rises
`v²/2g`. They do not see each other. The nozzle releases a waiting droplet at
a random moment (on average a quarter of a flight after it came back), which
is what keeps them a stream: let go together, with nothing to spread them,
they would rise and fall as one sheet. The bench's note reads "Liquid solver
needs WebGPU", and `heronJetHeightM` reads 0 (not measured).

The Peltier plant and its body colours are renderer-independent. The fallback
gets the same analytic Hartmann profile: the same closed-form parcels
(`mhdParcelPosition` is the CPU twin of the shader) and the same card. Its
markers are additionally tinted by `u/u(0)`, which the 16-byte WebGPU particle
has no room for.
