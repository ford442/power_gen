/**
 * Versioned replay file format for layout preset + speed curve + optional samples.
 */

import { setSimulationSeed } from './deterministic-rng';
import type { TelemetryCsvRow } from './telemetry-schema';

export const REPLAY_VERSION = 1;

export interface SpeedKeyframe {
  t: number;
  drive: number;
  simRate?: number;
}

export interface ReplayFile {
  replayVersion: number;
  createdAt: string;
  seed: number | null;
  segLayoutPreset: string;
  heronLayoutPreset: string;
  renderer: string | null;
  speedCurve: SpeedKeyframe[];
  config: {
    loadOhm: number;
    magneticFieldStrength: number;
    sampleHz: number;
  };
  samples: TelemetryCsvRow[] | Record<string, number | string>[];
}

export interface BuildReplayFileOpts {
  seed?: number | null;
  segLayoutPreset?: string;
  heronLayoutPreset?: string;
  speedCurve?: SpeedKeyframe[];
  sampleHz?: number;
  samples?: TelemetryCsvRow[] | Record<string, number | string>[];
}

export function buildReplayFile(opts: BuildReplayFileOpts = {}): ReplayFile {
  const v = window.multiVisualizer;
  const speedMult = v?.speedMult ?? 1;
  const drive = window.segOperator?.targetDrive ?? 0.5;

  return {
    replayVersion: REPLAY_VERSION,
    createdAt: new Date().toISOString(),
    seed: opts.seed ?? null,
    segLayoutPreset: opts.segLayoutPreset ?? v?.getSEGLayoutPreset?.() ?? v?.segLayoutPreset ?? 'searl',
    heronLayoutPreset: opts.heronLayoutPreset ?? v?.heronLayoutPreset ?? 'classic',
    renderer: window.currentRenderer ?? null,
    speedCurve: opts.speedCurve ?? [
      { t: 0, drive, simRate: speedMult },
      { t: 10, drive, simRate: speedMult }
    ],
    config: {
      loadOhm: window.segOperator?.loadResistance ?? 100,
      magneticFieldStrength: window.segOperator?.magneticFieldStrength ?? 0.5,
      sampleHz: opts.sampleHz ?? 10
    },
    samples: opts.samples ?? []
  };
}

/** Interpolate drive and sim rate at simulation time t. */
export function interpolateSpeedCurve(curve: SpeedKeyframe[], t: number): { drive: number; simRate: number } {
  if (!curve?.length) return { drive: 0.5, simRate: 1 };
  if (curve.length === 1) {
    return { drive: curve[0].drive ?? 0.5, simRate: curve[0].simRate ?? 1 };
  }
  let i = 0;
  while (i < curve.length - 1 && curve[i + 1].t <= t) i++;
  const a = curve[i];
  const b = curve[Math.min(i + 1, curve.length - 1)];
  if (a.t === b.t) return { drive: a.drive, simRate: a.simRate ?? 1 };
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return {
    drive: a.drive + (b.drive - a.drive) * u,
    simRate: (a.simRate ?? 1) + ((b.simRate ?? 1) - (a.simRate ?? 1)) * u
  };
}

export interface ApplyReplayOpts {
  onProgress?: (t: number) => void;
}

/**
 * Apply replay to live dashboard (layout preset + speed curve playback).
 * @returns cancel playback
 */
export function applyReplay(replay: ReplayFile, opts: ApplyReplayOpts = {}): () => void {
  if (replay.replayVersion !== REPLAY_VERSION) {
    throw new Error(`Unsupported replay version: ${replay.replayVersion}`);
  }

  const v = window.multiVisualizer;
  if (!v) throw new Error('Visualizer not ready');

  if (replay.seed != null) {
    setSimulationSeed(replay.seed);
  }

  if (replay.segLayoutPreset && typeof v.setSEGLayoutPreset === 'function') {
    v.setSEGLayoutPreset(replay.segLayoutPreset);
  } else if (replay.segLayoutPreset && typeof window.setSEGLayout === 'function') {
    window.setSEGLayout(replay.segLayoutPreset);
  }

  if (replay.heronLayoutPreset && typeof v.setHeronLayoutPreset === 'function') {
    v.setHeronLayoutPreset(replay.heronLayoutPreset);
  } else if (replay.heronLayoutPreset && typeof window.setHeronLayout === 'function') {
    window.setHeronLayout(replay.heronLayoutPreset);
  }

  const curve = replay.speedCurve || [];
  const op = window.segOperator;
  let cancelled = false;
  let simT = 0;
  const dt = 1 / 60;
  let raf = 0;

  const tick = () => {
    if (cancelled) return;
    const { drive, simRate } = interpolateSpeedCurve(curve, simT);
    if (op) {
      op.targetDrive = drive;
      if (!op.isRunning) op.start?.();
    }
    const slider = document.getElementById('speedControl') as HTMLInputElement | null;
    if (slider) {
      const raw = 100 * Math.log(Math.max(0.05, simRate) / 0.05) / Math.log(400);
      slider.value = String(Math.max(0, Math.min(100, Math.round(raw))));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (v && typeof v.speedMult === 'number') {
      v.speedMult = simRate;
    }
    simT += dt;
    opts.onProgress?.(simT);
    const endT = curve.length ? curve[curve.length - 1].t : 10;
    if (simT < endT) {
      raf = requestAnimationFrame(tick);
    }
  };

  raf = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}
