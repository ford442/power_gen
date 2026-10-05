# ADR-0013: Lab charge coupling (optional VdG → Kelvin seed)

- **Status:** Accepted
- **Date:** 2026-09

## Context

The lab has two electrostatic benches, Kelvin's Thunderstorm and the Van de
Graaff. Both build voltage by charge separation and both discharge across a
spark gap, and they sat side by side with no link at all. ADR-0011 said so and
said why: they share no B, so a `FieldNetwork` edge between them would claim a
magnetic coupling that does not exist. A charge/voltage bus was deferred as "a
different model".

The model the link needs is small. A Kelvin dropper never starts from exactly
zero: droplets are charged by induction from the inductor rings, and the rings
start from whatever small imbalance is around. That is the classroom trick — a
charged rod held near one inductor sets the polarity and gets the dropper going
faster. A charged Van de Graaff sphere on the next bench is exactly such an
object. Both plants already carry lumped nodes, leakage and breakdown; the
coupling only has to move one number from one to the other.

The same honesty constraints as ADR-0011 apply, harder:

- **The source is an estimate.** The VdG sphere voltage is a lumped Q/C with a
  classroom breakdown field. The potential it makes at the Kelvin bench is an
  estimate of an estimate.
- **The isolated bench is a legitimate default.** A dropper that climbs from its
  own imbalance is the first lesson; a seeded one is the second.
- **Three buses, three claims.** Watts (ADR-0004), tesla (ADR-0011) and volts
  here are different quantities with different failure modes. One switch for
  all three would let a class that wanted coupled pipe watts silently also get
  a seeded Kelvin.

## Decision

Ship an **optional** charge bus, `ChargeNetwork`
(`src/renderers/shared/charge-network.ts`), on its **own** switch:
`?chargeCoupling=1`, `localStorage seg-charge-coupling`, or the *Lab charge
coupling* checkbox in the operator and debug panels.

1. **Off by default.** Kelvin and the VdG keep their isolated voltages;
   `kelvinSeedCoupledV` is `null` and both plants run the math they always ran.
2. **A third sibling flag.** Not folded into `energyCoupling` or
   `fieldCoupling`, and none of the three implies another —
   `?chargeCoupling=1&fieldCoupling=1&energyCoupling=1` turns on exactly three
   buses, `?fieldCoupling=1` turns on one. `scripts/test-lab-coupling.mjs` and
   the e2e suite both check the flags are independent.
