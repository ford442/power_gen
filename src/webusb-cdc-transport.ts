/**
 * WebUSB CDC-ACM transport — last resort for boards Web Serial cannot see
 * (ADR-0005 WS3).
 *
 * Web Serial is the right API for anything that enumerates as a serial port, so
 * **prefer it**. This transport exists for the narrow case the epic calls out:
 * a board whose CDC interface the platform does not hand to Web Serial. It
 * talks to the same CDC-ACM interface directly — claim the data interface, bulk
 * in / bulk out, newline framing as usual.
 *
 * Caveat worth knowing before filing a bug: on most platforms the OS CDC driver
 * has already claimed the interface, and `claimInterface()` then fails with a
 * security error. That is not a code fault — it is why Web Serial is the
 * documented path and this one is optional.
 */
import { LineTransport, WriteQueue, type HardwareTransportKind } from './hardware-transport';

/** USB CDC Data interface class (bulk endpoints live here). */
const USB_CLASS_CDC_DATA = 0x0a;
/** USB CDC Communications interface class (holds the ACM control requests). */
const USB_CLASS_CDC_CONTROL = 0x02;
/** CDC `SET_CONTROL_LINE_STATE`; DTR|RTS makes most boards start streaming. */
const CDC_SET_CONTROL_LINE_STATE = 0x22;
const CDC_DTR_RTS = 0x03;
/** One bulk read; the `S` stream is ~60 B per line at 100–200 Hz. */
const USB_READ_BYTES = 256;

/** Same vendors as the Web Serial filters — see SERIAL_PORT_FILTERS. */
export const USB_DEVICE_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x2341 },
  { vendorId: 0x2a03 },
  { vendorId: 0x1a86 },
  { vendorId: 0x10c4 },
  { vendorId: 0x0403 },
  { vendorId: 0x303a }
];

interface CdcEndpoints {
  interfaceNumber: number;
  endpointIn: number;
  endpointOut: number;
}

/**
 * Find a CDC Data interface with both a bulk IN and a bulk OUT endpoint.
 * Exported for the contract test — no USB device needed to check the walk.
 */
export function findCdcEndpoints(configuration: USBConfiguration | null | undefined): CdcEndpoints | null {
  for (const iface of configuration?.interfaces ?? []) {
    for (const alt of iface.alternates ?? []) {
      if (alt.interfaceClass !== USB_CLASS_CDC_DATA) continue;
      const inEp = alt.endpoints?.find((e) => e.direction === 'in' && e.type === 'bulk');
      const outEp = alt.endpoints?.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (inEp && outEp) {
        return {
          interfaceNumber: iface.interfaceNumber,
          endpointIn: inEp.endpointNumber,
          endpointOut: outEp.endpointNumber
        };
      }
    }
  }
  return null;
}

/** Interface number of the CDC control interface, if the device has one. */
export function findCdcControlInterface(configuration: USBConfiguration | null | undefined): number | null {
  for (const iface of configuration?.interfaces ?? []) {
    for (const alt of iface.alternates ?? []) {
      if (alt.interfaceClass === USB_CLASS_CDC_CONTROL) return iface.interfaceNumber;
    }
  }
  return null;
}

export class WebUsbCdcTransport extends LineTransport {
  readonly kind: HardwareTransportKind = 'usb';
  readonly label = 'WebUSB (CDC-ACM)';

  private device: USBDevice | null;
  private endpoints: CdcEndpoints | null = null;
  private readLoop: Promise<void> | null = null;
  private readonly queue: WriteQueue;

  constructor(device?: USBDevice) {
    super();
    this.device = device ?? null;
    this.queue = new WriteQueue((err) => {
      if (!this.closing) console.warn('[webusbTransport] write failed', err.message);
    });
  }

  protected async openLink(): Promise<void> {
    if (!navigator.usb?.requestDevice) throw new Error('WebUSB unavailable');
    if (!this.device) {
      this.device = await navigator.usb.requestDevice({ filters: USB_DEVICE_FILTERS });
    }
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);

    const endpoints = findCdcEndpoints(this.device.configuration);
    if (!endpoints) {
      throw new Error('No CDC-ACM data interface with bulk endpoints — use Web Serial instead');
    }
    await this.device.claimInterface(endpoints.interfaceNumber);
    this.endpoints = endpoints;

    // Assert DTR/RTS so boards that gate output on an open host start talking.
    const control = findCdcControlInterface(this.device.configuration);
    if (control !== null) {
      try {
        await this.device.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: CDC_SET_CONTROL_LINE_STATE,
          value: CDC_DTR_RTS,
          index: control
        });
      } catch (err) {
        // Optional: plenty of boards stream regardless.
        console.info('[webusbTransport] SET_CONTROL_LINE_STATE skipped', err);
      }
    }

    this.readLoop = this.pump();
  }

  private async pump(): Promise<void> {
    while (this.device && this.endpoints && !this.closing) {
      try {
        const result = await this.device.transferIn(this.endpoints.endpointIn, USB_READ_BYTES);
        if (result.status === 'stall') {
          await this.device.clearHalt('in', this.endpoints.endpointIn);
          continue;
        }
        if (result.data?.byteLength) {
          const d = result.data;
          this.pushChunk(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
        }
      } catch (err) {
        this.reportDrop(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }

  protected writeBytes(bytes: Uint8Array): void {
    const device = this.device;
    const ep = this.endpoints?.endpointOut;
    if (!device || ep === undefined) return;
    const payload = new Uint8Array(bytes);
    this.queue.push(() => device.transferOut(ep, payload));
  }

  override async flush(): Promise<void> {
    await this.queue.drain();
  }

  protected async closeLink(): Promise<void> {
    const device = this.device;
    const iface = this.endpoints?.interfaceNumber;
    this.endpoints = null;
    this.readLoop = null;
    if (device && iface !== undefined) {
      try { await device.releaseInterface(iface); } catch { /* unplugged */ }
    }
    if (device) {
      try { await device.close(); } catch { /* unplugged */ }
    }
    this.device = null;
  }
}
