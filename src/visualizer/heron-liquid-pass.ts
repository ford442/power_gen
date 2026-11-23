/**
 * Heron's fountain as a liquid — the gate (ADR-0022, docs/FLUIDS.md → Heron).
 * WebGPU only.
 *
 * Decides each frame whether the liquid may run and at which tier, and feeds
 * the pass the plant's exit speed. The pass itself — the solver, its shaders,
 * everything that allocates — is heron-liquid-runtime.ts, imported the first
 * frame the gate opens. This file stays in the WebGPU chunk and is small on
 * purpose: nothing here may import the solver by value.
 *
 * Nothing is allocated until the frame graph asks (lifetime `heron-liquid`).
 * Out of focus the graph releases it after its hysteresis; overview never
 * allocates any of it.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { ResourceLifetime } from './frame-graph';
import type { MpmTier } from '../fluids/mpm-params';
import type { HeronLiquidPass } from './heron-liquid-runtime';
import { labConfig } from '../config/lab-config';
import { getHeronLayout } from '../heron-layout';

export type { HeronLiquidPass };

type Host = MultiDeviceVisualizer;

/** The bench that owns a liquid. */
export const HERON_LIQUID_OWNER = 'heron';
/** `fluid=` choices (config/lab-config.json). */
export type FluidChoice = 'auto' | 'off' | 'low' | 'high';

/** What a lab mode asks of the liquid while `fluid` is `auto` (lab-mode.ts): the most, none, or nothing. */
export type FluidPreset = 'high' | 'off' | null;
/** The largest tier `auto` may still build on this page. */
export type FluidCeiling = MpmTier | 'off';

const TIER_RANK: Record<FluidCeiling, number> = { off: 0, low: 1, default: 2, high: 3 };
const TIER_OF_RANK: readonly FluidCeiling[] = ['off', 'low', 'default', 'high'];

export interface LiquidTierOptions {
  preset?: FluidPreset;
  ceiling?: FluidCeiling;
}

/**
 * The solver tier for a `fluid` choice at a quality tier, or null for none.
 *
 * `fluid=low|high|off` is taken as asked. `auto` follows the profiler: the
 * default tier at `high`, the low tier at `medium` and `low`, none at
 * `critical`. It never picks the 96³ tier by itself — its frame cost has not
 * been measured on hardware — unless the lab mode asks for the most
 * (Showroom), and then only while the profiler holds `high`. A lab mode can
 * also ask for none (Twin). `ceiling` caps whatever `auto` arrives at.
 */
export function liquidTierFor(choice: FluidChoice, qualityTier: string, o: LiquidTierOptions = {}): MpmTier | null {
  if (choice === 'off') return null;
  if (choice === 'low' || choice === 'high') return choice;
  if (o.preset === 'off' || qualityTier === 'critical') return null;
  const top = qualityTier === 'high' || qualityTier === 'ultra';
  const most = o.preset === 'high';
  const want: MpmTier = top ? (most ? 'high' : 'default') : most && qualityTier === 'medium' ? 'default' : 'low';
  const capped = TIER_OF_RANK[Math.min(TIER_RANK[want], TIER_RANK[o.ceiling ?? 'high'])];
  return capped === 'off' ? null : capped;
}

/**
 * The ceiling after a frame on which `running` was the built tier and the
 * profiler allows `allowed`. It only moves down, and only when the liquid was
 * running on more than the profiler now allows: a tier that dragged the frame
 * rate under its own quality level is not built again on this page. Falling
 * to `critical` (allowed = null) costs one step, so the next attempt is a
 * smaller one and the third is none.
 */
export function liquidCeilingAfter(running: MpmTier | null, allowed: MpmTier | null, ceiling: FluidCeiling = 'high'): FluidCeiling {
  if (!running) return ceiling;
  const next = allowed ? TIER_RANK[allowed] : TIER_RANK[running] - 1;
  if (next >= TIER_RANK[running]) return ceiling;
  return TIER_OF_RANK[Math.min(TIER_RANK[ceiling], next)];
}

