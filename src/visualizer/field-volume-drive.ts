// Field-volume gate + per-frame drive for MultiDeviceVisualizer (ADR-0017).
// Kept out of multi-device-visualizer.ts for the 700-line cap, like
// fdtd-drive.ts: the pass is built lazily the first frame its gate would
// open; `undefined` = not tried, `null` = the build failed (disabled).
import { FieldVolumePass } from './field-volume-pass';
import { BenchField, hasBenchField } from '../physics/field-bench';
import { fieldVolumeResolution } from '../physics/field-volume';
import { evaluateFieldT } from '../physics/field-eval';
import {
  fieldIsoLevels,
  fieldParticleCount,
  fieldVolumeGateOpen,
  type FieldSliceAxis,
  type FieldSliceMode
} from '../physics/field-pack';
import { fieldParticlePlan, type FieldParticlePlan, type FieldSpecies } from '../physics/field-particles';
import { fieldProbePoint, setFieldProbeContext } from '../physics/field-probe';
import { labConfig } from '../config/lab-config';
import type { ResourceLifetime } from './frame-graph';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

/** What the field panel edits (seeded from LabConfig; the panel persists changes). */
export interface FieldViewState {
  slice: FieldSliceAxis;
  /** 0..1 along the slice normal. */
  sliceOffset: number;
  sliceMode: FieldSliceMode;
  iso: boolean;
  /** Explicit shells (mT); null = three around the reference field. */
  isoLevelsMt: number[] | null;
  particles: 'off' | FieldSpecies;
}

/** Last frame's numbers, for the panel / `window.fieldVolume.info()`. */
export interface FieldReadout {
  deviceId: string;
  /** Device-local scene units. */
  point: [number, number, number];
  /** Tesla — exact kernel sum at the point (field-probe.ts). */
  B: [number, number, number];
  magnitudeT: number;
  /** Reference |B| (mT) the colour maps and lines are scaled to. */
  bRefMt: number;
  model: string;
  /** 'gpu' while the WebGPU volume is live, else 'cpu' (probe only). */
  volume: 'gpu' | 'cpu';
  n: number;
  isoLevelsMt: number[];
  particles: FieldParticlePlan | null;
}

export function initialFieldView(): FieldViewState {
  const c = labConfig();
  return {
    slice: c.fieldSlice,
    sliceOffset: 0.5,
    sliceMode: c.fieldSliceMode,
    iso: c.fieldIso,
    isoLevelsMt: null,
    particles: c.fieldParticles
  };
}

interface DriveState {
  benches: Map<string, BenchField>;
  bRef: Map<string, number>;
  lastWall: number;
}
const drives = new WeakMap<Host, DriveState>();

function driveState(host: Host): DriveState {
  let s = drives.get(host);
  if (!s) {
    s = { benches: new Map(), bRef: new Map(), lastWall: 0 };
    drives.set(host, s);
    // SEG probes (record keys, readouts) need the drawn roller layout and phase.
    setFieldProbeContext(() => ({ time: host.time ?? 0, segLayout: host.segLayout ?? null, segOmega: host.segOmega ?? 0 }));
  }
  return s;
}

function benchFor(s: DriveState, id: string): BenchField {
  let b = s.benches.get(id);
  if (!b) {
    b = new BenchField(id);
    s.benches.set(id, b);
  }
  return b;
}

/** Frame-graph lifetime that follows whichever pass the host holds (built lazily). */
export function fieldVolumeLifetime(host: Host): ResourceLifetime {
  const inner = () => (host.fieldVolume ? host.fieldVolume.lifetime() : null);
  return {
    name: 'field-volume',
    isAllocated: () => inner()?.isAllocated() ?? false,
    ensure: () => inner()?.ensure(),
    release: () => inner()?.release()
  };
}

