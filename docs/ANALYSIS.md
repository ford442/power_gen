# Analysis panel

Plots, fits and spectra of **recorded runs** (epic #224 §4). Every view, every
CSV and every PNG carries **"Simulated — not metrology"**: a fitted slope here
describes the simulated plant, never a calibrated instrument.

| Piece | Module | Chunk |
|-------|--------|-------|
| Run contract | `src/analysis/run-types.ts` (`RecordedRun`) | — (types) |
| Run store | `src/analysis/run-store.ts` | entry |
| Button + `window.openAnalysis` | `src/analysis/entry.ts` | entry |
| Panel (uPlot, CSS, views, PNG) | `src/analysis/analysis-panel.ts` + `.css`, `analysis-views.ts`, `analysis-png.ts` | lazy `analysis-panel-*.js` |
| Fits | `src/analysis/fit.ts` | wherever imported |
| Labels / units | `src/analysis/run-columns.ts` (from `DEVICE_TELEMETRY_FIELDS`) | lazy |
| Telemetry recording → run | `src/analysis/telemetry-run.ts` | lazy |
| CSV | `src/analysis/run-export.ts` | lazy |
| Spectrum chore | `src/gpu-chores/fft{,-js,-wasm}.ts` + `cpp/src/plant/chores_fft.cpp` | lazy (not in the gpu-chores barrel) |

The entry chunk only gains the run store and the button (~1.5 kB minified,
~0.7 kB gzip). uPlot (1.6.32, pinned), the panel and both style sheets are one
lazy chunk, loaded by dynamic `import()` the first time the panel opens; the
CSS is imported `?inline` and injected as one `<style>` so no CSS preload map
lands in the entry. A failed chunk fetch is retried on the next open.

## Getting runs in

```js
// Producers (experiment runner, offline runner, sweeps):
import { addRun } from './analysis/run-store';
addRun(run);                       // newest first, capped at 20, same id replaces

// Console / tests:
window.analysisRuns.addRun(run);   // also listRuns(), getRun(id), clearRuns()
await window.openAnalysis();                // newest run
await window.openAnalysis(['mine', 'ref']); // main run + overlay
```

Scripted experiments ([`EXPERIMENTS.md`](./EXPERIMENTS.md)) add every run they
record — each sweep point, then the sweep's summary table — so the experiment
panel's **Open in Analysis** lands on them. Loading a `.lab.json` that carries
`runs` adds those too (`src/config/lab-file.ts`, shape-checked).

`subscribeRuns(fn)` / `unsubscribeRuns(fn)` notify on every change (the panel's
pickers use it). `addRun` throws a `TypeError` when the run has no id or a row
is not as wide as `columns`.

**+ Current recording** in the panel turns the TelemetryHub sampler's recorded
rows (Record 10s, see [`TELEMETRY.md`](./TELEMETRY.md)) into a run with
`runFromTelemetryRows`: `time_s` → `t` (simulated seconds), device columns →
catalog keys through `TELEMETRY_FIELD_BY_COLUMN` (`lorentz_force_n` →
`lorentzForceN`), SEG `rpm_inner`/`corona`/`voltage_v`/`current_a`/`power_w`/
`field_sim_t` → `rpm`/`corona`/`voltage`/`current`/`power`/`fieldSim`.
`seg_omega` is the normalised 0–1 spin, not the catalog's rad/s `omega`, so it
is left out with the bookkeeping columns. All-zero (idle bench) columns are
dropped. Backend is `mixed` when the C++ focus plant was on.

The button sits in the left sidebar **Telemetry Export** row, next to Bench.

## Views

| View | What | Defaults |
|------|------|----------|
| **Time** | Up to 4 columns against `t`, one strip per unit (never two y-scales on one plot) | first plot hint's `y` |
| **X–Y** | Any column against any column, as points | first plot hint (`x`, `y`, `fit`) |
| **Spectrum** | One column, dB vs Hz from the run's `hz` | first non-`t` column |

- **Overlay**: a second run draws dashed in the same colour as the main run's
  column (time) or in the second colour slot (X–Y, spectrum). Samples are
  aligned on their x values, nothing is resampled.
- **Cursor**: hover, or focus the plot and use ←/→ (one sample), Shift+←/→
  (5 %), Home/End. Strips share the cursor; the readout below the plot prints
  every series value with its unit.
- **Expects**: an experiment's `expects` print as `✓ PASS` / `✗ FAIL` lines
  with the condition and the measured numbers.
- Labels and units come from the catalog (`DEVICE_TELEMETRY_FIELDS`, with the
  catalog display scale applied — e.g. mN); `t` is seconds. Unknown keys plot
  without a unit.
- Esc closes, Tab stays inside the dialog, the backdrop closes it. At ≤ 480 px
  the dialog is full screen; at 390 px nothing scrolls sideways.

Colours: the four dark categorical slots `#3987e5 #d95926 #199e70 #c98500` on
the panel surface `#0a1420` (validated for CVD separation and contrast), fit
line neutral `#c3c2b7`. A column keeps its colour slot when others are toggled.

## Fits (`src/analysis/fit.ts`)

All pure, no DOM; pairs where either value is non-finite are ignored. The
experiment `expect` blocks use the same functions, so a verdict and the line on
the plot are the same regression.

| Function | Model | Notes |
|----------|-------|-------|
| `linearFit(xs, ys)` → `{ kind, slope, intercept, r2, n }` | y = slope·x + intercept | OLS, two-pass centred sums. R² = S_xy² / (S_xx·S_yy) (= 1 − SS_res/SS_tot for OLS with intercept). < 2 points or constant x → NaN slope; constant y → NaN R² |
| `exponentialFit(xs, ys)` → `{ kind, a, b, tau, r2, r2Linear, n }` | y = a·e^(b·x) | Least squares on **ln y** (points with y ≤ 0 skipped). `tau = −1/b` (decay time when x is t; ∞ for b = 0). `r2` is the log-space R² (the fit's own objective); `r2Linear` is a·e^(bx) against y in linear space, printed alongside |
| `envelopePeaks(xs, ys, { minFraction = 0.01 })` | local maxima of \|y\| | For A·e^(−t/τ)·sin(ωt+φ) the peaks sit π/ω apart and decay exactly as e^(−t/τ). Peaks under 1 % of the largest (float noise in the tail) are dropped |
| `ringDownFit(xs, ys)` | `exponentialFit` through `envelopePeaks` | Pulse-coil RLC ring-down → τ = 2L/R |
| `evaluateFit(fit, x)` | the fitted curve at x | |

The panel offers None / Linear / Exponential / Ring-down τ. Time-view fits use
the first selected column against `t`; X–Y fits use the plotted pair; both use
the displayed (catalog-scaled) values, so the slope's unit is what the axes
show. Printed as, e.g. (illustrative numbers):

```
F = 2.4021 N/T · B + 0.10054 N · R² = 0.99873 (n = 64)
I = 1.2 A · e^(b·t), b = −74.9 1/s · τ = −1/b = 13.35 ms · R²(ln y) = 0.99998 · R²(y) = 0.99990 (n = 9 envelope peaks)
```

`test:analysis` checks the fits on exact lines and curves, on noisy data, on
non-finite input, and on the real pulse-coil plant (C++ RLC, R = 0.18 Ω,
L = 1.2 mH): ring-down τ = 13.350 ms against 2L/R = 13.333 ms.

## Spectrum chore (FFT)

`spectrumDb(data, { sampleHz, hann = true, floorDb = −120, removeMean = true })`
in `src/gpu-chores/fft.ts` returns dB per bin, the bin frequencies, the peak
(excluding DC) and which backend ran.

- Iterative radix-2 Cooley–Tukey on the real samples (im = 0). **Any length is
  zero-padded to the next power of two N** (max 2²⁰); the periodic Hann window
  spans the real samples, not the pad, so padding interpolates the spectrum
  and adds no resolution. Bin spacing Δf = sampleHz / N.
- One-sided amplitude, N/2 + 1 bins: mag[k] = c_k·|X[k]| / Σw (c_k = 1 at DC and
  Nyquist, else 2), dB = max(20·log10 mag, floorDb). A sine of amplitude A on a
  bin reads 20·log10 A ("dB re 1 unit of the column"). Non-finite samples count
  as 0. The mean is removed first by default so DC leakage cannot win the peak.

| Backend | Where | When |
|---------|-------|------|
| JS | `fft-js.ts` | Always available; the golden. `?gpuChores=0` / `js` forces it |
| WASM | `fft-wasm.ts` → `chores_fft_db_scratch(count, hann, floorDb)` in `cpp/src/plant/chores_fft.cpp` | Default whenever sim_core is loaded. Uses the chores scratch (`chores_scratch_ptr(count)` → write `HEAPF32` → call → read N/2+1 bins back from the scratch). Any failure falls back to JS; the first error lands in `gpuChores.breadcrumb().wasmError` |
| WebGPU | — | **None.** A WebGPU session runs the WASM kernel (else JS) and issues no GPU work |

**Why no WGSL (Stockham) pass**: the panel transforms one column of at most a
few thousand samples once per view change; the WASM kernel does that in well
under a millisecond, and a GPU pass would add an upload, a readback and a
pipeline for no visible win. A GPU FFT is only worth having for N ≥ 4096 at
interactive rates *with a measured speed-up*, and this work was done on a
machine with no GPU adapter, so nothing could be measured. It stays out until
someone can profile it on real hardware.

**Golden** (`npm run test:analysis`): the JS kernel against a naive DFT; sine
at bin k (peak at k, ≈ 0 dB for amplitude 1, far bins at the floor), DC level,
zero-pad sizes, Parseval with the window (Σ(w·x)² = Σ|X|²/N, 1e-5); then the
**shipped** `src/public/wasm/sim_core.wasm` against JS on a bin-centred sine,
noise (1000 → 1024 points), a 4096-point chirp and DC with a NaN, Hann and
rectangular: **max |ΔdB| ≤ 1e-3** (observed 0 — both run the same double
arithmetic and round once to float). The dispatcher is checked for each
`gpuChores` backend, the kill switch and a throwing kernel. `test:wasm-abi`
and `sim_core_test --mode chores` (in `wasm:native`) cover the C++ side.

## Exports

| Button | Output |
|--------|--------|
| **CSV** | `seg-run-<id>[+<overlay id>].csv`: per run a block of `#` lines (disclaimer, id, title, experimentId, startedAt, runner, backend, hz, sweep, config, expects, units per column), then the header of catalog keys and the rows. Values are **raw run values** (no catalog display scale); NaN is an empty cell. Two runs = two blocks separated by a blank line |
| **PNG** | The plot strips composed onto one canvas with the title, axis labels with units, the fit equation, the legend, the disclaimer and a footer (run id, runner, backend, rate, start time) burned in |
| **.lab.json** | `window.lab.downloadLabFile(name, { runs })` ([`LAB_CONFIG.md`](./LAB_CONFIG.md)): the lab's config plus the selected run(s); loading the file adds them back. Hidden while `window.lab` is not installed |

No query parameters: the panel reads nothing from the URL or `localStorage`.