/**
 * True when the bulk of the liquid should be drawn as a screen-space surface
 * rather than as particles: `medium` and up. At `low` and `critical` the
 * five extra passes and four full-resolution targets are not worth it, and
 * the liquid stays particles.
 */
export function liquidSurfaceWanted(qualityTier: string): boolean {
  return qualityTier === 'medium' || qualityTier === 'high' || qualityTier === 'ultra';
}

/** True when the liquid may run this frame. */
export function heronLiquidGateOpen(o: { choice: FluidChoice; currentView: string | null | undefined; qualityTier: string } & LiquidTierOptions): boolean {
  return o.currentView === HERON_LIQUID_OWNER && liquidTierFor(o.choice, o.qualityTier, o) !== null;
}

export interface HeronLiquidInfo {
  choice: FluidChoice;
  /** The lab mode's say while `choice` is `auto`, and the cap the profiler has put on `auto`. */
  preset: FluidPreset;
  ceiling: FluidCeiling;
  /** 'pending' until first built, 'failed' if the build threw. */
  build: 'pending' | 'ready' | 'failed';
  allocated: boolean;
  active: boolean;
  tier: MpmTier | null;
  layout: string | null;
  grid: number[] | null;
  cellM: number;
  substepsPerFrame: number;
  timeScale: number;
  maxParticles: number;
  bytes: number;
  /** Particles in the box as of the last read-back. */
  live: number;
  emitted: number;
  drained: number;
  jetHeightM: number;
  substeps: number;
  /** The bulk is drawn by the screen-space surface pass this frame (else as particles). */
  surface: boolean;
  /** Pixels of the surface pass's targets, or null while they are released; their bytes. */
  surfaceSize: number[] | null;
  surfaceBytes: number;
}

/** The surface pass's targets, as a lifetime that follows whichever pass the host currently has. */
export function fluidSurfaceLifetime(host: Host): ResourceLifetime {
  const inner = (): ResourceLifetime | null => host.heronLiquid?.surfaceLifetime() ?? null;
  return {
    name: 'fluid-surface',
    isAllocated: () => inner()?.isAllocated() ?? false,
    ensure: () => inner()?.ensure(),
    release: () => inner()?.release()
  };
}

/** The frame-graph lifetime: follows whichever pass the host currently has. */
export function heronLiquidLifetime(host: Host): ResourceLifetime {
  const inner = (): ResourceLifetime | null => (host.heronLiquid ? host.heronLiquid.lifetime() : null);
  return {
    name: 'heron-liquid',
    isAllocated: () => inner()?.isAllocated() ?? false,
    ensure: () => inner()?.ensure(),
    release: () => inner()?.release()
  };
}

/** Scene position of the nozzle mouth, bench-local: the layout's `flow.apexY` on the axis. */
function nozzleScene(host: Host): [number, number, number] {
  const flow = host.devices[HERON_LIQUID_OWNER]?.geometry?.heronFlow;
  return [0, flow?.apexY ?? getHeronLayout().flow.apexY, 0];
}

/**
 * Per frame, before encoding. Builds the pass on the first frame its gate
 * opens, feeds it the plant's exit speed, and writes the measured jet height
 * into the bench's physics state (0 = not measured).
 * @returns the pass when its frame-graph pass should run this frame
 */
