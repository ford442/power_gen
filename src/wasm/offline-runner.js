/**
 * Headless WASM SEG run → telemetry CSV rows (same schema as live hub).
 */

import { SEGSim } from './sim.ts';
import { rowFromWasmSeg, rowsToCsv, TELEMETRY_CSV_COLUMNS } from '../telemetry/telemetry-schema.js';
import { SEG_SPEC } from '../seg-operator-state.js';

/**
 * @param {object} opts
 * @returns {Promise<{ rows: object[], csv: string, durationSec: number }>}
 */
export async function runOfflineSegExport(opts = {}) {
  const {
    durationSec = 10,
    sampleHz = 10,
    drive = 0.5,
    loadTorque = 0.01,
    loadOhm = 100,
    fieldStrength = 0.5,
    onProgress
  } = opts;

  const sim = await SEGSim.create();
  if (!sim.wasmAvailable) {
    throw new Error('WASM sim_core not available — run npm run wasm:build');
  }

  sim.setMode(0);
  sim.setDrive(drive);
  sim.seedParticles(1000);

  const physicsDt = 1 / 60;
  const sampleDt = 1 / sampleHz;
  let simTime = 0;
  let accum = 0;
  let frameId = 0;
  const rows = [];
  const maxSteps = Math.ceil(durationSec * 60) + 2;
  let steps = 0;

  while (simTime < durationSec && steps < maxSteps) {
    const res = sim.step(physicsDt, loadTorque);
    sim.stepParticles(physicsDt);
    simTime += physicsDt;
    accum += physicsDt;
    steps++;

    while (accum >= sampleDt && simTime <= durationSec + 1e-3) {
      accum -= sampleDt;
      frameId++;
      const tSample = simTime - accum;
      const omega = res.omega;
      const segOmega = Math.min(1, Math.max(0, omega / 50));
      const corona = Math.max(0, Math.min(1, (segOmega - 0.6) / 0.4));

      rows.push(rowFromWasmSeg({
        simTimeS: tSample,
        frameId,
        omega,
        rpm: res.rpm,
        powerW: res.powerW,
        energyDensityJm3: res.energyDensityJm3,
        drive,
        fieldStrength,
        loadOhm,
        corona,
        B_SURFACE_T: SEG_SPEC.B_SURFACE_T
      }));
    }

    onProgress?.(Math.min(1, simTime / durationSec));
  }

  return { rows, csv: rowsToCsv(rows), durationSec, columns: TELEMETRY_CSV_COLUMNS };
}

/**
 * Run export in a Web Worker when available.
 * @param {object} opts  Same as runOfflineSegExport
 */
export function runOfflineSegExportInWorker(opts = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/wasm-offline-worker.js', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data?.ok) resolve(e.data);
      else reject(new Error(e.data?.error || 'Worker failed'));
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage(opts);
  });
}
