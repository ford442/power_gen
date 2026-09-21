/**
 * Web Bluetooth UART transport — wireless hardware twin (ADR-0005 WS3).
 *
 * Classroom tables often cannot run a USB cable to the bench, so the same
 * newline protocol (docs/hardware_connection.md) also rides a **Nordic UART
 * Service**-style GATT pair, which is what nRF52 / ESP32 / micro:bit UART
 * bridges expose:
 *
 *   service 6e400001-…  RX 6e400002-… (write, app → board)
 *                       TX 6e400003-… (notify, board → app)
 *
 * Three BLE facts shape this file:
 *
 * 1. **Writes are GATT operations and cannot overlap.** Everything goes through
 *    a {@link WriteQueue}; a backlog is dropped rather than queued, because the
 *    bridge re-sends the current setpoint every frame anyway.
 * 2. **A write without response carries ~20 bytes** on a default-MTU link, so
 *    lines are chunked. Chunks stay in order because the queue is serial.
 * 3. **The link is much slower than 60 Hz.** {@link BLE_COMMAND_THROTTLE_MS}
 *    asks the bridge for 20 Hz — comfortably inside the firmware's 100 ms
 *    watchdog, and far enough inside the browser host timeout (200 ms) that a
 *    normal frame doesn't trip a coast.
 *
 * Safety is unchanged: the bridge writes coast + coils-off before `close()`,
 * and `close()` drains the queue so those two lines actually reach the board.
 * A `gattserverdisconnected` event (out of range, battery, power switch) is a
 * drop, which the bridge treats exactly like a yanked USB cable.
 */
import { LineTransport, WriteQueue, type HardwareTransportKind } from './hardware-transport';

/** Nordic UART Service. Lower-case: Web Bluetooth rejects upper-case UUIDs. */
export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
/** Board's receive characteristic — the app writes commands here. */
export const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
/** Board's transmit characteristic — the app subscribes for the `S` stream. */
export const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

/** Bytes per write-without-response on a default-MTU (23 B) BLE link. */
export const BLE_WRITE_CHUNK_BYTES = 20;
/** 20 Hz — under the 100 ms firmware watchdog, over the BLE connection interval. */
export const BLE_COMMAND_THROTTLE_MS = 50;

/** Split a framed line into MTU-sized chunks, in order. */
export function chunkForBle(bytes: Uint8Array, size = BLE_WRITE_CHUNK_BYTES): Uint8Array[] {
  if (bytes.length <= size) return [bytes];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return out;
}

export interface BluetoothUartOptions {
  /** Extra services to request access to (custom bridges that wrap NUS). */
  optionalServices?: BluetoothServiceUUID[];
  /** Skip the chooser by reusing a device the page already has permission for. */
  device?: BluetoothDevice;
}

export class BluetoothUartTransport extends LineTransport {
  readonly kind: HardwareTransportKind = 'bluetooth';
  readonly label = 'Web Bluetooth (NUS)';
  readonly preferredCommandThrottleMs = BLE_COMMAND_THROTTLE_MS;

  private device: BluetoothDevice | null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private readonly queue: WriteQueue;
  private readonly onGattDisconnected = () => {
    this.reportDrop(new Error('BLE link lost (gattserverdisconnected)'));
  };
  private readonly onNotify = (ev: Event) => {
    const value = (ev.target as BluetoothRemoteGATTCharacteristic | null)?.value;
    if (!value) return;
    this.pushChunk(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  };

  constructor(private readonly options: BluetoothUartOptions = {}) {
    super();
    this.device = options.device ?? null;
    this.queue = new WriteQueue((err) => {
      if (!this.closing) console.warn('[bluetoothTransport] write failed', err.message);
    });
  }

  protected async openLink(): Promise<void> {
    if (!navigator.bluetooth?.requestDevice) throw new Error('Web Bluetooth unavailable');
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE_UUID] }],
        optionalServices: [NUS_SERVICE_UUID, ...(this.options.optionalServices ?? [])]
      });
    }
    if (!this.device.gatt) throw new Error('BLE device exposes no GATT server');

    this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(NUS_SERVICE_UUID);
    this.rx = await service.getCharacteristic(NUS_RX_CHAR_UUID);
    this.tx = await service.getCharacteristic(NUS_TX_CHAR_UUID);
    this.tx.addEventListener('characteristicvaluechanged', this.onNotify);
    await this.tx.startNotifications();
  }

  protected writeBytes(bytes: Uint8Array): void {
    const rx = this.rx;
    if (!rx) return;
    for (const chunk of chunkForBle(bytes)) {
      // `subarray` views the caller's buffer; the queue runs later, so copy.
      const payload = new Uint8Array(chunk);
      this.queue.push(() =>
        rx.writeValueWithoutResponse
          ? rx.writeValueWithoutResponse(payload)
          : rx.writeValue(payload)
      );
    }
  }

  /** Let the queued coast + coils-off lines land before the GATT link closes. */
  override async flush(): Promise<void> {
    await this.queue.drain();
  }

  protected async closeLink(): Promise<void> {
    this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    if (this.tx) {
      this.tx.removeEventListener('characteristicvaluechanged', this.onNotify);
      try { await this.tx.stopNotifications(); } catch { /* link already down */ }
      this.tx = null;
    }
    this.rx = null;
    try { this.server?.disconnect(); } catch { /* already disconnected */ }
    this.server = null;
    // Keep `device` so a reconnect can skip the chooser if the caller reuses us.
  }
}
