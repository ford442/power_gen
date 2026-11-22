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
| `heron` | Head ODE + Bernoulli + Swamee–Jain friction | Closed-form droplet paths (WebGPU), ballistic droplets (WebGL2) | No |
| `kelvin` | Capacitive charging + spark | Independent droplets; charge does not deflect them | No |
| `peltier` | **1-D finite-volume leg**: 24 cells + cold block, two plates, heat sink (`ros23`) | Three bodies coloured by their node temperatures; sparse air parcels beside them | The temperatures are the model's. The air is illustrative |

A liquid solver now exists (**MLS-MPM**, below) and is tested on its own. No
bench runs it yet: `heron` and `kelvin` still draw the closed-form droplets in
the table until their steps of the epic land.

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

The `fluid=` flag itself arrives with the first bench that uses the solver.

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
- **Box walls only**, free-slip. Boundaries from the props (signed-distance
  fields), emitters, sinks and a body-force hook are not in yet.
- **Points, not a surface.** Screen-space surface rendering is a later step.
- **WebGPU only.** There is no WebGL2 liquid solver and there will not be
  one; `MpmCpu` is a test reference, far too slow to stand in.
- **The frame cost is unmeasured.** The epic's target is ≤ 2 ms of GPU time
  on an integrated GPU at the default tier. Tests here run on a CPU
  rasteriser, which cannot tell.

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
| `npm run test:pipelines` | the three pipelines compile against the `mpm` layout |

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
C++ Jacobian comes from one Dual evaluation, the TS one is written out
(`peltierJacobian`, checked against differences).

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

The Peltier plant and its body colours are renderer-independent. The fallback
gets the same analytic Hartmann profile: the same closed-form parcels
(`mhdParcelPosition` is the CPU twin of the shader) and the same card. Its
markers are additionally tinted by `u/u(0)`, which the 16-byte WebGPU particle
has no room for.
