/**
 * Kelvin's dropper on the liquid solver — the gate (ADR-0022,
 * docs/FLUIDS.md → Kelvin). WebGPU only.
 *
 * Decides each frame whether the drops may run, feeds the pass the plant's
 * drive and potential, and writes what the pass measured — the share of the
 * drops that landed in a collector — into the plant's state. The pass itself
 * is kelvin-liquid-runtime.ts, imported the first frame the gate opens; this
 * file stays in the WebGPU chunk and imports nothing of the solver by value.
 *
 * Out of focus the plant is told "not measured" and assumes everything lands.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { ResourceLifetime } from './frame-graph';
import type { KelvinLiquidPass } from './kelvin-liquid-runtime';
import { labConfig } from '../config/lab-config';
import { kelvinSeedV } from '../renderers/shared/device-physics';
import { liquidTierFor } from './heron-liquid-pass';

export type { KelvinLiquidPass };

type Host = MultiDeviceVisualizer;

export const KELVIN_LIQUID_OWNER = 'kelvin';

export interface KelvinLiquidInfo {
  build: 'pending' | 'ready' | 'failed';
  allocated: boolean;
  active: boolean;
  grid: number[] | null;
  timeScale: number;
  bytes: number;
  /** Drops in the box, and what the collectors took / what reached the floor, as of the last read-back. */
  live: number;
  emitted: number;
  landed: number;
  missed: number;
  /** Share that landed over the last seconds; null while not known. */
  efficiency: number | null;
  substeps: number;
}

/** The frame-graph lifetime: follows whichever pass the host currently has. */
export function kelvinLiquidLifetime(host: Host): ResourceLifetime {
  const inner = (): ResourceLifetime | null => (host.kelvinLiquid ? host.kelvinLiquid.lifetime() : null);
  return {
    name: 'kelvin-liquid',
    isAllocated: () => inner()?.isAllocated() ?? false,
    ensure: () => inner()?.ensure(),
    release: () => inner()?.release()
  };
}

/**
 * Per frame, before encoding. Builds the pass on the first frame its gate
 * opens, feeds it the plant, and writes the landing share into the bench's
 * physics state (null = not measured). The gate is the liquid's own: Kelvin
 * in focus, `fluid` not off, the profiler not at `critical`, the lab mode not
 * asking for none. Every tier runs the same small scene.
 * @returns the pass when its frame-graph pass should run this frame
 */
export function updateKelvinLiquid(host: Host, qualityTier: string, frameDt: number, drive: number): KelvinLiquidPass | null {
  host.fluidChoice ??= labConfig().fluid;
  const device = host.devices[KELVIN_LIQUID_OWNER];
  const state = device?.physicsState;
  const inFocus = !!device && !host.isOverviewMode() && host.currentView === KELVIN_LIQUID_OWNER;
  const open = inFocus && liquidTierFor(host.fluidChoice, qualityTier, { preset: host.fluidPreset, ceiling: host.fluidCeiling }) !== null;
  if (!open || !state) {
    host.kelvinLiquid?.idle();
    if (state) state.kelvinCollectionEff = null;
    return null;
  }
  if (host.kelvinLiquid === undefined) {
    if (!host._kelvinLiquidInit && host.pipelineCache) {
      // The solver and its shaders are their own chunk, fetched here.
      host._kelvinLiquidInit = import('./kelvin-liquid-runtime').then(async (runtime) => {
        const pass = new runtime.KelvinLiquidPass(host.device, host);
        try {
          host.kelvinLiquid = (await pass.init()) ? pass : null;
        } catch (err) {
          pass.destroy();
          throw err;
        }
      }).catch((err: unknown) => {
        console.warn('[kelvin-liquid] disabled — the solver could not be loaded or built', err);
        host.kelvinLiquid = null;
      });
    }
    state.kelvinCollectionEff = null;
    return null;
  }
  const pass = host.kelvinLiquid;
  if (!pass?.ready) {
    state.kelvinCollectionEff = null;
    return null;
  }
  const volts = (state.kelvinV ?? 0) + kelvinSeedV(state);
  state.kelvinCollectionEff = pass.update({ drive, volts, frameDt });
  if (pass.draw()) host.liquidOwner = KELVIN_LIQUID_OWNER;
  return pass;
}

export function kelvinLiquidInfo(host: Host): KelvinLiquidInfo {
  const pass = host.kelvinLiquid;
  const solver = pass?.solver ?? null;
  const scene = pass?.scene ?? null;
  const profile = solver?.profile ?? null;
  return {
    build: pass === null ? 'failed' : pass?.ready ? 'ready' : 'pending',
    allocated: !!solver,
    active: !!pass?.active,
    grid: scene ? [...scene.config.gridN] : null,
    timeScale: scene?.timeScale ?? 0,
    bytes: solver?.memoryBytes ?? 0,
    live: profile ? profile.emitted - profile.sunk : 0,
    emitted: profile?.emitted ?? 0,
    landed: pass?.landed ?? 0,
    missed: pass?.missed ?? 0,
    efficiency: pass?.efficiency.value ?? null,
    substeps: solver?.substeps ?? 0
  };
}
