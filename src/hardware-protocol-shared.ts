/**
 * Shared protocol constants/helpers for hardware-bridge.ts, mock-serial-transport.ts
 * and hardware-bridge-protocol.ts. Kept dependency-free so none of those three files
 * form an import cycle with each other.
 *
 * Protocol: docs/hardware_connection.md / firmware/seg-driver/protocol.h
 */

/** Twin / digital-twin operating modes */
export const TWIN_MODES = {
  OPEN: 'open',
  CLOSED: 'closed',
  SHADOW: 'shadow'
} as const;

export type TwinMode = (typeof TWIN_MODES)[keyof typeof TWIN_MODES];

export const MODE_RUN = 0;
export const MODE_BRAKE = 1;
export const MODE_COAST = 2;

/**
 * Line protocol this host speaks (`PROTOCOL_VERSION` in protocol.h). v2 adds
 * only the hello exchange; every command the host sends is still a v1 line, so
 * a v1 sketch is driven — and coasted — exactly as before.
 */
export const HOST_PROTOCOL_VERSION = 2;
/** Hello request. A v2 board answers `I v=2 …`; a v1 sketch drops it. */
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
