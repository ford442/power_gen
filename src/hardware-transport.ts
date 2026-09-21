/**
 * Line-oriented transport abstraction for the hardware twin (ADR-0005 WS3).
 *
 * `HardwareBridge` speaks one wire protocol (docs/hardware_connection.md):
 * newline-terminated ASCII commands out (`P` / `C` / `CONF`), newline-terminated
 * state lines in (`S` / `E` / `I`). *How* those bytes move is a transport
 * concern, so every link implements the same tiny surface:
 *
 *   - `mock`      — {@link MockSerialTransport}, no hardware (CI / demos)
 *   - `serial`    — Web Serial / USB CDC (the reference link)
 *   - `bluetooth` — Nordic-UART-style GATT, for wireless classroom tables
 *   - `usb`       — raw WebUSB CDC-ACM, only for boards the OS won't expose
 *                   as a serial port
 *
 * Transports never interpret the protocol: they frame lines and report drops.
 * The bridge keeps all the safety logic (coast on disconnect, host watchdog,
 * NaN-safe closed loop), so a new transport cannot introduce a new way to
 * leave coils energised.
 */

/** Which physical link a bridge is using. */
export type HardwareTransportKind = 'mock' | 'serial' | 'bluetooth' | 'usb';

/**
 * A device that babbles without newlines must not grow the receive buffer
 * forever. At 200 Hz the longest legal line (`S` with V/I) is well under 128 B.
 */
export const MAX_LINE_BYTES = 512;

export interface HardwareTransport {
  readonly kind: HardwareTransportKind;
  /** Short label for the panel's transport badge. */
  readonly label: string;
  /**
   * Command period this link can actually sustain, if it is slower than the
   * bridge default (~60 Hz). Must stay below the firmware watchdog (100 ms).
   */
  readonly preferredCommandThrottleMs?: number;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Send one protocol line. The transport appends the newline. */
  writeLine(text: string): void;
  /** Wait for queued writes to reach the link (BLE queues GATT ops). */
  flush?(): Promise<void>;
  onLine(fn: (line: string) => void): () => void;
  /** Link lost without `close()` being called (unplug, GATT disconnect, read error). */
  onDrop(fn: (err: Error | null) => void): () => void;
  /** Mock only: drive the synthetic V/I proxies used by the shadow charts. */
  setElectricalTargets?(voltage: number, current: number): void;
}

/**
 * Shared line framing, listener bookkeeping and newline encoding.
 *
 * Subclasses implement {@link openLink}, {@link closeLink} and
 * {@link writeBytes}, and call {@link pushChunk} with whatever bytes arrive.
 */
export abstract class LineTransport implements HardwareTransport {
  abstract readonly kind: HardwareTransportKind;
  abstract readonly label: string;

  private readonly _lineListeners = new Set<(line: string) => void>();
  private readonly _dropListeners = new Set<(err: Error | null) => void>();
  private readonly _decoder = new TextDecoder();
  private readonly _encoder = new TextEncoder();
  private _buffer = '';
  /** Set once the link is torn down so a late read error stays quiet. */
  protected closing = false;

  async open(): Promise<void> {
    this.closing = false;
    this._buffer = '';
    await this.openLink();
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.flush();
    } catch {
      /* link may already be gone — closing anyway */
    }
    await this.closeLink();
    this._buffer = '';
  }

  writeLine(text: string): void {
    this.writeBytes(this._encoder.encode(`${text}\n`));
  }

  /** Default: writes are synchronous on the link, nothing to wait for. */
  async flush(): Promise<void> {}

  onLine(fn: (line: string) => void): () => void {
    this._lineListeners.add(fn);
    return () => this._lineListeners.delete(fn);
  }

  onDrop(fn: (err: Error | null) => void): () => void {
    this._dropListeners.add(fn);
    return () => this._dropListeners.delete(fn);
  }

  /** Feed raw bytes (or already-decoded text) in; whole lines come out. */
  protected pushChunk(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string'
      ? chunk
      : this._decoder.decode(chunk, { stream: true });
    if (!text) return;
    this._buffer += text;
    let nl: number;
    while ((nl = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (line.length > 0) this.emitLine(line);
    }
    if (this._buffer.length > MAX_LINE_BYTES) {
      // Unframed garbage (wrong baud, binary firmware): drop it rather than grow.
      this._buffer = '';
    }
  }

  protected emitLine(line: string): void {
    for (const fn of this._lineListeners) {
      try {
        fn(line);
      } catch (e) {
        console.warn(`[${this.kind}Transport] line listener`, e);
      }
    }
  }

  /** Report an unrequested link loss. No-op once `close()` has started. */
  protected reportDrop(err: Error | null): void {
    if (this.closing) return;
    this.closing = true;
    for (const fn of this._dropListeners) {
      try {
        fn(err);
      } catch (e) {
        console.warn(`[${this.kind}Transport] drop listener`, e);
      }
    }
  }

  protected abstract openLink(): Promise<void>;
  protected abstract closeLink(): Promise<void>;
  protected abstract writeBytes(bytes: Uint8Array): void;
}

/**
 * Serialises async link operations that must not overlap (a GATT characteristic
 * write, a WebUSB bulk transfer). Errors are reported once, through `onError`,
 * so a dropped link doesn't produce one rejection per queued command.
 */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  constructor(
    private readonly onError: (err: Error) => void,
    /** Commands are re-sent every frame; a deep backlog is staleness, not data. */
    private readonly maxDepth = 8
  ) {}

  push(op: () => Promise<unknown>): void {
    if (this.depth >= this.maxDepth) return;
    this.depth += 1;
    this.tail = this.tail
      .then(() => op())
      .then(
        () => { this.depth -= 1; },
        (err) => {
          this.depth -= 1;
          this.onError(err instanceof Error ? err : new Error(String(err)));
        }
      );
  }

  /** Resolves when everything queued so far has been attempted. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

/** Feature detection — all three APIs need a secure context and a user gesture. */
export function isSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.serial;
}

export function isBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth?.requestDevice;
}

export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.usb?.requestDevice;
}

/** Transports this browser could actually open, in preference order. */
export function supportedTransports(): HardwareTransportKind[] {
  const out: HardwareTransportKind[] = [];
  if (isSerialSupported()) out.push('serial');
  if (isBluetoothSupported()) out.push('bluetooth');
  if (isWebUsbSupported()) out.push('usb');
  out.push('mock');
  return out;
}
