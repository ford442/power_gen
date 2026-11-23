# Claude / agent checklist — SEG WebGPU Visualizer

**Canonical architecture:** [`docs/AGENTS.md`](docs/AGENTS.md)  
**ADRs:** [`docs/adr/`](docs/adr/)  
**Live demo:** https://ford442.github.io/power_gen/

## Entry (read this first)

| Item | Path |
|------|------|
| HTML | `src/index.html` |
| Bootstrap | `src/main.ts` |
| WebGPU | `src/multi-device-visualizer.ts` |
| WebGL2 | `src/renderers/webgl2/` |
| Select backend | `src/renderers/renderer-selector.ts` |
| Device layout | `src/devices/device-config.ts` |
| ADRs | `docs/adr/` |

Vite **`root: 'src'`**. There is **no** root-level app tree and **no** `SEGVisualizer`.  
**Contributor map:** `docs/AGENTS.md` (query params, language roles, device fidelity).

## Run

```bash
npm install
npm run dev          # http://localhost:5173/  (https: false; localhost is fine for WebGPU)
```

| Goal | URL |
|------|-----|
| No GPU / agents | `http://localhost:5173/?renderer=webgl2` (required — default WebGPU hard-fails without GPU) |
| WASM plant | `?wasmPhysics=1` |
| Mock hardware | `?mockHardware=1` (add `&mockParamError=0.2` for a ±20 % rig to **Calibrate** against — ADR-0019) |
| Lab audio | `?audio=1` (silent until your first click/keypress; header badge mutes) |
| Circuit Lab | `?circuit=transformer-bridge-rc` (with `&mode=transformer`); examples in `src/circuit/examples.ts`, docs/CIRCUIT.md |
| Showroom / Lab / Twin | `?labMode=showroom\|lab\|twin` (header buttons; remembered). Explicit flags win: kiosk `?labMode=showroom&look=drama&audio=1`, class `?labMode=lab&class=1`, bench `?labMode=twin` |

Default boot no longer falls back to WebGL2. Probe: `window.webgpuProbe`.

Full query matrix: **docs/AGENTS.md → Query-parameter matrix** (generated).

**New flag or remembered preference?** Add a row to `config/lab-config.json`,
run `npm run codegen:lab-config`, and read it with `labConfig()` from
`src/config/lab-config.ts`. Never read `location.search` / `location.hash` /
`localStorage` directly — `npm run lint` fails CI on it. Share links are
`#lab2=` (old `#lab=v1` still loads); `.lab.json` drops onto the page.
Details: **docs/LAB_CONFIG.md**.

## Dual renderer

| Path | Class | Backend |
|------|--------|---------|
| Primary | `MultiDeviceVisualizer` | WebGPU + WGSL |
| Fallback | `WebGL2MultiDeviceVisualizer` | WebGL2 + GLSL |

Shared CPU physics: `src/renderers/shared/`. Plant host: `src/session/`. Gaps: **docs/WEBGL2.md**.  
Hooks (both renderers): `window.currentRenderer`, `window.getRendererInfo()`, `window.captureCanvasFrame()`.  
WebGPU also: `window.__gpuErrors` (every GPU error, counted), `window.simulateDeviceLost()`, `multiVisualizer.frozenTime`.

## Language roles (short)

| Use | For |
|-----|-----|
| **JS** | WebGL2, procedural geometry builders (`seg-geometry/**`) |
| **TS** | Bootstrap, visualizer, registry/config, constants, WASM bridge, scientific-ui, debug-panel, SEG focus chrome |
| **C++/WASM** | Optional plant (`?wasmPhysics=1`) |
| **WGSL** | WebGPU shaders (`src/shaders/`) |
| **GLSL** | WebGL2 only |

Details: docs/AGENTS.md → Language strategy. Shaders: **docs/SHADERS.md**.

## Devices (fidelity is uneven)

