# Fluids and heat — what is solved, what is drawn

Four core benches are about moving liquid or moving heat: `heron`, `kelvin`,
`mhd`, `peltier`. This page says, per bench, which numbers come from a model
and which pixels are only a picture. It is updated as the fluids epic lands;
anything not listed as solved here is not solved.

Every plot and overlay these benches add carries the same line the rest of
the lab uses: **simulated, not a measurement**.

| Bench | Plant (authoritative numbers) | Picture | Solved in the picture? |
|-------|-------------------------------|---------|------------------------|
| `mhd` | The mean speed `Ū`, with wall friction and Lorentz braking **derived** from the Hartmann profile and the circuit; `V_oc = B·Ū·w` | Timelines on the **analytic Hartmann profile** at the plant's `Ū` and `Ha`, plus a profile card | Exact steady solution, evaluated — not a numerical flow solve |
| `heron` | Head ODE; exit speed from Bernoulli with a discharge coefficient and Darcy–Weisbach pipe friction | **WebGPU, in focus:** the jet as a simulated liquid (MLS-MPM), fed at the plant's exit speed, drawn as particles. WebGL2: ballistic droplets in SI, each on its own. WebGPU overview or `fluid=off`: stand-in droplets on a fixed path, labelled as such | The jet and its fall, yes. The vessels and the basin's own water, no |
| `kelvin` | Capacitive charging + spark; the droplet current scaled by the share of drops that land | Two streams of drops, one per Rayleigh–Plateau drop, each with the charge its ring induces, in the field of the rings and collectors. **WebGPU, in focus:** on the liquid solver. **WebGL2, in focus:** the same law on the CPU. Elsewhere: a train of drops under gravity alone | The drops' paths and what lands, yes. Break-up, air and the spark's channel, no |
| `peltier` | **1-D finite-volume leg**: 24 cells + cold block, two plates, heat sink (`ros23`) | Three bodies coloured by their node temperatures; sparse air parcels beside them | The temperatures are the model's. The air is illustrative |