function rebuild(host: Host, bench: BenchField, state: Readonly<Record<string, unknown>>): void {
  const seg = bench.deviceId === 'seg' && host.segLayout;
  bench.rebuild({
    state,
    time: host.time ?? 0,
    segLayout: host.segLayout ?? null,
    segOmega: host.segOmega ?? 0,
    unitM: seg ? 1 / host.segLayout!.worldScale : undefined
  });
}

/**
 * Per-frame gate, bench rebuild and uniform upload. Also refreshes
 * `host.fieldReadout` on any focused field bench (any tier — the CPU probe
 * is cheap), so the panel has numbers on WebGL2-like low tiers too.
 *
 * @returns the pass when its frame-graph pass should run this frame
 */
export function updateFieldVolume(host: Host, qualityTier: string): FieldVolumePass | null {
  const s = driveState(host);
  const id = host.currentView;
  const overview = host.isOverviewMode();
  const device = !overview && id ? host.devices[id] : undefined;
  const hasField = !!device && hasBenchField(id);
  const view = (host.fieldView ??= initialFieldView());
  const wall = performance.now() / 1000;
  const dt = Math.min(0.25, Math.max(0, wall - s.lastWall));
  s.lastWall = wall;

  host.fieldVolumeLinesOwner = null;
  host.fieldIsoActive = false;
  if (!hasField || !device) {
    host.fieldReadout = null;
    host.fieldVolume?.idle();
    return null;
  }

  const state = (device.physicsState ?? {}) as Readonly<Record<string, unknown>>;
  const bench = benchFor(s, id);
  rebuild(host, bench, state);

  // Reference field: |B| at the catalog probe, held with a slow decay so a
  // pulsed bench keeps a stable colour scale between shots.
  const cp = bench.decl.probe;
  const b0 = bench.probeT(cp[0], cp[1], cp[2]);
  const mt = Math.hypot(b0[0], b0[1], b0[2]) * 1000;
  const held = Math.max(mt, (s.bRef.get(id) ?? 0) * Math.exp(-dt / 4));
  const bRefMt = held > 1e-9 ? held : 1;
  s.bRef.set(id, held);

  const point = fieldProbePoint(id, state);
  const B = bench.probeT(point[0], point[1], point[2]);
  const n = fieldVolumeResolution(qualityTier) ?? 0;
  const isoLevelsMt = view.isoLevelsMt?.length ? view.isoLevelsMt : fieldIsoLevels(bRefMt);
  const bounds = bench.decl.bounds;
  const diagM = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]) * bench.unitM;
  const efield = bench.efield(state);
  const particleCount = view.particles === 'off' ? 0 : fieldParticleCount(qualityTier);
  const plan = particleCount > 0 && view.particles !== 'off'
    ? fieldParticlePlan(view.particles, bRefMt / 1000, diagM, Math.hypot(...efield))
    : null;

  host.fieldVolumeEnabled ??= labConfig().fieldVolume;
  const gate = {
    enabled: host.fieldVolumeEnabled,
    currentView: id,
    qualityTier,
    hasField
  };
  const readout: FieldReadout = {
    deviceId: id,
    point,
    B: [B[0], B[1], B[2]],
    magnitudeT: Math.hypot(B[0], B[1], B[2]),
    bRefMt,
    model: bench.decl.model,
    volume: 'cpu',
    n: 0,
    isoLevelsMt,
    particles: plan
  };
  host.fieldReadout = readout;

  if (host.fieldVolume === undefined) {
    if (fieldVolumeGateOpen({ ...gate, ready: true }) && !host._fieldVolumeInit && host.pipelineCache) {
      const pass = new FieldVolumePass(host.device, host);
      host._fieldVolumeInit = pass.init().then(
        (ok) => { host.fieldVolume = ok ? pass : null; },
        (err) => {
          console.warn('[field-volume] disabled — pipeline build failed', err);
          pass.destroy();
          host.fieldVolume = null;
        }
      );
    }
    return null;
  }
  const pass = host.fieldVolume;
  if (!pass || !fieldVolumeGateOpen({ ...gate, ready: pass.ready })) {
    pass?.idle();
    return null;
  }

  pass.update({
    bench,
    n,
    wallTime: wall,
    time: host.time ?? 0,
    devicePos: device.position ?? [0, 0, 0],
    bRefMt,
    slice: view.slice === 'off' ? null : { axis: view.slice, offset: view.sliceOffset, mode: view.sliceMode },
    isoLevelsMt: view.iso ? isoLevelsMt : null,
    particles: plan
      ? { plan, efield, spawn: point, count: particleCount }
      : null
  });
  if (pass.linesLiveFor(id)) host.fieldVolumeLinesOwner = id;
  host.fieldIsoActive = pass.isoActive();
  readout.volume = 'gpu';
  readout.n = pass.n || n;
  return pass;
}

