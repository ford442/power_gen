/**
 * Window-free replay parse (safe in a Web Worker).
 */

import { csvToRows, type TelemetryCsvRow } from './telemetry-schema';
import { REPLAY_VERSION, type ReplayFile, type SpeedKeyframe } from './replay-format';

export interface ReplayParseResult {
  replay: ReplayFile;
  source: 'json' | 'csv';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function speedCurveFromSamples(samples: TelemetryCsvRow[]): SpeedKeyframe[] {
  if (!samples.length) return [{ t: 0, drive: 0.5, simRate: 1 }];
  const out: SpeedKeyframe[] = [];
  let lastDrive = Number.NaN;
  for (const row of samples) {
    const t = num(row.time_s);
    const drive = num(row.drive, 0.5);
    if (!out.length || Math.abs(drive - lastDrive) > 1e-4 || t === num(samples[samples.length - 1].time_s)) {
      out.push({ t, drive, simRate: 1 });
      lastDrive = drive;
    }
  }
  if (out.length === 1) {
    out.push({ t: num(samples[samples.length - 1].time_s, 10), drive: out[0].drive, simRate: 1 });
  }
  return out;
}

/** Build a minimal ReplayFile from recorded / offline CSV rows. */
export function replayFromCsvRows(rows: TelemetryCsvRow[]): ReplayFile {
  const first = rows[0];
  const loadOhm = first ? num(first.load_ohm, 100) : 100;
  const excitation = first ? num(first.excitation_pct, 50) : 50;
  const t0 = first ? num(first.time_s) : 0;
  const t1 = rows.length ? num(rows[rows.length - 1].time_s, t0) : t0;
  const span = Math.max(0, t1 - t0);
  const sampleHz = rows.length > 1 && span > 0 ? (rows.length - 1) / span : 10;
  return {
    replayVersion: REPLAY_VERSION,
    createdAt: new Date().toISOString(),
    seed: null,
    segLayoutPreset: 'searl',
    heronLayoutPreset: 'classic',
    renderer: null,
    speedCurve: speedCurveFromSamples(rows),
    config: {
      loadOhm,
      magneticFieldStrength: Math.max(0, Math.min(1, excitation / 100)),
      sampleHz: Math.min(60, Math.max(1, sampleHz))
    },
    samples: rows
  };
}

export function replayFromCsvText(text: string): ReplayFile {
  const rows = csvToRows(text);
  if (!rows.length) {
    throw new Error('CSV has no telemetry rows (need header + at least one sample)');
  }
  return replayFromCsvRows(rows);
}

export function validateReplayFile(raw: unknown): ReplayFile {
  if (!isRecord(raw)) throw new Error('Replay file is not a JSON object');
  const version = num(raw.replayVersion, NaN);
  if (!Number.isFinite(version)) throw new Error('Missing replayVersion');
  if (version !== REPLAY_VERSION) throw new Error(`Unsupported replay version: ${version}`);

  const samplesRaw = raw.samples;
  const samples = Array.isArray(samplesRaw) ? (samplesRaw as TelemetryCsvRow[]) : [];
  const curveRaw = raw.speedCurve;
  const speedCurve: SpeedKeyframe[] = Array.isArray(curveRaw)
    ? curveRaw.map((k) => {
      const rec = isRecord(k) ? k : {};
      return { t: num(rec.t), drive: num(rec.drive, 0.5), simRate: rec.simRate == null ? 1 : num(rec.simRate, 1) };
    })
    : speedCurveFromSamples(samples);

  const cfg = isRecord(raw.config) ? raw.config : {};
  return {
    replayVersion: REPLAY_VERSION,
    createdAt: str(raw.createdAt, new Date().toISOString()),
    seed: raw.seed == null ? null : num(raw.seed),
    segLayoutPreset: str(raw.segLayoutPreset, 'searl'),
    heronLayoutPreset: str(raw.heronLayoutPreset, 'classic'),
    renderer: raw.renderer == null ? null : str(raw.renderer),
    speedCurve,
    config: {
      loadOhm: num(cfg.loadOhm, 100),
      magneticFieldStrength: num(cfg.magneticFieldStrength, 0.5),
      sampleHz: num(cfg.sampleHz, 10)
    },
    samples
  };
}

export function looksLikeCsv(text: string, filename?: string): boolean {
  if (filename && /\.csv$/i.test(filename)) return true;
  const first = text.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/, 1)[0] || '';
  return first.startsWith('time_s,') || first.includes('time_s,frame_id');
}

export function parseReplayPayload(text: string, filename?: string): ReplayParseResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error('Empty replay file');
  if (looksLikeCsv(trimmed, filename) || trimmed[0] !== '{') {
    return { replay: replayFromCsvText(trimmed), source: 'csv' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { replay: validateReplayFile(raw), source: 'json' };
}

/** Linear interpolation of numeric sample fields at simulation time t. */
export function interpolateSample(
  samples: TelemetryCsvRow[] | Record<string, number | string>[],
  t: number
): TelemetryCsvRow | null {
  if (!samples?.length) return null;
  const rows = samples as TelemetryCsvRow[];
  if (t <= num(rows[0].time_s)) return rows[0];
  const last = rows[rows.length - 1];
  if (t >= num(last.time_s)) return last;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (num(rows[mid].time_s) <= t) lo = mid;
    else hi = mid;
  }
  const a = rows[lo];
  const b = rows[hi];
  const ta = num(a.time_s);
  const tb = num(b.time_s);
  const u = tb === ta ? 0 : (t - ta) / (tb - ta);
  const out = { ...a } as TelemetryCsvRow;
  for (const key of Object.keys(a) as (keyof TelemetryCsvRow)[]) {
    const va = a[key];
    const vb = b[key];
    if (typeof va === 'number' && typeof vb === 'number') {
      (out[key] as number) = va + (vb - va) * u;
    }
  }
  return out;
}

export function sampleIndexAt(
  samples: TelemetryCsvRow[] | Record<string, number | string>[],
  t: number
): number {
  if (!samples?.length) return 0;
  const rows = samples as TelemetryCsvRow[];
  let i = 0;
  while (i < rows.length - 1 && num(rows[i + 1].time_s) <= t) i++;
  return i;
}

export function replayDurationS(replay: ReplayFile): number {
  const samples = replay.samples as TelemetryCsvRow[] | undefined;
  if (samples?.length) {
    return Math.max(0, num(samples[samples.length - 1].time_s) - num(samples[0].time_s));
  }
  const curve = replay.speedCurve || [];
  if (!curve.length) return 0;
  return Math.max(0, curve[curve.length - 1].t - curve[0].t);
}

export function replayStartS(replay: ReplayFile): number {
  const samples = replay.samples as TelemetryCsvRow[] | undefined;
  if (samples?.length) return num(samples[0].time_s);
  return replay.speedCurve?.[0]?.t ?? 0;
}