Registered core ids: `seg`, `heron`, `kelvin`, `solar`, `peltier`, `mhd`
(+ Quanta plugins: `maglev`, `homopolar`, `halbach-viz`, `pulse-coil`,
`transformer`, `vdg`, `hall`, `lorentz-sled`, `jumping-ring`, `drop-tube`).
WASM plants: `physics/devices.json` `wasmMode` (codegen `enum SimMode`). Shader
slots are a separate `shaderMode` namespace — see docs/MODE_MATRIX.md.

- **SEG** is the highest-fidelity path (layout presets, flux, PBR).
- **Peltier** is a resolved 1-D thermoelectric cooler (28 nodes, `ros23`). **MHD** is one
  mean speed whose friction and braking are derived from the analytic Hartmann profile and the
  circuit (`physics/mhd-duct.ts`); the picture is that profile, not a flow solve. Both: docs/FLUIDS.md.
- **Liquid:** an MLS-MPM solver (`src/fluids/`, `passes/mpm-*.wgsl`, ADR-0022). Heron's jet runs
  on it — WebGPU, Heron in focus, `?fluid=auto|off|low|high` — through
  `visualizer/heron-liquid-pass.ts` (frame-graph lifetime `heron-liquid`; overview allocates none).
  That file is only the gate: the solver, `fluids/*` and the shaders are `heron-liquid-runtime.ts`,
  a chunk fetched on first Heron focus — keep them out of the WebGPU chunk (`check:entry-chunk`).
  It is shown at 1/6 speed, and drawn as a screen-space surface from the `medium` quality tier
  (`fluid-surface-pass.ts`, `passes/fluid-*.wgsl`; spray stays particles).
- **Kelvin's drops** are charged and feel the rings and collectors (`physics/kelvin-dropper.ts`,
  `kelvin-layout.ts`): on the solver on WebGPU, the same law on the CPU on WebGL2, in focus. The
  share that lands scales the plant's charging (`kelvinCollectionEff` in, `kelvinLandedShare` out;
  not measured = 1, so headless runs and goldens are unchanged). Real time, 0.048 m per scene unit.
- **Heron's plant** is Bernoulli + Darcy–Weisbach, the same in TS and C++ (`test:golden`); the C++
  plant needs the layout preset sent to it (`setHeronLayout`). 0.64 m per scene unit, SI gravity.
- Overview can enable all; particles/meshes scale with quality and view LOD.
- **Circuit Lab** (`src/circuit/`, ADR-0018): `pulse-coil`, `homopolar`,
  `transformer` have catalog `ports`. A wired bench is stepped by its port
  driver with the C++ MNA solver (`cpp/src/circuit/`, no TS mirror; it runs
  on both renderers whenever sim_core loaded, whatever `wasmPhysics` says).

## Hardware / firmware — experimental

- Transports: mock / Web Serial / Web Bluetooth (Nordic UART) / WebUSB CDC —
  `hardware-transport.ts` + `hardware-bridge.ts` / panel. Demo with `?mockHardware=1`.
- Twin modes: open / closed / **estimate** (was shadow; `'shadow'` still accepted).
  The EKF + calibration live in sim_core (`cpp/src/twin/`) and `src/twin/`;
  they only read — coil commands stay with the bridge (ADR-0019). Closed loop
  writes the *filtered* ω. A calibration profile is the `twinProfile` share field.
- `firmware/seg-driver/` is **not** required for the web app; treat as experimental.
  Line protocol v3 = v1 lines + a `V3` → `I v=3 …` hello (`bridge.firmware`),
  then `S t=<µs> …` samples; v1 / v2 boards keep working.
  On-board ESP32 BLE (`SEG_BLE=1`, NimBLE 2.x) is written but not compile-checked
  or benched here (its README says what is tested).
- Spec: **docs/hardware_connection.md**.

## Commands