export function updateHeronLiquid(host: Host, qualityTier: string, frameDt: number): HeronLiquidPass | null {
  host.fluidChoice ??= labConfig().fluid;
  const device = host.devices[HERON_LIQUID_OWNER];
  const state = device?.physicsState;
  const choice = host.fluidChoice;
  const inFocus = !!device && !host.isOverviewMode() && host.currentView === HERON_LIQUID_OWNER;
  // `auto` steps down for good when the liquid was running on more than the
  // profiler now allows. A tier asked for by hand is left alone.
  const running = host.heronLiquid?.active ? host.heronLiquid.tier : null;
  if (choice === 'auto' && inFocus && running) {
    const byProfiler = liquidTierFor(choice, qualityTier, { preset: host.fluidPreset });
    host.fluidCeiling = liquidCeilingAfter(running, byProfiler, host.fluidCeiling);
  }
  const tierOptions = { preset: host.fluidPreset, ceiling: host.fluidCeiling };
  const allowed = inFocus ? liquidTierFor(choice, qualityTier, tierOptions) : null;
  const open = allowed !== null;
  host.liquidOwner = null;
  if (!open || !state) {
    host.heronLiquid?.idle();
    if (state) state.heronJetHeightM = 0;
    return null;
  }
  if (host.heronLiquid === undefined) {
    if (!host._heronLiquidInit && host.pipelineCache) {
      // The solver and its shaders are their own chunk, fetched here.
      host._heronLiquidInit = import('./heron-liquid-runtime').then(async (runtime) => {
        const pass = new runtime.HeronLiquidPass(host.device, host);
        try {
          host.heronLiquid = (await pass.init()) ? pass : null;
        } catch (err) {
          pass.destroy();
          throw err;
        }
      }).catch((err: unknown) => {
        console.warn('[heron-liquid] disabled — the solver could not be loaded or built', err);
        host.heronLiquid = null;
      });
    }
    state.heronJetHeightM = 0;
    return null;
  }
  const pass = host.heronLiquid;
  if (!pass?.ready) {
    state.heronJetHeightM = 0;
    return null;
  }
  // Hold the tier the solver was built at while the choice allows at least
  // that much: auto-quality moves between tiers, and each rebuild empties the
  // fountain. It is rebuilt smaller, never larger.
  const tier = pass.tier && TIER_RANK[pass.tier] <= TIER_RANK[allowed] ? pass.tier : allowed;
  pass.update({
    tier,
    layoutId: state.heronLayoutId || 'classic',
    vExitMS: state.heronVExit ?? 0,
    frameDt,
    nozzleScene: nozzleScene(host),
    surface: liquidSurfaceWanted(qualityTier),
    origin: [device.position[0], device.position[1], device.position[2]]
  });
  state.heronJetHeightM = pass.jetHeightM;
  if (pass.draw()) host.liquidOwner = HERON_LIQUID_OWNER;
  return pass;
}

export function heronLiquidInfo(host: Host): HeronLiquidInfo {
  const pass = host.heronLiquid;
  const solver = pass?.solver ?? null;
  const scene = pass?.scene ?? null;
  const profile = solver?.profile ?? null;
  return {
    choice: host.fluidChoice ?? labConfig().fluid,
    preset: host.fluidPreset ?? null,
    ceiling: host.fluidCeiling ?? 'high',
    build: pass === null ? 'failed' : pass?.ready ? 'ready' : 'pending',
    allocated: !!solver,
    active: !!pass?.active,
    tier: pass?.tier ?? null,
    layout: pass?.layoutId ?? null,
    grid: scene ? [...scene.config.gridN] : null,
    cellM: scene?.config.cellM ?? 0,
    substepsPerFrame: scene?.substepsPerFrame ?? 0,
    timeScale: scene?.timeScale ?? 0,
    maxParticles: scene?.config.maxParticles ?? 0,
    bytes: solver?.memoryBytes ?? 0,
    live: profile ? profile.emitted - profile.sunk : 0,
    emitted: profile?.emitted ?? 0,
    drained: profile?.sunk ?? 0,
    jetHeightM: pass?.jetHeightM ?? 0,
    substeps: solver?.substeps ?? 0,
    surface: !!pass?.surfaceOn,
    surfaceSize: pass?.surface?.size ?? null,
    surfaceBytes: pass?.surface?.bytes ?? 0
  };
}
