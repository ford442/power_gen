/**
 * Web Serial (USB CDC) transport — the reference hardware-twin link.
 *
 * This is the path `docs/hardware_connection.md` documents and the one the
 * experimental `firmware/seg-driver/` sketch speaks: 115200 8N1, newline
 * framed. Chrome / Edge in a secure context only; `requestPort()` needs a user
 * gesture, so it is always called straight from a button handler.
 *
 * Lifted out of HardwareBridge when Bluetooth / WebUSB joined it
 * (ADR-0005 WS3): the read loop, the TextDecoderStream and the writer lock all
 * belong to the link, not to the protocol.
 */
import { LineTransport, type HardwareTransportKind } from './hardware-transport';

/**
 * Common Arduino-ish USB-serial vendor IDs: Arduino LLC / Arduino SA, CH340,
 * CP210x, FTDI, Espressif.
 */
export const SERIAL_PORT_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x2341 },
  { usbVendorId: 0x2a03 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x0403 },
  { usbVendorId: 0x303a }
];

export class SerialLineTransport extends LineTransport {
  readonly kind: HardwareTransportKind = 'serial';
  readonly label = 'Web Serial';

  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  /**
   * The `port.readable` → decoder pipe. Kept because `reader.cancel()` resolves
   * before the pipe has finished cancelling its *source*, so closing the port
   * immediately after would reject with the stream still locked — and the
   * `catch` around `port.close()` would swallow it, leaving the port open and
   * the device claimed until the tab dies. A later reconnect then fails on
   * `port.open()`.
   */
  private pipeDone: Promise<void> | null = null;

  constructor(private readonly baudRate = 115200, port?: SerialPort) {
    super();
    this.port = port ?? null;
  }

  protected async openLink(): Promise<void> {
    if (!navigator.serial) throw new Error('Web Serial unavailable');
    const port = this.port
      ?? (this.port = await navigator.serial.requestPort({ filters: SERIAL_PORT_FILTERS }));
    await port.open({ baudRate: this.baudRate });
    if (!port.writable || !port.readable) {
      throw new Error('Serial port opened without readable/writable streams');
    }
    this.writer = port.writable.getWriter();
    const decoder = new TextDecoderStream();
    // `TextDecoderStream.writable` is typed `WritableStream<BufferSource>`; the
    // port's byte stream is a narrower Uint8Array source, hence the cast.
    this.pipeDone = port.readable
      .pipeTo(decoder.writable as unknown as WritableStream<Uint8Array>)
      .catch(() => { /* closed with the port */ });
    this.reader = decoder.readable.getReader();
    this.readLoop = this.pump();
  }

  private async pump(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    for (;;) {
      try {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.pushChunk(value);
      } catch (err) {
        this.reportDrop(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    this.reportDrop(null);
  }

  protected writeBytes(bytes: Uint8Array): void {
    // Fire-and-forget: the coast/watchdog paths must not await a dead port.
    this.writer?.write(bytes).catch((err) => {
      if (!this.closing) console.warn('[serialTransport] write failed', err);
    });
  }

  protected async closeLink(): Promise<void> {
    if (this.reader) {
      try { await this.reader.cancel(); } catch { /* already gone */ }
      this.reader = null;
    }
    // Wait for the pipe to release `port.readable` before closing the port.
    if (this.pipeDone) {
      try { await this.pipeDone; } catch { /* already gone */ }
      this.pipeDone = null;
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* already released */ }
      this.writer = null;
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch (err) {
        // Not silent: a close that fails leaves the device claimed, and the
        // symptom (a reconnect that cannot open the port) is otherwise baffling.
        console.warn('[serialTransport] port.close() failed — device may stay claimed', err);
      }
      this.port = null;
    }
    this.readLoop = null;
  }
}