```bash
npm run typecheck      # tsc on TS + checkJs on renderers/webgl2 + seg-geometry (tsconfig.js.json)
npm run lint           # ESLint (typed); raw location/storage access, wgsl-include imports, floating promises
npm run test:unit      # every scripts/tests/*.test.mjs under node:test, one summary
npm run test:coverage  # same, with a coverage report (no gate yet)
npm run codegen:catalog  # physics/devices.json → TS/C++/WGSL/docs (+ generated/plant-ode.{h,ts})
npm run codegen:wasm-abi # cpp/abi.json → C ABI shim + src/wasm/sim-core/abi.generated.ts (no Embind, no glue)
npm run test:integrators # rk4 / dopri5 / ros23 vs the reference, native + TS (docs/INTEGRATORS.md)
npm run bench:wasm       # sim_core.wasm throughput + size through the real ABI (flag study, cpp/README.md)
npm run codegen:lab-config # config/lab-config.json → generated/lab-config.ts + docs/AGENTS.md matrix
npm run check:lab-config # generated lab-config files are current (raw-access ban is now `lint`)
npm run test:lab-config  # parser, precedence, #lab=v1 mapping, #lab2= round-trip
npm run test:experiments # reference experiments headless on wasm + js (docs/EXPERIMENTS.md)
npm run test:experiments:live # same files on the live runner: headless LabSession, js + wasm, 60/20 fps, ≈ offline
npm run test:snapshots   # plant snapshots: native + shipped WASM + TS save→load→step bit-identical, JS→C++ cross-load
npm run test:twin-snapshot # closed-loop twin: snapshot ω wins at the restore, the next ?mockHardware=1 sample after
npm run test:twin       # EKF χ²-consistent, sysid within 5 % from 30 s, one Calibrate on the ±20 % mock, profile via #lab2= (ADR-0019)
npm run check:entry-chunk # vite build → entry closure has no uPlot / experiments / analysis panel / recorder / embed; WebGPU chunk has no liquid solver
npm run test:embed      # embed postMessage validator, origin allowlist, hz clamp, classroom channel
npm run test:frame-clock # UI frame clock: hz throttle, unsubscribe, LabSession.publishFrame tick
npm run test:uniform-ring # per-draw uniform ring, key-light shadow fit, render-bundle replay
npm run validate      # the whole suite, staged + parallel, per-step table — CI runs exactly this (validate.yml)
npm run check:file-size # 700-line gate on src/** + cpp/src/** (generated/ skipped)
npm run build:site    # no Emscripten
npm run check:wgsl    # naga offline
npm run check:post    # post uniform contracts
npm run test:transports # twin transport framing + coast-on-disconnect + v2/v3 hello, S t= µs clock
npm run test:firmware-safety # coil lock-on test + v3 hello + BLE link watchdog, host C++ (by hand — not in validate/CI)
npm run test:audio    # sonification mapping bounds (silent by default)
npm run test:props    # per-device glTF CAD: budgets, winding, per-bench switches
npm run test:lab-mode # labMode preset precedence + catalog setpoints + focus announcement
npm run test:drop-tube # drop-tube k / end taper / loops vs quadrature, transit vs RK4
npm run test:hartmann # MHD duct: analytic Hartmann profile (TS vs C++), timeline parcels, Ha range (docs/FLUIDS.md)
npm run test:mhd-slice # MHD lattice-Boltzmann slice, CPU twin: Hartmann profile at Ha 0/5/20, wall friction = the plant's, electrodes, loads, wall jets (the WGSL runs in test:gpu-golden)
npm run test:mpm      # MLS-MPM liquid: CPU reference — i32 overflow bound, mass / momentum, free fall at g, ρ·g·h, viscous decay (ADR-0022; the WGSL runs in test:gpu-golden)
npm run test:mpm-io   # …and what a bench adds: signed-distance solids, emitters, sinks, the height profile, a jet at v²/2g
npm run test:heron-liquid # Heron's liquid scene per preset × tier, fluid= tier choice, focus gate, focus camera
npm run test:catalog-fluid # catalog `fluid` blocks: validation, tier fall-back, budgets inside the solver's, scenes sized from them
npm run test:kelvin-liquid # Kelvin dropper: Rayleigh–Plateau drops, Rayleigh limit, the scene vs the drawn bench, landing share vs potential (solver twin + CPU drops)
npm run test:fluid-surface # liquid surface: uniform block vs WGSL, narrow-range filter CPU twin, optics per look (the passes run in test:gpu-golden)
npm run test:peltier  # Peltier cooler: ΔT_max / I_opt / COP / energy balance on native + WASM + TS, array snapshots, v1 migration (ADR-0021)
npm run test:field-volume # field kernels vs quadrature; field-probe/-volume WGSL run on the CPU vs the reference (ADR-0017)
npm run test:circuit  # Circuit Lab: native MNA goldens + their WASM replay (LC energy, RLC Q), SPICE, host, links (ADR-0018)
npm run generate:gltf # regenerate every placeholder GLB (seg + quanta + lab)
npm run test:device-draws # mock encoder: transformer flux, pickup coils + rings, bind-group token, camera scratch
npm run test:stacked-prs # stacked-PR guard decision table (CI: .github/workflows/stacked-prs.yml)
npm run test:pipelines  # Dawn-in-Node: every production pipeline compiles (Tint + Dawn) × colour mode × depth × MSAA; features / limits audit
npm run test:gpu-golden # Dawn-in-Node: compute passes vs CPU twins (FDTD, chores reduce, rollers, particles, IBL, cull)
npm run test:e2e:webgpu # headed Chromium on SwiftShader (xvfb-run added when no display): boot, 16 benches, tiers, device loss, image baselines
npm run e2e:update-baselines # rewrite e2e/baselines/** (report-only gate; CI: Validate → update_baselines)
npm run check:toolchain # config/toolchain.json is the only place a tool version is written (codegen:toolchain regenerates the mirrors)
npm run check:bundle-budget # gzip budgets for the entry / WebGPU / WebGL2 chunks (config/bundle-budget.json)
```

