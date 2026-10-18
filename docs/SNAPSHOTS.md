# Plant snapshots (#224 §2)

A **plant snapshot** is the lab's simulated state at one instant — every device
plant, the SEG operator, the session clock and seed — as plain JSON. Restore one
and the live loop steps on from it exactly as the original run would have. It
is a save point for this model, **simulated, not metrology**: it records what
the classroom plants were integrating, not anything an instrument measured.

Uses: start an experiment from a steady operating point instead of spinning up
(an experiment's `snapshot` field, [`EXPERIMENTS.md`](./EXPERIMENTS.md), or a
`.lab.json` `state`), A/B two settings from the same point, take a telemetry
replay over and run it live, and E2E tests that skip a spin-up. The offline
experiment bench speaks the same format (`ExperimentBench.capture()` /
`restore()`); `test:experiments` checks that a bench restored from a snapshot
steps on bit-identically with the one it was taken from, on WASM and JS.

## API

```js
const snap = await window.lab.captureSnapshot();     // → PlantSnapshot (below)
const ok = await window.lab.restoreSnapshot(snap);    // → boolean
```

| Call | Signature | Notes |
|------|-----------|-------|
| `window.lab.captureSnapshot` | `() => Promise<PlantSnapshot>` | Lazy chunk (`src/session/lab-snapshot.ts`) — nothing here is in the entry bundle. |
| `window.lab.restoreSnapshot` | `(state: unknown) => Promise<boolean>` | Validates untrusted input (`parsePlantSnapshot`). `false` when it is not a snapshot, or the C++ plant refused its vector; the JS plants, operator and clock are restored either way. |
| `window.lab.loadConfig(file)` | — | A `.lab.json` with a `state` applies its `config` first, then calls `restoreSnapshot(state)` (`src/config/lab-file.ts`). `exportLabFile()` includes `state` from `captureSnapshot()`. |

Pure helpers (`src/session/plant-snapshot.ts`, Node-testable):
`saveDeviceState(id, physicsState) → Record<key, number>`,
`packDeviceState(id, physicsState) → Float64Array` (layout order, NaN = absent),
`loadDeviceState(id, physicsState, values) → keys written`,
`cppStateFromKeys(id, keyed, base?, prefix?) → Float32Array | null` and
`keysFromCppState(id, vector)` (JS ⇄ C++ cross-load), `parsePlantSnapshot(input)`.

## Snapshot JSON

```jsonc
{
  "format": "seg-plant-snapshot",
  "version": 1,
  "layoutHash": 562042932,          // PLANT_STATE_LAYOUT_HASH (0x21801834) of the writer
  "catalogHash": "81caf605beca",    // sha256(physics/devices.json)[:12], informational
  "backend": "js",                  // js | wasm | wasm-worker — who stepped the focus plant
  "focus": "seg",                   // plant focus (overview steps SEG)
  "view": "overview",               // selected view
  "t": 12.5,                        // session clock, s (telemetryHub.getSimTimeS)
  "seed": 4242,                     // getSimulationSeed(), null when unseeded
  "config": { "look": "lab" },      // non-default LabConfig share fields
  "speed": 1,                       // sim-rate multiplier
  "operator": {                     // SEGOperatorState incl. its smoothed outputs
    "status": "operational", "isRunning": true, "targetDrive": 1,
    "magneticFieldStrength": 1, "loadResistance": 100, "totalEnergy": 0,
    "efficiency": 90, "displayRpm": 3000, "displayField": 0.7,
    "physics": { "segOmega": 1, "corona": 1, "energyLevel": 1, "magneticFieldStrength": 1 }
  },
  "devices": {                      // every JS device plant, through its layout
    "vdg": { "vdgChargeC": 2e-6, "vdgVoltage": 150000, "vdgSparkAccum": 1, "…": 0 },
    "hall": { "hallCarrierType": 1, "hallFieldCoupledT": -1, "…": 0 }
  },
  "wasm": { "mode": 10, "values": [8.25, 0.73, "…"] }   // C++ focus plant (_time, _drive, fields), when it owns it
}
```

Values are numbers: `bool` → 0/1, `enum` → index into the field's `values`,
`nullable` → −1 for null (nullable fields are non-negative setpoints), NaN →
JSON `null`. `restoreSnapshot` ignores devices / keys this build does not
know, so a snapshot from an older catalog still loads what still exists.

## Where the layout comes from

Each device in `physics/devices.json` has a **`state`** block: the ordered list
of everything its step **reads before it writes** — integrators, timers,
phases, accumulators, smoothed outputs and setter-driven knobs — and the C++
plant field each maps to:

```json
"state": {
  "plant": "_vdg",
  "fields": [
    { "key": "vdgChargeC", "cpp": "chargeC" },
    { "key": "vdgSparkAccum", "cpp": "sparkAccum" },
    { "key": "energyLevel", "cpp": null },
    { "key": null, "cpp": "drive" }
  ]
}
```

`key` is the `DevicePhysicsState` key (null: C++-only), `cpp` the plant struct
field or `@member` path (null: TS-only; `@_rollers[].omega` + `count` for
arrays). `type` defaults to `number`; `bool`, `enum` (`values`) and `nullable`
(`cppNull`) say how to encode it. `clearOnLoad` lists derived geometry the next
step rebuilds (Halbach field lines). `npm run codegen:catalog` validates the
block (unique keys / paths, keys that exist on `DevicePhysicsState`, shapes)
and emits:

| Output | What |
|--------|------|
| `generated/device-state.ts` | `DEVICE_STATE_LAYOUT`, `PLANT_STATE_PREFIX`, `PLANT_STATE_LAYOUT_HASH`, `DEVICE_CATALOG_HASH` — lazy chunk only |
| `generated/plant-state.h` | `PLANT_STATE_LAYOUT_HASH`, `PLANT_STATE_SIZES[]` |
| `generated/plant-state-impl.h` | `SEGSimulator::plantStateSize / plantSave / plantLoad` (compiled by `cpp/src/plant/plant_state.cpp`) |
| `docs/MODE_MATRIX.md` | the *Snapshot state* table |

The layout hash is FNV-1a over the canonical JSON of every `state` block, so
**any** layout change — a field added, reordered, retyped — changes it.

## C++ / WASM

The C++ vector for a mode is `[_time, _drive, …fields]`; sizes run from 4
(solar) to 137 (SEG: 66 roller ω + 66 roller angles + 3 ring torques).

| Binding | Signature |
|---------|-----------|
| `SEGSimulator.plantStateSize(mode)` | `int` — 0 for an unknown mode |
| `SEGSimulator.plantSave(mode)` | `int` — writes the vector into the float scratch (`getScratchPtr`), returns its length |
| `SEGSimulator.plantLoad(mode, count, layoutHash)` | `bool` — reads `count` scratch floats; **refuses** a layout-hash mismatch, a wrong count or any non-finite value, leaving the plant untouched |
| `plant_state_layout_hash()` | free function — the hash this binary was built with |

Same scratch ABI as the energy bus — no `std::vector` crosses the boundary
(cpp/README.md → WASM ABI). JS side: `src/wasm/plant-state-io.ts`
(`savePlantState(sim, mode)` / `loadPlantState(sim, mode, values, hash)`).

## Backends

Restore and capture go to whichever instance steps the focus plant:

- **JS** (default) — device `physicsState` objects, through the layout.
- **In-loop WASM** (`?wasmPhysics=1`, `?plantWorker=0`) — the main-thread
  `segWasm` sim_core.
- **Plant worker** (`?wasmPhysics=1`, default) — the worker's own sim_core via
  a `plantSave` / `plantLoad` message pair (`src/session/plant-worker-snapshot.ts`
  over `PlantWorkerHost.snapshotPort()`). The worker handles messages in order:
  a save sees every batch already posted, a load lands before any later one.

Restore bumps `segOperator.epoch` and cancels the worker before writing, then
again after the C++ load, so a batch in flight from before the restore is
dropped rather than applied over it. When the snapshot's own vector matches
this build's layout hash and the focus mode, it is loaded as-is; otherwise (a
JS snapshot on a `?wasmPhysics=1` lab, another build) the focus device's keys
are **cross-loaded** onto the live C++ vector (`cppStateFromKeys`), so C++-only
fields keep their live values. With the C++ plant in charge, capture takes the
focus device's keys from its vector (`keysFromCppState`) — the worker's vector
can be a frame ahead of what the device shows.

Not captured: GPU particles and other visual-only state (pulse-coil
oscilloscope history, field-line geometry), camera, the energy-network edge
allocation (rebuilt next frame), hardware-twin link state. `config` is
recorded, not applied by `restoreSnapshot` — `.lab.json` applies it first.

## Replay take-over

Recording (**Record 10s**) also takes a snapshot keyframe every
`KEYFRAME_PERIOD_S` (2 s) of sample time; **Replay** writes them into the
`.seg-replay.json` as optional `keyframes: [{ t, snapshot }]` (`t` on the
sample clock, `time_s`). In the replay bar, **Take over** restores the keyframe
at or before the scrub cursor, leaves replay and runs live from there. Files
without keyframes (every older replay) load and play exactly as before; the
button just stays disabled. `REPLAY_VERSION` is still 1.

## Tests — `npm run test:snapshots`

Part of `npm run validate` and the `native-cpp` CI job.

1. **Native** `sim_core_test --mode snapshots`: every C++ mode — run A 90
   frames, save, load into a fresh B, step both 90 more → bit-identical every
   frame; a wrong hash, short vector and NaN are refused and leave B as it was.
2. **Shipped WASM** (`src/public/wasm`, in Node): the same for all 13 modes
   through the scratch ABI, plus the hash-mismatch refusal.
3. **TS plants** (all 16): save → JSON → load into a fresh state → step →
   every scalar field bit-identical, compared every frame (a missed spark
   accumulator diverges for one window and then re-converges), at four save
   points per plant.
4. **Cross-load** JS → C++ over every native golden case: JS runs the case's
   frames, its snapshot is cross-loaded into C++, both run the frames again →
   within the `test:golden` ε (rel 2e-4; the `transformerVp` zero-crossing
   override). Worst key today ~8e-5.

`npm run test:plant-worker` covers the worker message pair; one Playwright
test (`Plant snapshots (#224 §2)`) restores a steady operating point and checks
telemetry is there at once.

## Adding a field

Add it to the device's `state` block, run `npm run codegen:catalog`, rebuild
the WASM if a `cpp` path changed (`npm run wasm:build`, emsdk 3.1.64), and run
`npm run test:snapshots`. A field the step reads but the block misses shows up
there as a divergence.