export interface FieldVolumeInfo {
  enabled: boolean;
  /** 'pending' until first built, 'failed' if the build threw. */
  build: 'pending' | 'ready' | 'failed';
  active: boolean;
  n: number;
  sweeps: number;
  bytes: number;
  linesOwner: string | null;
  iso: boolean;
  view: FieldViewState;
  readout: FieldReadout | null;
}

export function fieldVolumeInfo(host: Host): FieldVolumeInfo {
  const p = host.fieldVolume;
  return {
    enabled: host.fieldVolumeEnabled ?? labConfig().fieldVolume,
    build: p === undefined ? 'pending' : p === null ? 'failed' : 'ready',
    active: !!p?.active,
    n: p?.n ?? 0,
    sweeps: p?.sweeps ?? 0,
    bytes: p?.allocatedBytes ?? 0,
    linesOwner: host.fieldVolumeLinesOwner ?? null,
    iso: !!host.fieldIsoActive,
    view: { ...(host.fieldView ?? initialFieldView()) },
    readout: host.fieldReadout ?? null
  };
}

export interface FieldVolumeDebug {
  info(): FieldVolumeInfo;
  /**
   * GPU probe (field-probe.wgsl, the sweep's source snapshot) vs the CPU
   * reference at device-local points; default the readout point.
   */
  probeGpu(points?: number[][]): Promise<{ gpu: number[][]; cpu: number[][]; maxRelErr: number } | null>;
  /** Patch the panel state (slice / iso / particles) — the panel's own path. */
  setView(patch: Partial<FieldViewState>): FieldViewState;
}

export function installFieldVolumeDebug(host: Host): void {
  if (typeof window === 'undefined') return;
  window.fieldVolume = {
    info: () => fieldVolumeInfo(host),
    async probeGpu(points) {
      const pass = host.fieldVolume;
      const id = host.fieldReadout?.deviceId;
      if (!pass || !id) return null;
      const bench = driveState(host).benches.get(id);
      if (!bench) return null;
      const pts = points?.length ? points : [host.fieldReadout!.point];
      const res = await pass.probeGpu(pts, bench.unitM);
      if (!res) return null;
      // CPU reference over the very sources the GPU summed (a moving bench —
      // SEG rollers — has live sources a frame or more ahead of the sweep).
      const u = bench.unitM;
      let maxRelErr = 0;
      const gpu: number[][] = [], cpu: number[][] = [];
      pts.forEach((p, i) => {
        const g = [res.B[i * 4], res.B[i * 4 + 1], res.B[i * 4 + 2]];
        const c = [...evaluateFieldT(p[0] * u, p[1] * u, p[2] * u, res.sources, res.count)];
        gpu.push(g);
        cpu.push(c);
        const err = Math.hypot(g[0] - c[0], g[1] - c[1], g[2] - c[2]) / (Math.hypot(c[0], c[1], c[2]) + 1e-12);
        maxRelErr = Math.max(maxRelErr, err);
      });
      return { gpu, cpu, maxRelErr };
    },
    setView(patch) {
      host.fieldView = { ...(host.fieldView ?? initialFieldView()), ...patch };
      return { ...host.fieldView };
    }
  };
}