**GPU tests:** `test:pipelines` / `test:gpu-golden` need a Vulkan adapter
(`mesa-vulkan-drivers` gives Lavapipe); without one they skip with a notice
and `REQUIRE_GPU=1` (CI) fails instead. They live in `scripts/tests/gpu/`,
drive the app's real `PipelineLayoutCache` and host classes through
`scripts/lib/gpu-app.mjs`, and are not part of `test:unit`. A new pipeline
needs its `ensure*` call in `pipelines.test.mjs`; a new compute pass needs a
golden. Details: **docs/WEBGPU.md → How the GPU is tested** (ADR-0020).

**Image baselines:** a change under `e2e/baselines/` needs the before / after
image in the PR. They are SwiftShader frames, report-only until stable.

**Tool versions:** emsdk / naga / node / playwright are pinned in
`config/toolchain.json` and nowhere else — read them with
`node scripts/toolchain.mjs <tool>`.

**Tests:** new unit tests go in `scripts/tests/<name>.test.mjs` (`node:test`
`describe`/`it`, `node:assert/strict`) and import TS through
`bundleTs('src/….ts')` from `scripts/test-harness.mjs` — no per-file esbuild.
`test:unit` picks them up; add a `test:<name>` alias only if docs cite it.
ADR-0016 has the why.

**Stacked PRs:** retarget a stacked PR to `main` before merging it. Merging into an already-merged base leaves the code off `main` (#249, #251); `stacked-prs.yml` fails such PRs.

## WebGPU notes

- One adapter path: `webgpu-manager.ts`. Depth: `depth24plus` (or `depth32float` when SSR is on). Canvas: `colorSpace` sRGB (`?p3=1` for Display P3).
- GPU timing: `?gpuTiming=1` then debug panel.
- Details: **docs/WEBGPU.md**.

## Do not

- Assume HTTPS on the Vite dev server (it is HTTP on localhost).
- Document non-existent root `main.js` / dual architecture trees.
- Claim every device has equal physical fidelity.
- Import `wgsl-include.js` into browser code (Node/CI only; Vite expands `#include`).
- Import `webgpu` (Dawn-in-Node), `pixelmatch` or `pngjs` under `src/` — test-only (ADR-0020; `lint` fails it).
- Write a tool version outside `config/toolchain.json` (`check:toolchain` fails it).