The liquid solver (**MLS-MPM**, below) runs on two benches:
[Heron's fountain](#herons-fountain) and [Kelvin's dropper](#kelvins-dropper).

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

These are the most a tier may hold (`MPM_TIERS`). **What a bench asks for is
its `fluid` block in `physics/devices.json`** — solver, what of the bench is
simulated, a budget per tier, whether it is drawn as a surface, what WebGL2
draws instead, and what is idealised:

```json
"fluid": {
  "solver": "mpm",
  "what": "the two streams of charged drops between the drip tips and the collectors",
  "tiers": { "low": { "grid": 32, "particles": 2048 } },
  "draw": "particles",
  "fallback": "the same drops on the CPU: gravity and q·E in 1 ms steps",
  "model": "one particle per Rayleigh–Plateau drop: …"
}
```

A tier that is left out takes the next lower one's budget. `codegen:catalog`
checks the block, emits `generated/device-fluids.ts` (`DEVICE_FLUIDS`, which
the scenes size themselves from) and the
[Liquid solvers](MODE_MATRIX.md#liquid-solvers) table. Scale and time scale
are physics and stay in `physics/constants.json`. Heron takes the full tiers;
Kelvin one small size at every tier.

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
It is copied out asynchronously and never blocks a frame. Up to four sinks
can be set, and the profile carries what each one took (`sunkBy`): a particle
inside two goes to the first, so a collector listed before the floor gets its
own count.

### Charge

A particle can carry a charge (C), given by its emitter, and the solver can
hold up to four **conductors**: horizontal rings of charge, or points, each
with `kq` — Coulomb's constant times its charge, V·m, so that a sphere of
radius R at potential V has `kq = V·R`. A bench sets them every frame from its
plant's potentials. In `mpm-g2p.wgsl` a charged particle gets `q·E/m` added to
its velocity after the grid gather and before it moves; neutral liquid skips
the sum entirely.

- A ring is summed as 12 point charges, softened by the wire's radius. That
  is exact on the ring's axis and within 5 % of a 720-point ring a radius or
  more from the wire (`test:mpm-io`).
- A drop let go above a like-charged conductor keeps kinetic + `q·V` + `m·g·y`
  within 1 % of `m·g·(0.3 m)` through a pass a centimetre from it, in a field
  of megavolts per metre; `q·E = m·g` holds a drop still.
- The effect a Kelvin dropper shows: with drops at 5·10⁻⁵ C/kg falling 27 cm
  into a can whose rim is a like-charged ring, 79 of 79 land at 0 V, 72 at
  50 kV, 40 at 60 kV and none at 70 kV — the threshold is where `q·V` equals
  what the fall is worth.
- The force acts on particles, not through the grid, and charge does not move
  between particles or onto a wall. That is right for separate drops and for
  a pool that is drained as it lands; it would be wrong for a charged pool
  that is kept, whose charge belongs on its surface.

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

## Kelvin's dropper

`src/physics/kelvin-dropper.ts` (the drops' physics, shared by both
renderers), `src/fluids/kelvin-liquid.ts` (the solver's scene),
`src/kelvin-layout.ts` (where the parts are).

### What is drawn, and at what scale

Each column is a drip tip hanging from the supply beam, an induction ring
just under it, a clear fall and a collector can; each ring is wired to the
opposite collector. Until this epic each column also had three solid cans
stacked along the stream, which the decorative droplets fell straight
through, and the rings stood above them. They are gone.

| Quantity | Value | Source |
|----------|-------|--------|
| Metres per scene unit | 0.048 | `physics/constants.json` → `kelvin.metresPerSceneUnit` |
| Fall, tip to collector mouth | 0.385 m (0.28 s) | `KELVIN_APPARATUS` |
| Columns apart / ring radius | 0.24 m / 4.8 cm | `KELVIN_APPARATUS` |
| Drip tip bore, jet speed at full drive | 3.5 mm, 0.6 m/s | `kelvin.nozzleDiameterM`, `jetSpeedMaxMS` |
| Time scale | 1 (real time) | `kelvin.liquidTimeScale` |

### The model

- **Break-up is Rayleigh–Plateau, taken analytically.** A jet of diameter `d`
  goes unstable fastest at a wavelength of 4.508 `d`, and each wavelength
  closes into one drop: radius 0.945 `d` = 3.3 mm, 0.15 g, 38 a second per tip
  at full drive. A drop is one particle of that volume, released at that
  rate. Nothing pinches off on the grid — at these sizes it could not.
- **Charge.** A drop forms at the centre of its induction ring and takes the
  charge of a sphere of its radius at the ring's potential, `4πε₀·r·V`, up to
  the **Rayleigh limit** `8π·√(ε₀·γ·r³)` = 3.8 nC, beyond which a drop flies
  apart. The limit is reached near 10 kV; from there on every drop carries
  2.5·10⁻⁵ C/kg whatever the voltage. `V` is the plant's `kelvinV` plus any
  seed from the charge bus (ADR-0013).
- **Field.** Four conductors at the plant's potential (see
  [Charge](#charge)): the left ring at `+V`, the right at `−V`, and each
  collector's rim, as a ring of its radius, at the potential of the *opposite*
  ring — the cross-connection. So a stream is attracted back to its own ring
  and repelled by its own collector. A ring's `kq` is `V·R`, which makes the
  potential at its centre `V`.
- **Motion.** Gravity and `q·E/m`. On WebGPU the drops are lone particles of
  the solver, for which it is exact; on WebGL2 `stepKelvinDrops` integrates
  the same law in 1 ms substeps. The two agree on what lands (below).

### What it shows

With the plant held at a fixed potential, full drive, 5 s of flow:

| Potential | Landed / missed, solver on a GPU | CPU twin of the solver | WebGL2's CPU drops |
|-----------|----------------------------------|------------------------|--------------------|
| 0 V | all, in their own collectors | same | same |
| 50 kV | 356 / 0 | 356 / 0 | 845 / 0 (12 s) |
| 60 kV | 126 / 228 | 127 / 227 | 502 / 343 |
| 68 kV | 0 / 350 | 0 / 350 | 31 / 814 |

Every drop lands up to 50 kV; from about 54 kV the streams are thrown off
their collectors, and by 66 kV none land. That window sits on the plant's
60 kV breakdown **because the tip bore was chosen to put it there**: with a
2 mm bore the drops are lighter for their charge, are lost from 30 kV, and
from 50 kV do not even leave their own induction ring — the bench would
never spark. The mechanism is real (it is what limits a real dropper's
voltage); the number it happens at is a choice.

### Back to the plant

The share of drops landing over the last three seconds is written to the
plant as `kelvinCollectionEff`, and the plant scales its whole droplet
current — base rate and induction feedback — by it
(`setKelvinCollectionEfficiency` in C++, the same term in TS). The plant
publishes what it was charged with as **`kelvinLandedShare`**.

- It is measured **only while the bench is in focus**, on either renderer.
  Elsewhere, and in every headless run, it is "not measured" and the plant
  assumes everything lands, as it always did: `x · 1` is exact, and the golden
  cases have not moved.
- At full drive the plant sweeps from 54 kV to breakdown in about a twentieth
  of a second, a fifth of a drop's fall, so hardly a drop is caught in the
  window: 41 sparks a minute with the feedback or without it. **At low drive
  the plant dwells there**, and a slower jet is thrown off sooner. Over a
  minute on the plant and the CPU drops (`test:kelvin-liquid`):

  | Drive | Sparks, share fed back | Sparks, everything landing | Share landing |
  |-------|------------------------|----------------------------|---------------|
  | 100 % | 41 | 41 | 1.00 |
  | 50 % | 17 | 18 | 0.97 |
  | 25 % | 3 | 6 | 0.70 |
  | 20 % | **0** — stalls near 52 kV | 3 | 0.69 |

  So at a trickle the bench no longer sparks: it sits under breakdown with
  its streams splayed, which is what limits a real dropper.
- The plant's charging rate is a classroom compression: about twenty times
  what drops at the Rayleigh limit could carry at this flow. The drops' charge
  follows the plant's *voltage* through the induction law, not its current.
  The landing share is a ratio and is not affected.

### Limits

- **No break-up, no merging, no air, no drop-drop forces.** A drop is a point
  mass from the moment it leaves the tip.
- **The conductors are rings of charge at a potential**, not a solved
  boundary-value problem: no image charges, no field from the wires, the tips
  or the collectors' walls. The potential at a tip comes out 0.74 `V`, and the
  drop is still charged as if at `V`.
- **A drop that lands in the other collector counts as landed.** It should
  count against: it carries the wrong sign. The share is a count, not a charge.
- **The collectors do not fill.** A drop is taken at the mouth.
- **On WebGPU the drops fall behind the plant under about 15 fps** (the
  solver's substeps per frame are capped), and then see more of the plant's
  swing than they should and miss more. WebGL2's CPU drops keep the clock at
  any frame rate.
- **The spark** is the plant's event; its sprites are drawn while the plant
  says one is live. Nothing here models the discharge channel.
- **Stand-in drops** (WebGPU overview, `fluid=off`, `critical` tier): the
  Rayleigh–Plateau train under gravity alone (`posKelvin`), which shows the
  rate and the fall and nothing of the field.

### Tests

| Command | Holds |
|---------|-------|
| `npm run test:golden` | the plant with a landing share of 0.4: TS ≈ native C++ (2,587 V at 1.5 s against 10,516 V with everything landing) |
| `npm run test:kelvin-liquid` | Rayleigh–Plateau drop and rate; the Rayleigh limit and where it is reached; the scene against the drawn bench; the cross-connection's signs; the landing share against potential on the solver's CPU twin and on WebGL2's CPU drops, at 60 and 15 fps; the read-back window; the stand-in train and the shader's mirrored constants; the note's text |
| `npm run test:mpm-io` | the solver's part: ring field, energy of a charged drop, per-sink counts ([Charge](#charge)) |
| `npm run test:gpu-golden` (`golden-kelvin-liquid`, `golden-particles`) | the bench's own scene on a GPU: the counts in the table above, within six drops of the CPU twin (measured: one); the stand-in train against its TS twin (10⁻⁶ units), and as many drops in flight as the rate × the fall time |
| `npm run test:e2e:webgpu` | in the app: the solver steps Kelvin's drops in focus with no validation error, counts what lands, tells the plant; nothing of it exists in overview |

## MHD duct

### The model

The plant (`cpp/src/plant/mhd_plant.cpp`, TS twin `src/physics/mhd-duct.ts`)
integrates one state, the mean speed `Ū`:

```text
dŪ/dt = drive·pump − (friction + braking)·Ū            B = 0.2 T + 0.8 T·drive
friction = (ν/a²)·Φ(Ha)        Φ = Ha²·tanh Ha / (Ha − tanh Ha)
braking  = (σB²/ρ)·R_i/(R_i + R_load)                  R_i = w/(σ·2a·L)
V_oc = B·Ū·w      I = V_oc/(R_i + R_load)              Ha = B·a·√(σ / ρν)
```

**Neither rate is tuned.** Both are the gap average of the solution below:

- **Friction** is the profile's own shear on the two Hartmann walls per unit
  mass of the slot. `Φ` is 3 at `B = 0` (Poiseuille) and tends to `Ha` for thin
  layers: 16 /s at 0.2 T, 64 /s at 1 T.
- **Braking** is the force `B·I·w` on the current the circuit draws, per unit
  mass between the electrodes. Averaging `σ(E + u×B)×B` over the gap gives it
  for any profile, and the profile keeps its Hartmann shape whatever the load
  (a uniform `E` only shifts the driving term), so it holds at any current.
  Zero on open circuit, `σB²/ρ` on a short.
- **The fluid's resistance** is geometry: 0.25 mΩ between the electrodes.

Until step 7 of the epic the plant carried `lorentzK` = 2.5 and `frictionK`
= 0.8, tuned, and an internal resistance of 0.05 Ω — 200 times the fluid's.

What is still chosen is the pump and the load. The pump holds 800 kPa/m
(320 kPa across the electrodes; `pumpAccelMs2` = 920). The load is matched to
`R_i`, where a generator delivers most. At full drive that gives 1.44 m/s,
0.144 V open-circuit and 288 A: 20.7 W in the load of 46 W pumped. Low
voltage and a large current is what a liquid-metal generator is.

The rates are 44–640 /s, so a plant step is the exact exponential of the
linear equation, in both languages. Euler at 60 Hz would overshoot.

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

### The slice

`src/fluids/mhd-slice.ts` (sizes, units, the uniform block),
`mhd-slice-cpu.ts` (the CPU twin), `mhd-slice-solver.ts` (the WebGPU host),
`passes/mhd-slice-lbm.wgsl` and `mhd-slice-phi.wgsl`.

A D2Q9 lattice-Boltzmann solver — two-relaxation-time collision, Guo forcing,
half-way bounce-back walls — used two ways.

**Across the gap**, field in the plane, periodic along the flow: its steady
state is the Hartmann profile. This is what the kernel is tested on, and it
is where the plant's friction is checked numerically: the wall friction the
lattice has is `(ν/a²)·Φ(Ha)` within 1 % at `Ha` = 5 and 3 % at 20.

| `Ha` | Nodes across | Profile, L2 error | Mean speed / analysis |
|------|--------------|-------------------|-----------------------|
| 0 | 64 | 1·10⁻⁵ | 0.995 |
| 5 | 64 | 9·10⁻⁵ | 1.000 |
| 20 | 64 | 8·10⁻⁴ (the layer is 1.6 cells thick) | 1.001 |

**The mid-plane**, half-way between the Hartmann walls: x along the flow, z
between the electrodes, field out of the plane. 256 × 40 square cells of
2.5 mm — the duct's 0.1 m width and 0.64 m of its length, with the pole faces
and four electrode pairs over the middle 0.4 m.

- The velocity is the gap average. Friction on the Hartmann walls is the
  linear drag `(ν/a²)·Φ(Ha(x))`, the plant's own term, column by column as
  the field rises and falls.
- The Lorentz force is `σ(−∇φ + u×B)×B`, with the potential `φ` solved on the
  same grid from `∇·j = 0` (red-black over-relaxation, two sweeps a step).
- The side walls are insulating except on the electrode segments, which are
  equipotentials at `±V/2`. Each pair's `V` is moved every step towards its
  load times the current it collects; the generator's load is shared out to
  the pairs by length.
- **The plant stays the authority on how fast the duct runs.** Its mean speed
  is the slice's inflow, and the mean drag in each cross-section is balanced
  by a body force — the pressure gradient the pump supplies — so the lattice
  carries only the pressure that redistributes the flow.

What it shows that the plant's one number cannot (1 T, 1.44 m/s, matched
loads):

| | Plant (one ideal pair, uniform field) | Slice |
|---|---|---|
| Open-circuit volts | 0.144 | 0.140 on the two middle pairs, 0.117 on the end pairs |
| Current | 288 A | 241 A — the rest circulates round the ends of the electrodes |
| Profile entering the field | flat | thrown to the side walls: 1.7 m/s near them, 1.4 m/s on the centre line |

With the whole slice under the poles — no ends — every pair reads `B·ū·w`
within 2 %.

Limits, beyond the plant's:

- **Its lateral viscosity is the lattice's, not the fluid's**: 2.6·10⁻³ m²/s,
  three thousand times NaK's. The real side layers are a tenth of a
  millimetre; here they are two or three cells. The core, the potential and
  the currents do not depend on it; the width of the wall jets does.
- **Speeds are good to about 4 %.** The lattice's own friction on the side
  walls is not in the balance the body force makes, so the density falls
  2–4 % along the duct and the speed rises to match.
- **Quasi-two-dimensional.** The Hartmann layers are a drag term, valid when
  they have formed; the flow between them is taken as uniform across the gap.
- **The field's edge is a tanh over four cells (1 cm)**, not a computed
  fringe field, and it has no component along the flow.
- **Not yet drawn.** The solver is tested; the bench does not run it yet.

### Units and scale

| Quantity | Value | Source |
|----------|-------|--------|
| Half-gap `a` (between the Hartmann walls, along `B`) | 0.5 mm | `physics/constants.json` → `mhd.halfGapM` |
| Electrode spacing `w` | 0.1 m | `mhd.widthM` |
| Electrode length along the flow | 0.4 m | `mhd.lengthM` |
| Fluid's resistance between the electrodes / load | 0.25 mΩ / 0.25 mΩ | derived / `mhd.rLoadOhm` |
| Working fluid | `σ` = 10⁶ S/m, `ρ` = 870 kg/m³, `ν` = 8·10⁻⁷ m²/s (NaK-like) | `mhd.*` |
| Hartmann number | ≈ 18.95 per tesla → **3.8 at 0.2 T, 19 at 1.0 T** | derived |
| `Re/Ha` at steady state | at most 173 over the drive range | `test:hartmann` |

The duct is a thin slot on purpose. The gap was 5 cm until this epic, which
made `Ha` 380–1900: a slug at every field setting, with nothing for the
profile to show. At 0.5 mm the aspect ratio is 100:1, so the 1-D solution is
the right one, `Re/Ha` stays below the Hartmann-layer transition (≈ 380), and
`Ha` spans the range where the profile visibly changes.

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
- **The plant assumes the profile has formed.** Its friction is the steady
  profile's. A start-up has more wall shear until the profile develops
  (`a²/ν` ≈ 0.3 s at `B` = 0, milliseconds under a strong field).
- **One electrode pair, uniform field.** No current leaking round the ends of
  the electrodes, which costs a real generator part of its output.
- A timeline is re-released as a whole when its centre reaches the outlet, so
  the slow wall markers of an old line vanish mid-duct. That is the
  stroboscope, not the fluid.

### Tests

| Command | Holds |
|---------|-------|
| `npm run test:hartmann` | profile vs the textbook form, limits, unit mean, wall shear; C++ twin vs TS; parcels keep lanes and move at `u(y)`; `Ha` range and `Re/Ha` for the catalog constants; overlay curves; the derived balance: friction against the profile's slope at the wall, braking against `B·I·w`, pump power = friction + `I·V_oc`, the exact step at any step size, C++ rates against TS |
| `npm run test:golden` | the two plants agree on speed, voltage, current and power |
| `npm run test:mhd-slice` | the slice's CPU twin: uniform block and velocity set against the WGSL; the grid to scale; the Hartmann profile at `Ha` = 0, 5, 20; the lattice's wall friction against the plant's; open and loaded electrodes, Ohm's law on each load, the wall jets with and without the field |
| `npm run test:gpu-golden` (`golden-mhd-slice`) | the WGSL on a GPU: the profile at `Ha` = 0, 5, 20 (L2 under 2 %), mass to 1e-5 per 1000 steps, the mid-plane against the CPU twin step for step, open-circuit volts against `B·ū·w` within 3 % |
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
atomics. Kelvin does not need it: its drops never touch, so the CPU steps the
same law (`stepKelvinDrops`) and the bench behaves as on WebGPU, landing
share and all. Heron's droplets there are ballistic in SI (`stepParticles`, mode 1 in
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
