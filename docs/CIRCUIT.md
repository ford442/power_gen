# Circuit Lab

Wire a bench into a circuit you draw (resistors, capacitors, inductors,
diodes, switches, sources and meters) and watch the bench and the circuit
drive each other. The circuit is solved by a small SPICE-like C++ solver in
`sim_core.wasm`. The decision record is [ADR-0018](adr/0018-circuit-lab.md),
and the issue is #256.

**Simulated, not metrology.** A bench port is a lumped model, and each
port's one-line `model` says what is idealised (table below).

## Opening it

- The **Circuit** button in the Telemetry Export row, beside Experiments.
- `window.lab.openCircuit()` from the console.
- A link: `?circuit=<example id>` opens an example. Share links (`#lab2=`)
  and `.lab.json` files carry the whole netlist (LabConfig field `circuit`,
  [`LAB_CONFIG.md`](LAB_CONFIG.md)).

### Teacher links

| Link | What it shows |
|---|---|
| `?labMode=lab&mode=transformer&circuit=transformer-bridge-rc` | The secondary → four-diode bridge → 470 µF ∥ 100 Ω. The scope shows ≈ 0.75 V p-p of 120 Hz ripple on ≈ 6.7 V, plus a diode's current pulses. |
| `?labMode=lab&mode=homopolar&circuit=homopolar-bridge-rc` | The disc → Schottky bridge → 2.2 mF ∥ 4.7 Ω. The disc is a DC source, so there is almost no ripple: the bridge only fixes polarity. Its current brakes the disc. |
| `?labMode=lab&mode=pulse-coil&circuit=pulse-coil-ring` | A 2.2 mF capacitor at 24 V, switched at 50 ms across the coil. It rings at ≈ 97 Hz (series RLC with the coil's own R and L), and the armature feels ⟨i²⟩. |
| `?circuit=rc-step` | A 5 V square wave → 1 kΩ / 1 µF low-pass (τ = 1 ms). |
| `?circuit=rlc-ring` | Series RLC from a capacitor charged to 10 V (f ≈ 503 Hz, Q ≈ 31.6). |

Press **START** so the plant clock runs; the scope runs with it. Agents
without a GPU add `&renderer=webgl2`: the circuit solves on WebGL2 too.

## The wiring view

| Area | What it does |
|---|---|
| **Header** | Examples menu, **New** (an empty sheet with ground), **.cir** (SPICE export), **Import** (SPICE), × (or Esc). |
| **Palette** | R, C, L, diode, switch, V and I sources, voltmeter, ammeter, ground, and one **⎓ glyph per bench port** in the catalog. Drag a part onto the sheet. |
| **Sheet** | Drag a part to move it. Click a terminal, then another, to wire them. Click a part or wire to select it. **Delete** / Backspace removes the selection; **R** rotates a part a quarter turn. |
| **Inspector** | The selected part's values, typed with SI prefixes (`4.7k`, `100n`, `2.2m`, `1meg`, `10µ` or `10u`). Also a V / I source's waveform (DC, SIN, PULSE), a name for each terminal's node, and the part's live i / v / p. |
| **Meters** | Every voltmeter and ammeter, each bench port's power (what crosses its terminals), and the energy books' residual. |
| **Scope** | Two channels of any `circuit.*` key, with a rising-edge trigger on channel 1 and a span from 5 ms to 1 s. **Send to analysis** hands the buffer to the uPlot analysis panel as a run ([`ANALYSIS.md`](ANALYSIS.md)). |

A value edit on a running circuit is applied live: the run continues from
where it is. A capacitor keeps its voltage and an inductor its current (a
coupling's `k` too), and charge and flux follow from the new value. The
energy the edit adds or removes lands between two windows of the books,
not inside one. A topology edit (adding, removing or rewiring a part)
recompiles the netlist and restarts the circuit from its initial
conditions. Deleting an inductor also deletes the couplings that name it.

**Keyboard.** A palette button pressed with Enter or Space places its part
on a free spot and focuses it. Tab walks the parts and terminals. Enter or
Space on a part selects it; on a terminal it starts or finishes a wire, and
Esc cancels a wire in progress. The arrow keys move the selected part; R
rotates it and Delete removes it.

If the solver stops mid-run (a singular matrix, or a step that will not
converge), the status line says why. The circuit is detached, the wired
benches go back to their own physics, and the sheet stays as it was, so a
value can be fixed and the circuit reloaded.

Coupling (K), VCVS (E), VCCS (G) and the level-1 MOSFET (M) are solver
elements without a palette entry. They arrive in a document or a link; K
also arrives through SPICE import.

### Without `sim_core.wasm`

The solver has no TypeScript mirror. If `sim_core.wasm` did not load (the
header badge reads "WASM failed"), the wiring view opens **read-only** with
a "needs WASM" note. The netlist still compiles, so links, `.lab.json` and
`.cir` export keep working. This is about sim_core, **not** `?wasmPhysics=`:
sim_core loads at boot on both renderers, and `wasmPhysics` only picks the
plant backend ([`WEBGL2.md`](WEBGL2.md), [`MODE_MATRIX.md`](MODE_MATRIX.md)).

## Elements

| Kind | Terminals | Parameters (doc names) |
|---|---|---|
| R resistor | a, b | `r` Ω |
| C capacitor | a, b | `c` F, `ic` V (initial voltage) |
| L inductor | a, b | `l` H, `ic` A (initial current) |
| V voltage source | p, n | `w`: `dc` (`dc`), `sin` (`off amp f ph td damp`), `pulse` (`v1 v2 td tr tf pw per`) |
| I current source | p, n | as V; the current flows p → n through the source |
| K coupling | — | `a`, `b` (two inductor ids), `k` 0 … 0.999 |
| E VCVS | p, n, cp, cn | `gain` |
| G VCCS | p, n, cp, cn | `gm` S |
| D diode | a, k | `is` A, `n`, `rs` Ω |
| S switch | a, b | `ron`, `roff` Ω, `closed` 0/1, a clock: `period` (0 = manual), `duty`, `delay` |
| VM voltmeter | +, − | — (no element: reads v₊ − v₋) |
| AM ammeter | in, out | — (a 0 V source) |
| M MOSFET level 1 | d, g, s | `pol` (+1 N, −1 P), `vt` V, `kp` A/V², `lambda` 1/V |
| GND | g | — |
| PORT | +, − | `dev`, `port`: a catalog bench port |

Sign conventions: an element's current runs from its first terminal to
its second, and its power is the power it absorbs. A source delivering
power therefore reads negative.

### Bench ports

These come from `physics/devices.json` `ports`, and the drivers live in
`src/circuit/ports.ts`. The generated table, with each port's model line,
is in [`MODE_MATRIX.md` → Circuit Lab ports](MODE_MATRIX.md#circuit-lab-ports).

| Port | Inside the port | Circuit → bench |
|---|---|---|
| `homopolar.out` | V = k·ω (k = ½·B·r²), the disc's R and L | the disc is braked by k·ī, with its own drive and drag |
| `transformer.sec` | the 60 Hz generator (28 V pk × drive) → R_p → L_p, K-coupled to L_s + R_s | your circuit replaces the 12 Ω load |
| `pulse-coil.coil` | the coil's R and L | the armature's pull ∝ ⟨i²⟩; your C and switch replace the bank and auto-fire |

While a circuit owns a bench, its port driver steps the bench once per
plant substep, and that bench's own JS or C++ plant does not. A bench is
never stepped twice. Replay freezes the circuit. Leaving replay, or an
operator RESET, puts the circuit back at its initial conditions.

## Energy

Per window, the host keeps the books: W_source − W_dissipated − ΔE_stored,
with ΔE the true ½Cv² + ½Li² + M·i₁i₂ change, over an exponential 1 s
window. The **residual** is the gap divided by the energy moved. It is
Tellegen's theorem on the discrete solution, so what remains is the
trapezoid's O(h³): ≈ 1e-4 for the examples.

In the overview, the energy network shows the circuit's port edges as
**solved** (Σ v·i), with their residual. A port's power is what crosses its
terminals: minus Σ v·i over the port's own internal elements. A bench's
winding losses and stored field are not counted as delivered, so an open
transformer secondary reads 0 W while its generator still feeds the
primary. A 3-D cable runs from each wired
bench, its flow ∝ the port's rms current. The disclaimer lists the edges
that are still **estimated** (nameplates × activity).

## Experiments

[`EXPERIMENTS.md`](EXPERIMENTS.md) covers the format. A circuit experiment
sets `config.circuit` to an example id or a document, and its keys are
checked against the compiled netlist:

- **record**:
  - `circuit.node.<name>.v`, where the name comes from `n` (or is `gnd`);
  - `circuit.elem.<id>.i|v|p`;
  - `circuit.port.<id>.p`;
  - `circuit.residual`.
- **set / ramp / sweep**: `circuit.elem.<id>.<param>`, for example
  `circuit.elem.C1.c`.

There are two reference experiments:

- `rectifier-ripple-vs-c`: transformer → bridge → RC. It sweeps C over a
  decade and fits ripple p-p ∝ Cᵇ with b ≈ −1 (measured −1.02).
- `pulse-coil-rlc-resonance`: it sweeps C over a decade and fits the ring
  frequency ∝ Cᵇ with b ≈ −½ (measured −0.506). The 0.47 mF ring must be
  within 1 % of ½π·√(1/LC − (R/2L)²).

Both keep the residual under 1 %. They need `sim_core.wasm` and run the
C++ solver on both experiment backends.

## Netlist document

```jsonc
{
  "v": 1,
  "title": "Square wave → RC low-pass",
  "e": [                                   // elements
    { "id": "V1", "k": "V", "x": 2, "y": 4, "rot": 1,
      "p": { "w": "pulse", "v1": 0, "v2": 5, "pw": 0.005, "per": 0.01 } },
    { "id": "R1", "k": "R", "x": 4, "y": 2, "p": { "r": 1000 } },
    { "id": "C1", "k": "C", "x": 10, "y": 4, "rot": 1, "p": { "c": 1e-6 } },
    { "id": "G1", "k": "GND", "x": 6, "y": 10 }
  ],
  "w": [["V1.0", "R1.0"], ["R1.1", "C1.0"], ["V1.1", "G1.0"], ["C1.1", "G1.0"]],
  "n": { "in": "V1.0", "out": "C1.0" },    // node names (a terminal on the node)
  "scope": ["circuit.node.in.v", "circuit.node.out.v"],
  "opt": { "maxStep": 1e-4 }               // maxStep minStep reltol vntol abstol gmin maxNewton lteReltol
}
```

- A terminal ref is `<id>.<index>`, in the order of the element table.
- A bench port is `{ "id": "P1", "k": "PORT", "dev": "transformer", "port":
  "sec" }`, wired like any two-terminal part (`P1.0` is +). A bench takes
  one port: a second PORT on the same `dev` is refused.
- `x`, `y` are grid cells and `rot` is quarter turns.
- Unknown kinds, bad refs, duplicate ids and out-of-range values are
  refused with a message. A terminal index is written plainly: `R1.0`, not
  `R1.00`.

`src/circuit/netlist.ts` compiles the document to the packed solver format:
`[FORMAT_VERSION, nodes, elems, nOpt, options…, per element: kind, nTerm,
terminals…, nParam, params…]`, in f32. Inside the solver, everything is
double. The limits are 96 nodes and 256 elements.

## SPICE

- **Export (`.cir`)** covers every kind. Diodes and MOSFETs get a
  `.model`. A switch exports as a resistor at its current state; a clocked
  switch exports open, with its clock in a comment. A bench port becomes a
  comment: put your own source there. The file ends with `.tran … UIC` and
  `.end`.
- Export gives every card a name that is unique as SPICE compares names
  (ignoring case), and generated node names never take a name the document
  uses.
- **Import** covers R, L, C, V, I (DC / SIN / PULSE), D with `.model D(IS
  N RS)`, and K. The first line is the title. Suffixes ignore case, as in
  SPICE: `M` means milli, `10U` is 10 µ, and `1F` is 1 femto, not 1 farad.
  Anything else is skipped with a warning (for example a `Q` transistor or
  a subcircuit).

## Fidelity and known limits

- The homopolar disc is a DC source, so a bridge on it shows almost no
  ripple. The ripple experiment and the ripple teacher link use the
  transformer instead.
- The free-running homopolar plant's own load torque is I·B·r/2. That does
  not match its EMF ½·B·ω·r², which implies ½·B·r²·I. The port uses
  k = ½·B·r² both ways, so its books close. The unwired plant is unchanged.
- While wired, the pulse coil's peak-current readout is approximate: the
  larger of the end-of-substep |i| and the substep's rms.
- Ports are lumped: no winding capacitance, no core saturation, no brush
  drop.

## Tests

`npm run test:circuit`, which is part of `test:unit` and so of `validate`:

- **Native goldens**:
  - RC τ;
  - RLC f / Q;
  - half-wave ripple;
  - transformer ratio;
  - lossless-LC energy within 1e-4 over 1000+ periods;
  - flyback;
  - bridge;
  - VCVS, VCCS, MOSFET.
- **WASM replay** of every golden onto the native trajectory. LC energy
  and RLC Q are judged again on the WASM trace.
- **TS units**: SI values, the compiler, keys, SPICE, the host, links.

`npm run test:experiments` runs the two reference experiments. `make native`
(`npm run wasm:native`) prints the golden table to `cpp/build/circuit.txt`.
