#!/usr/bin/env node
/**
 * test-experiments-live.mjs — the reference experiments on the **live**
 * runner, headless (#239 acceptance: "pass live and headless").
 *
 * `test:experiments` runs every reference on the offline bench. This runs the
 * same files through `runExperiment(def, { runner: 'live' })` on a real
 * `LabSession`: the live runner hooks `session.experimentClock`, and a frame
 * loop drives it exactly as the WebGL2 backend does —
 *
 *   session.stepPlant(dt, 1)   → cut batch, buses, operator, C++ focus plant
 *   stepJsDevicePlant(…)       → every simulated JS plant over that batch
 *   session.publishFrame(dt)   → TelemetryHub, then the run's samples
 *
 * with the real `bench-window-api.ts` (`window.setMode`, `setFieldCoupling`, …)
 * over a stub DOM. Each backend runs in its own child process (module
 * singletons: segOperator, segWasm, TelemetryHub):
 *
 *   js    the JS plants (the page's default)
 *   wasm  `?wasmPhysics=1&plantWorker=0`: the in-loop main-thread sim_core
 *
 * and at two frame cadences — 60 fps, and 20 fps where every batch is cut at
 * the next record tick (a slow classroom laptop). For each reference:
 *
 *   1. every verdict passes live;
 *   2. every verdict's measured numbers agree with the offline run of the same
 *      file on the same backend within LIVE_REL — a plant that stepped
 *      anything but the session's batch (a frame-time step, a skipped cut)
 *      drifts far past it;
 *   3. a sweep (transformer-turns-ratio) runs its points live, one after the
 *      other from one start snapshot, and its summaryExpect passes.
 *
 * Usage: node scripts/test-experiments-live.mjs [--verbose]   (exit 1 on failure)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootLiveLab, REF_DIR } from './lib/live-lab.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
/** `--only=<id>[,<id>]` — debug one reference. */
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const SELF = fileURLToPath(import.meta.url);

/** Live vs offline, relative, per measured number (offline is the golden). */
const LIVE_REL = 0.02;
/** Absolute floor for numbers near zero (intercepts). */
const LIVE_ABS = 1e-3;
/** Live vs offline samples: RMS over rows, as a fraction of the column's range. */
const SERIES_REL = 0.015;
const CADENCES = [{ name: '60 fps', dt: 1 / 60 }, { name: '20 fps', dt: 1 / 20 }];

// ── parent: one child per backend ───────────────────────────────────────────
const childArg = process.argv.find((a) => a.startsWith('--child='));
if (!childArg) {
  let failed = false;
  for (const backend of ['js', 'wasm']) {
    const res = spawnSync(process.execPath, [SELF, `--child=${backend}`, ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: ROOT
    });
    if (res.status !== 0) failed = true;
  }
  if (failed) {
    console.error('[experiments-live] FAILED');
    process.exit(1);
  }
  console.log('[experiments-live] OK — 4 reference experiments live on js + wasm, 2 frame cadences');
  process.exit(0);
}
const BACKEND = childArg.slice('--child='.length);

const { X, session, driveUntil, say } = await bootLiveLab({ backend: BACKEND });

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

if (BACKEND === 'wasm') check('wasm: segWasm enabled in-loop (?wasmPhysics=1&plantWorker=0)', X.segWasm.enabled);
check(`${BACKEND}: no plant worker in Node (in-loop plant)`, session.plantWorker === null);

function measuredNumbers(run) {
  const out = [];
  for (const e of run.expects ?? []) {
    for (const [k, v] of Object.entries(e.measured ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) out.push([`${e.label} · ${k}`, v]);
    }
  }
  return out;
}

function close(a, b) {
  return Math.abs(a - b) <= Math.max(LIVE_ABS, LIVE_REL * Math.max(Math.abs(a), Math.abs(b)));
}

/**
 * Live-vs-offline gap over the recorded time series: per measured column, the
 * RMS of (live − offline) over rows matched on `t`, as a fraction of the
 * offline column's range; the worst column is reported. The verdicts of
 * quasi-static references (a fit over a slow ramp) barely move if a plant runs
 * on the wrong clock; the samples of a transient (sled speed, disc spin-up)
 * do. RMS, not the worst row: an integer knob on a ramp can land one frame
 * apart (Halbach segments 4.5 → 4 or 5), a legitimate one-sample step; a
 * column with fewer than 32 distinct values is such a stepped function and is
 * skipped, as is one that barely moves (range < 1 % of its magnitude). With a
 * plant stepped at twice the session's time the transformer's waveform is off
 * by ~50 % of its range and the sled's speed by ~2.4 %; correct runs stay
 * under 0.5 %, except Hall's V_H (~1 %: B follows the segment steps through
 * the field bus, so it carries the same one-frame rounding offset).
 */
