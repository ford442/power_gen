/**
 * The MHD duct slice — the gate (docs/FLUIDS.md → MHD duct → The slice).
 * WebGPU only.
 *
 * Decides each frame whether the slice may run and feeds the pass the
 * plant's field and mean speed. The pass itself is mhd-slice-runtime.ts,
 * imported the first frame the gate opens; this file stays in the WebGPU
 * chunk and imports nothing of the solver by value.
 *
 * The gate is the liquid's own: MHD in focus, `fluid` not off, the profiler
 * not at `critical`, the lab mode not asking for none. One size at any tier —
 * the grid is ten thousand cells.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { ResourceLifetime } from './frame-graph';
import type { MhdSlicePass } from './mhd-slice-runtime';
import { labConfig } from '../config/lab-config';
import { liquidTierFor } from './heron-liquid-pass';

export type { MhdSlicePass };

type Host = MultiDeviceVisualizer;

export const MHD_SLICE_OWNER = 'mhd';

export interface MhdSliceInfo {
  build: 'pending' | 'ready' | 'failed';
  allocated: boolean;
  active: boolean;
  grid: number[] | null;
  bytes: number;
  /** Lattice steps since the solver was allocated. */
  steps: number;
  /** Volts per electrode pair and amperes through its load, as of the last read-back. */
  volts: number[] | null;
  amps: number[] | null;
  totalAmps: number | null;
}

/** The frame-graph lifetime: follows whichever pass the host currently has. */
export function mhdSliceLifetime(host: Host): ResourceLifetime {
  const inner = (): ResourceLifetime | null => (host.mhdSlice ? host.mhdSlice.lifetime() : null);
  return {
    name: 'mhd-slice',
    isAllocated: () => inner()?.isAllocated() ?? false,
    ensure: () => inner()?.ensure(),
    release: () => inner()?.release()
  };
}

/** True when the slice may run this frame. */
export function mhdSliceGateOpen(host: Host, qualityTier: string): boolean {
  host.fluidChoice ??= labConfig().fluid;
  return !!host.devices[MHD_SLICE_OWNER]
    && !host.isOverviewMode()
    && host.currentView === MHD_SLICE_OWNER
    && liquidTierFor(host.fluidChoice, qualityTier, { preset: host.fluidPreset, ceiling: host.fluidCeiling }) !== null;
}

/**
 * Per frame, before encoding. Builds the pass on the first frame its gate
 * opens and feeds it the plant.
 * @returns the pass when its frame-graph pass should run this frame
 */
export function updateMhdSlice(host: Host, qualityTier: string, frameDt: number): MhdSlicePass | null {
  const device = host.devices[MHD_SLICE_OWNER];
  const state = device?.physicsState;
  if (!mhdSliceGateOpen(host, qualityTier) || !state) {
    host.mhdSlice?.idle();
    return null;
  }
  if (host.mhdSlice === undefined) {
    if (!host._mhdSliceInit && host.pipelineCache) {
      // The solver and its shaders are their own chunk, fetched here.
      host._mhdSliceInit = import('./mhd-slice-runtime').then(async (runtime) => {
        const pass = new runtime.MhdSlicePass(host.device, host);
        try {
          host.mhdSlice = (await pass.init()) ? pass : null;
        } catch (err) {
          pass.destroy();
          throw err;
        }
      }).catch((err: unknown) => {
        console.warn('[mhd-slice] disabled — the solver could not be loaded or built', err);
        host.mhdSlice = null;
      });
    }
    return null;
  }
  const pass = host.mhdSlice;
  if (!pass?.ready) return null;
  pass.update({
    bFieldT: state.mhdBFieldT ?? 0,
    flowU: state.mhdFlowU ?? 0,
    frameDt,
    devicePos: device.position
  });
  return pass;
}

export function mhdSliceInfo(host: Host): MhdSliceInfo {
  const pass = host.mhdSlice;
  const solver = pass?.solver ?? null;
  const e = pass?.electrodes ?? null;
  return {
    build: pass === null ? 'failed' : pass?.ready ? 'ready' : 'pending',
    allocated: !!solver,
    active: !!pass?.active,
    grid: solver ? [solver.nx, solver.ny] : null,
    bytes: solver?.bytes ?? 0,
    steps: solver?.steps ?? 0,
    volts: e ? [...e.volts] : null,
    amps: e ? [...e.amps] : null,
    totalAmps: e ? e.totalAmps : null
  };
}
