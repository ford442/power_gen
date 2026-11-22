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
| `peltier` | Two thermal nodes | A hand-steered convection loop | No |

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

## WebGL2

The fallback gets the same analytic profile: the same closed-form parcels
(`mhdParcelPosition` is the CPU twin of the shader) and the same card. Its
markers are additionally tinted by `u/u(0)`, which the 16-byte WebGPU particle
has no room for.