function seriesGap(live, offline) {
  const tj = live.columns.indexOf('t');
  const byT = new Map(offline.rows.map((r) => [r[tj].toFixed(6), r]));
  let worst = { gap: 0, what: '', matched: 0 };
  for (const [j, key] of live.columns.entries()) {
    if (key === 't' || key.includes('.')) continue; // knobs are written, not measured
    const oj = offline.columns.indexOf(key);
    if (oj < 0) continue;
    const col = offline.rows.map((r) => r[oj]).filter(Number.isFinite);
    const hi = Math.max(...col);
    const lo = Math.min(...col);
    const range = hi - lo;
    if (!(range > 0.01 * Math.max(Math.abs(hi), Math.abs(lo)))) continue;
    // A stepped column (a function of an integer knob: Halbach peak B over
    // 4…24 segments) moves when the knob's rounding does, not with the clock.
    if (new Set(col).size < 32) continue;
    let matched = 0;
    let sq = 0;
    for (const row of live.rows) {
      const o = byT.get(row[tj].toFixed(6));
      if (!o || !Number.isFinite(row[j]) || !Number.isFinite(o[oj])) continue;
      matched++;
      sq += (row[j] - o[oj]) ** 2;
    }
    worst.matched = Math.max(worst.matched, matched);
    const gap = matched ? Math.sqrt(sq / matched) / range : Infinity;
    if (gap > worst.gap) worst = { gap, what: `${key}: rms gap ${(gap * 100).toFixed(3)} % of range over ${matched} rows`, matched: worst.matched };
  }
  return worst;
}

const ids = X.referenceExperimentIds();
check('four reference experiments', ids.length === 4, ids.join());

for (const id of ids) {
  if (ONLY && !ONLY.includes(id)) continue;
  const def = JSON.parse(readFileSync(join(REF_DIR, `${id}.experiment.json`), 'utf8'));
  // Offline on this backend (Node has no Worker: main-thread bench) — the golden.
  const offline = await X.runExperimentDetailed(def, { runner: 'offline', wasm: BACKEND === 'wasm', store: false });
  for (const cadence of CADENCES) {
    const tag = `${BACKEND} ${cadence.name} ${id}`;
    const t0 = performance.now();
    let outcome;
    let frames = 0;
    try {
      ({ value: outcome, frames } = await driveUntil(
        X.runExperimentDetailed(def, { runner: 'live', store: false }),
        cadence.dt,
        200_000
      ));
    } catch (err) {
      check(`${tag}: live run finished`, false, String(err?.message ?? err));
      continue;
    }
    const run = outcome.run;
    const ms = performance.now() - t0;
    check(`${tag}: runner is live`, run.runner === 'live', run.runner);
    check(`${tag}: backend`, BACKEND === 'js' ? run.backend === 'js' : run.backend !== 'js', run.backend);
    check(`${tag}: every verdict passes live`, run.expects.length > 0 && run.expects.every((e) => e.pass),
      run.expects.map((e) => `${e.pass ? 'PASS' : 'FAIL'} ${e.label} ${JSON.stringify(e.measured)}`).join(' | '));
    if (def.sweep) {
      check(`${tag}: one live run per sweep point`, outcome.runs.length === offline.runs.length
        && outcome.runs.every((r) => r.runner === 'live'), `${outcome.runs.length} vs ${offline.runs.length}`);
      check(`${tag}: summary is one row per point`, run.rows.length === offline.run.rows.length, `${run.rows.length}`);
    }
    // Live and offline judged the same verdicts on (nearly) the same numbers.
    const live = measuredNumbers(run);
    const ref = new Map(measuredNumbers(offline.run));
    const worst = { rel: 0, what: '', series: 0 };
    for (const [what, v] of live) {
      const o = ref.get(what);
      if (o === undefined) continue;
      const rel = Math.abs(v - o) / Math.max(LIVE_ABS, Math.abs(o));
      if (rel > worst.rel) Object.assign(worst, { rel, what: `${what}: live ${v} vs offline ${o}` });
      check(`${tag}: ${what} live ≈ offline`, close(v, o), `live ${v} vs offline ${o}`);
    }
    // The samples themselves, row by row (each sweep point against its offline twin).
    const pairs = def.sweep ? outcome.runs.map((r, i) => [r, offline.runs[i]]) : [[run, offline.run]];
    for (const [i, [lr, or]] of pairs.entries()) {
      const g = seriesGap(lr, or);
      const where = def.sweep ? ` point ${i}` : '';
      check(`${tag}${where}: rows matched on t`, g.matched >= 0.9 * or.rows.length, `${g.matched} of ${or.rows.length}`);
      check(`${tag}${where}: time series live ≈ offline (rms ≤ ${SERIES_REL * 100} % of range)`, g.gap <= SERIES_REL, g.what);
      if (g.gap > worst.series) worst.series = g.gap;
    }
    if (VERBOSE || failures.length) {
      say(`  ${tag}: ${run.expects.filter((e) => e.pass).length}/${run.expects.length} pass, ${frames} frames, ${ms.toFixed(0)} ms, worst live/offline ${(worst.rel * 100).toFixed(3)} % ${worst.what} · series ${(worst.series * 100).toFixed(3)} % of range`);
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error(`[experiments-live:${BACKEND}] ${failures.length} failure(s) of ${checks}`);
  process.exit(1);
}
say(`[experiments-live:${BACKEND}] ${checks} checks passed`);
