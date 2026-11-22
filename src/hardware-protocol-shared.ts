/**
 * Shared protocol constants/helpers for hardware-bridge.ts, mock-serial-transport.ts
 * and hardware-bridge-protocol.ts. Kept dependency-free so none of those three files
 * form an import cycle with each other.
 *
 * Protocol: docs/hardware_connection.md / firmware/seg-driver/protocol.h
 */

/**
 * Twin / digital-twin operating modes. `estimate` (#257) was `shadow`: the sim
 * still drives the coils, and the EKF (cpp/src/twin/ekf.h) estimates the rig's
 * state from the samples — the residual is its normalised innovation.
 */
export const TWIN_MODES = {
  OPEN: 'open',
  CLOSED: 'closed',
  ESTIMATE: 'estimate'
} as const;

export type TwinMode = (typeof TWIN_MODES)[keyof typeof TWIN_MODES];

/** A twin mode, accepting the pre-#257 name `shadow` for `estimate`; null if unknown. */
export function normalizeTwinMode(mode: unknown): TwinMode | null {
  if (mode === 'shadow') return TWIN_MODES.ESTIMATE;
  return (Object.values(TWIN_MODES) as string[]).includes(mode as string) ? mode as TwinMode : null;
}

export const MODE_RUN = 0;
export const MODE_BRAKE = 1;
export const MODE_COAST = 2;

/**
 * Line protocol this host speaks (`PROTOCOL_VERSION` in protocol.h). v2 adds
 * only the hello exchange; v3 (#257) adds hardware timestamps — after a `V3`
 * request a v3 board prefixes every sample `S t=<µs> …` (its 32-bit
 * `micros()`). Every command the host sends is still a v1 line, so v1 and v2
 * sketches are driven — and coasted — exactly as before.
 */
export const HOST_PROTOCOL_VERSION = 3;
/**
 * Hello request. A v3 board answers `I v=3 …` and starts timestamping; a v2
 * board answers `I v=2 …` to any `V…`; a v1 sketch drops it.
 */
export const HELLO_COMMAND = `V${HOST_PROTOCOL_VERSION}`;
/** An Uno resets when the port opens and can miss the first request. */
export const HELLO_ATTEMPTS = 5;
export const HELLO_RETRY_MS = 1000;

/** The board's `I v=N …` hello (docs/hardware_connection.md → I). */
export interface FirmwareHello {
  protocol: number;
  firmware: string;
  board: string;
  link: string;
  /** Wired coils — the board clamps `CONF` to this. */
  coils: number | null;
  halls: number | null;
  watchdogMs: number | null;
  brakePwmMax: number | null;
  brakeMaxMs: number | null;
}

const HELLO_WORD = /^[A-Za-z0-9._-]{1,32}$/;
const HELLO_UINT = /^\d{1,6}$/;

/**
 * Parse an `I` line's text (with or without the leading `I`). Returns null for
 * anything that is not a hello, so ordinary info lines keep going to the log.
 * Values are untrusted device output: words are restricted to a short
 * identifier alphabet and numbers to plain unsigned integers.
 */
export function parseFirmwareHello(text: string): FirmwareHello | null {
  const body = String(text).replace(/^I/, '').trim();
  if (!body.startsWith('v=')) return null;
  const fields = new Map<string, string>();
  for (const token of body.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const v = fields.get('v') ?? '';
  if (!HELLO_UINT.test(v) || Number(v) < 2) return null;
  const word = (key: string): string => {
    const s = fields.get(key) ?? '';
    return HELLO_WORD.test(s) ? s : 'unknown';
  };
  const uint = (s: string | undefined): number | null =>
    s !== undefined && HELLO_UINT.test(s) ? Number(s) : null;
  const [brakePwm, brakeMs] = (fields.get('brake') ?? '').split('/');
  return {
    protocol: Number(v),
    firmware: word('fw'),
    board: word('board'),
    link: word('link'),
    coils: uint(fields.get('coils')),
    halls: uint(fields.get('halls')),
    watchdogMs: uint(fields.get('wd')),
    brakePwmMax: uint(brakePwm),
    brakeMaxMs: uint(brakeMs)
  };
}

/** Protocol RPM limits (docs/hardware_connection.md). */
export const RPM_MIN = -999.9;
export const RPM_MAX = 999.9;

export function finiteNum(n: unknown, fallback = 0): number {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

export function clampRpm(rpm: unknown): number {
  return Math.max(RPM_MIN, Math.min(RPM_MAX, finiteNum(rpm, 0)));
}

export function clampPwmDuty(duty: unknown): number {
  return Math.max(0, Math.min(1, finiteNum(duty, 0)));
}

export function pwmDutyToWire(duty: number): number {
  return Math.round(clampPwmDuty(duty) * 255);
}

/**
 * One `S` line: `S<v1 fields>` (v1/v2) or `S t=<µs> <v1 fields>` (v3). The
 * fields are the v1 comma list either way; `tUs` is the raw 32-bit board
 * clock, or null without one. Malformed `t=` → null (the line is not trusted).
 */
export function splitSensorLine(line: string): { tUs: number | null; fields: string[] } | null {
  let body = line.slice(1);
  let tUs: number | null = null;
  const m = /^\s*t=(\d{1,10})\s+/.exec(body);
  if (m) {
    tUs = Number(m[1]);
    if (!(tUs <= 0xffffffff)) return null;
    body = body.slice(m[0].length);
  } else if (/^\s*t=/.test(body)) {
    return null;
  }
  return { tUs, fields: body.split(',') };
}

/** Where a sample's time came from: v3 board µs, the v1 `millis()` field, or host arrival. */
export type SampleClockSource = 'board-us' | 'board-ms' | 'host';

const WRAP = 2 ** 32;

/**
 * Sample clock (#257 §4): unwrapped board time of each `S` line, in seconds.
 * The estimator integrates between consecutive samples, so it needs the
 * board's sample spacing — not the host's arrival jitter (USB polling, BLE
 * connection events, a busy frame). Best source wins: v3 µs, else the v1 ms
 * field, else `performance.now()`. A 32-bit counter wraps forward (µs every
 * ~71.6 min); a backward step of less than half the range is a board reset or
 * a source change, and bumps `epoch` so the estimator re-initialises.
 */
export class SampleClock {
  /** Unwrapped time of the last sample, s (NaN before the first). */
  t = NaN;
  source: SampleClockSource = 'host';
  /** Bumps when the time base restarts (reset, reconnect, source change). */
  epoch = 0;
  private lastRaw = NaN;
  private offset = 0;

  reset(): void {
    this.t = NaN;
    this.lastRaw = NaN;
    this.offset = 0;
    this.epoch++;
  }

  /** Stamp one sample; returns its time (s). */
  stamp(tUs: number | null, tMs: number | null, hostMs: number): number {
    let source: SampleClockSource = 'host';
    let raw = hostMs;
    let scale = 1e-3;
    if (tUs !== null) {
      source = 'board-us';
      raw = tUs;
      scale = 1e-6;
    } else if (tMs !== null && tMs > 0 && (this.source !== 'host' || Number.isNaN(this.t))) {
      source = 'board-ms';
      raw = tMs;
    }
    if (source !== this.source) {
      this.source = source;
      this.reset();
    }
    if (source !== 'host' && !Number.isNaN(this.lastRaw) && raw < this.lastRaw) {
      if (this.lastRaw - raw > WRAP / 2) this.offset += WRAP;
      else this.reset();
    }
    this.lastRaw = raw;
    this.t = (raw + this.offset) * scale;
    return this.t;
  }
}