3. **One edge, one direction: `vdg → kelvin`.**

   | Edge | Source | Destination | Estimate | Clamp |
   |------|--------|-------------|----------|-------|
   | `vdg` → `kelvin` | `vdgVoltage` | `kelvinSeedCoupledV` | `V_sphere · r_sphere / d` | `0 … kelvinVbreak` (Kelvin's own breakdown, 60 kV) |

   `r_sphere / d` is the potential of an isolated charged sphere at distance
   `d` from its centre. `r_sphere` is the VdG catalog radius (0.14 m); `d` is a
   **declared** classroom bench separation, `chargeCoupling.vdgToKelvinSeparationM`
   = 1.0 m in `physics/constants.json`. Not the scene layout distance, and not
   a measurement. At the VdG's own breakdown (150 kV) the seed is ≈ 21 kV, about
   a third of Kelvin's breakdown, so the clamp exists but rarely binds.

   *Why this direction:* it is how a real dropper is seeded, and it needs no
   wire. The reverse, `kelvin → vdg` (dropper terminal feeding belt current or
   leakage), would need a conductor and a current path the lab does not model.
   Wiring both at once would close a loop whose residual nobody accounts for, so
   `assertChargeGraph` rejects a two-way pair and a second source per
   destination.
4. **The seed biases induction; it is not a charge source.** In both plants the
   Kelvin induction term becomes

   `dV/dt = drive · (chargeRate + feedback · (V + V_seed)) − leak · V`

   The inductor rings see their own voltage plus the external potential. With
   no water flowing (`drive = 0`) the seed does nothing. With water flowing,
   Kelvin **charges faster, sparks sooner, and settles higher below the
   runaway threshold**. That is the documented direction.
5. **A pre-step write, not a second ODE.** `LabSession.stepPlant` runs, in
   order: `ChargeNetwork.update()` → `FieldNetwork.update()` → plant step.
   Energy accounting stays in `publishFrame` after the step, because it reads
   plants and never writes them. The two coupling buses write disjoint keys and
   neither reads the other. Under `?wasmPhysics=1` `syncWasmFocusKnobs` pushes
   the same seed across the bridge (`setKelvinSeedV`). The C++ plant clamps it
   to its own `vBreak`, and a negative V clears it.
6. **The source keeps charging off-focus.** In a focus view the backends only
   step the focused bench, so with Kelvin focused the VdG sphere would freeze
   at the voltage it had when the view changed, usually 0. While charge
   coupling is on and a destination is focused, `LabSession` steps each live
   source's JS plant physics-only over the same substeps. The source is never
   the focused device, so nothing double-steps; the JS VdG plant is
   golden-matched to the C++ one.
7. **Named in the UI.** The operator panel line `#chargeCouplingSource` names
   the source device, the sphere voltage and the seed, with "simulated, not
   calibrated kilovolts". The overview line `#chargeCouplingDisclaimer` sits
   above the field line and uses the same voice: "simulated V·r/d estimate,
   not a Laplace solve and not calibrated kilovolts". The hub carries the bus
   as `snapshot.chargeNetwork`.

## What this is not

It is not Maxwell, and it is not a Laplace solve. The `r/d` estimate ignores the
floor, the dropper's own buckets and rings, and every image charge. It is the
far-field potential of a lone sphere, used as an order of magnitude.

It is not a spark-gap SPICE net. There is no circuit, no ngspice, no
node-voltage solve, and no current flows between the benches. One lumped
number is copied into another lumped plant before it steps.

It is not a claim of calibrated kilovolts. Neither plant's voltage is measured,
and a museum spark is not a voltmeter. The seeded Kelvin voltage is a third
simulated number.

It does not merge the buses. The energy, field and charge graphs keep separate
switches, separate modules and separate disclaimers.

## Riders: the other two graphs

Two gaps on the older buses closed alongside this one.

- **`homopolar` → `hall` field edge.** The Faraday disc's axial B (0.55 T,
  within the Hall bench's 0.65 T clamp) is a real source estimate. A Hall strip
  sits in one magnet gap at a time, so `FieldNetwork` now enforces **one live
  source per destination, in table order**. `halbach-viz` keeps priority, and
  `homopolar` owns the strip only while Halbach is switched off. The losing
  edge reports `shadowedBy` and writes nothing, so a disabled or shadowed edge
  can never clobber the owner's setpoint. Before this rule, a second edge into
  one destination would have silently overwritten the first. SEG does not also
  drive Hall.
- **Catalog-driven energy pipes.** The pipe graph moved from the hand-written
  `ENERGY_PIPE_EDGES` array to `physics/coupling.json`. `npm run
  codegen:constants` emits `generated/lab-coupling.ts` for `EnergyNetwork` and
  `generated/lab-coupling.h` for the native `--mode energy-network` smoke. The
  smoke used to mirror 9 of the edges by hand and now walks the whole graph,
  dropping JS-only endpoints the way `sim.ts` does. A new pipe names a
  `nameplate` rather than a number, and codegen fails if that nameplate does
  not exist, so a bench with no honest watt figure gets no pipe:
  - `homopolar → hall` (30 W, Hall nameplate): a Faraday disc is the textbook
    low-voltage, high-current source for a Hall strip.
  - `transformer → vdg` (60 W, VdG nameplate): the belt motor runs off the
    bench supply. This is the motor's draw, not watts reaching the sphere.
  - `pulse-coil`: originally **skipped**. It had no nameplate. Its bank stores
    ≈ 2.5 J per shot, and turning that into watts needs a repetition rate.
    *Amended:* the plant's recharge time constant and fire threshold are now
    catalog constants (`pulseCoil.chargeTauS`, `fireFraction`). The nameplate
    is the peak power of that exponential recharge, `C·V²/(4τ)` ≈ 3.6 W, which
    bounds the average draw whatever charge is left after a pulse. A
    `seg → pulse-coil` pipe carries it (ADR-0004). The old hand-set 90 W
    `DEVICE_NOMINAL_WATTS['pulse-coil']` budget override was removed, so the
    bench has one number instead of two.

## Goldens

`--mode golden` now covers Kelvin, which the golden had never compared. There
are two cases, `kelvin` (isolated) and `kelvin-seeded` (`kelvinSeedV=12000`,
standing in for a sphere at ~86 kV through `r/d = 0.14`). Both run 90 frames at
drive 0.5, which stays below breakdown (≈ 11 kV vs ≈ 43 kV). The compared row is
the charging curve, not the frame a spark lands on, and a plant that ignored
the seed could not accidentally agree. The JS side is the shared
`stepDevicePhysics`, wrapped under the golden's create/step names. `V + 0` is
exact in float and double, so the default path of both plants is bit-for-bit
what it was.

## WASM artefact lag

Same policy as ADR-0011. `setKelvinSeedV` reports whether the loaded binary took
the seed. When it did not (a checkout running a CI artefact older than the
knob), `wasmOwnsJsDevicePhysics` hands Kelvin back to the JS plant, which honours
the seed, and warns once. It does not report a C++ voltage that ignored the
seed under a panel that names one.

## Consequences

- **Positive:** The last "deferred" pair in the gallery is a documented, opt-in
  feature. Kelvin gets its first JS ⇄ C++ golden. The overview energy graph now
  reaches the VdG and the Hall bench. Energy pipes have one source of truth
  across TS and C++.
- **Negative:** A third coupling flag to explain, and a third place to over-read
  a simulated number as a measurement. This is mitigated by naming the source
  and the estimate everywhere the seed is shown. The off-focus source step adds
  one lumped-ODE step per frame, and only while charge coupling is on with
  Kelvin focused.
- **Neutral:** No WGSL change. Pipes draw whatever `ENERGY_PIPE_EDGES` holds,
  and the seed reaches the Kelvin shaders through `kelvinVoltageN` like any
  other voltage. WebGL2 gets the bus for free through the shared plant.
