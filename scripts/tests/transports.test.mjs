/**
 * transports — contracts for the hardware-twin transports
 * (ADR-0005 WS3: mock / serial / bluetooth / usb).
 *
 * Playwright covers the mock twin inside a real browser, but it cannot reach
 * the framing and safety logic that a *new* transport is most likely to break,
 * and no CI runner has a coil bench, a BLE board or a CDC device. This checks
 * the parts that are pure logic:
 *
 *   1. Line framing: split chunks, CRLF, several lines per chunk, binary bytes,
 *      and an unframed babbler that must not grow the buffer forever.
 *   2. WriteQueue serialises GATT/USB ops, caps its backlog, and drains.
 *   3. BLE chunking keeps every byte, in order, at the default-MTU size.
 *   4. The CDC descriptor walk finds bulk endpoints (and rejects a device
 *      without them).
 *   5. status ↔ connectionKind round-trips for every transport kind, and the
 *      header badge has a label for each one.
 *   6. **Safety:** disconnecting *any* transport writes coast + coils-off and
 *      flushes before the link closes; a transport switch coasts the old link
 *      first; and a dropped link clears the manual override.
 *   7. BLE asks for a throttle the firmware watchdog can live with.
 *   8. Protocol v2 hello: the host parses what seg_safety.h prints, asks with
 *      `V2` (after the P, at most five times), gives up on a v1 board and still
 *      drives and coasts it with v1 lines only, forgets the hello with the link,
 *      and its version / watchdog match firmware/seg-driver/protocol.h.
 *   9. A WebUSB read pump from a previous open cannot report a drop on, or
 *      read alongside, the next open (generation counter + awaited loop).
 *  10. `bridge.on(...)` delivers to every subscriber, unsubscribes, and a
 *      throwing listener does not stop the others.
 *
 * Usage: npm run test:transports   (node --test scripts/tests/transports.test.mjs)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let ble, usb, bridgeMod, shared, twin;
let LineTransport, WriteQueue, MAX_LINE_BYTES;
let HardwareBridge, statusForTransportKind, connectionKindForStatus;
/** Minimal LineTransport that records what was written and replays what we feed. */
let FakeTransport;

before(async () => {
  const transport = await bundleTs('src/hardware-transport.ts');
  ble = await bundleTs('src/bluetooth-uart-transport.ts');
  usb = await bundleTs('src/webusb-cdc-transport.ts');
  bridgeMod = await bundleTs('src/hardware-bridge.ts');
  shared = await bundleTs('src/hardware-protocol-shared.ts');
  twin = await bundleTs('src/visualizer/hardware-twin.ts');

  ({ LineTransport, WriteQueue, MAX_LINE_BYTES } = transport);
  ({ HardwareBridge, statusForTransportKind, connectionKindForStatus } = bridgeMod);

  FakeTransport = class extends LineTransport {
    kind = 'mock';
    label = 'fake';
    written = [];
    flushes = 0;
    openCalls = 0;
    closeCalls = 0;
    /** Set to record write order vs close order. */
    log = [];

    async openLink() { this.openCalls += 1; }
    async closeLink() { this.closeCalls += 1; this.log.push('close'); }
    writeBytes(bytes) {
      const text = new TextDecoder().decode(bytes);
      this.written.push(text);
      this.log.push(`write:${text.trim()}`);
    }
    async flush() { this.flushes += 1; this.log.push('flush'); }
    /** Test hook: feed bytes as if the device sent them. */
    feed(chunk) { this.pushChunk(chunk); }
    /** Test hook: pretend the link died on its own. */
    die(err) { this.reportDrop(err); }
  };
});

describe('1. line framing', () => {
  let t;
  const lines = [];
  before(async () => {
    t = new FakeTransport();
    t.onLine((l) => lines.push(l));
    await t.open();
  });

  it('partial line is buffered, split line reassembles', () => {
    t.feed('S1,2,3');            // partial — nothing yet
    assert.ok(lines.length === 0, `partial line is buffered: emitted ${lines.length}`);
    t.feed(',4,5,6,7,8\n');
    assert.ok(lines[0] === 'S1,2,3,4,5,6,7,8', `split line reassembles: got ${lines[0]}`);
  });

  it('several lines per chunk', () => {
    lines.length = 0;
    t.feed('Ifoo\nIbar\nIbaz\n');
    assert.ok(lines.join('|') === 'Ifoo|Ibar|Ibaz', lines.join('|'));
  });

  it('CRLF is trimmed', () => {
    lines.length = 0;
    t.feed('Icrlf\r\n');
    assert.ok(lines[0] === 'Icrlf', JSON.stringify(lines[0]));
  });

  it('blank lines are dropped', () => {
    lines.length = 0;
    t.feed('\n\n  \nIafter\n');
    assert.ok(lines.join('|') === 'Iafter', lines.join('|'));
  });

  it('binary chunk decodes', () => {
    lines.length = 0;
    t.feed(new TextEncoder().encode('Ibytes\n'));
    assert.ok(lines[0] === 'Ibytes', JSON.stringify(lines[0]));
  });

  it('unframed babble does not grow the buffer', () => {
    // A device at the wrong baud rate emits newline-free garbage forever.
    lines.length = 0;
    t.feed('x'.repeat(MAX_LINE_BYTES * 3));
    t.feed('Isurvivor\n');
    assert.ok(lines.length === 1 && lines[0] === 'Isurvivor', `got ${JSON.stringify(lines)}`);
  });

  it('UTF-8 split across chunks', () => {
    // A multi-byte character split across two chunks must not be mangled.
    lines.length = 0;
    const mu = new TextEncoder().encode('Iµ\n');
    t.feed(mu.subarray(0, 2));
    t.feed(mu.subarray(2));
    assert.ok(lines[0] === 'Iµ', JSON.stringify(lines[0]));
  });

  it('a throwing line listener is isolated', () => {
    // A listener that throws must not stop the others. The transport logs the
    // throw; muffle it so an expected warning doesn't look like a CI failure.
    lines.length = 0;
    const seen = [];
    t.onLine(() => { throw new Error('boom'); });
    t.onLine((l) => seen.push(l));
    const warn = console.warn;
    console.warn = () => {};
    try {
      t.feed('Iresilient\n');
    } finally {
      console.warn = warn;
    }
    assert.ok(seen.length === 1, `got ${seen.length}`);
  });
});

describe('2. WriteQueue', () => {
  it('preserves order, reports rejections, keeps running', async () => {
    const order = [];
    const errs = [];
    const q = new WriteQueue((e) => errs.push(e.message));
    const slow = (tag, ms) => () => new Promise((res) => setTimeout(() => { order.push(tag); res(); }, ms));
    q.push(slow('a', 12));
    q.push(slow('b', 1));
    q.push(slow('c', 1));
    await q.drain();
    assert.ok(order.join('') === 'abc', `WriteQueue preserves order despite differing latency: ${order.join('')}`);

    q.push(() => Promise.reject(new Error('gatt busy')));
    q.push(slow('d', 1));
    await q.drain();
    assert.ok(errs.length === 1 && errs[0] === 'gatt busy', `a rejected op is reported, not thrown: ${JSON.stringify(errs)}`);
    assert.ok(order.includes('d'), `queue keeps running after a failed op: ${order.join('')}`);
  });

  it('caps its backlog', async () => {
    // Backlog cap: setpoints are re-sent every frame, so a deep queue is stale data.
    const capped = new WriteQueue(() => {}, 3);
    let ran = 0;
    const block = new Promise((res) => setTimeout(res, 20));
    for (let i = 0; i < 20; i++) capped.push(async () => { await block; ran += 1; });
    await capped.drain();
    assert.ok(ran === 3, `WriteQueue caps backlog (ran ${ran} of 20): ran ${ran}, expected 3`);
  });
});

describe('3. BLE chunking', () => {
  const enc = new TextEncoder();

  it('a long line splits into MTU-sized chunks that rejoin byte-for-byte', () => {
    // A 12-coil CONF line is 23 B framed — more than one MTU write.
    const line = enc.encode('CONF12,180.0,45.0,15.0\n');
    const chunks = ble.chunkForBle(line);
    assert.ok(ble.BLE_WRITE_CHUNK_BYTES === 20, `BLE chunk size ${ble.BLE_WRITE_CHUNK_BYTES} B: got ${ble.BLE_WRITE_CHUNK_BYTES}`);
    assert.ok(chunks.length === 2, `long line is split: ${chunks.length} chunk(s) for ${line.length} B`);
    assert.ok(chunks.every((c) => c.length <= ble.BLE_WRITE_CHUNK_BYTES),
      `every chunk fits an MTU write: ${chunks.map((c) => c.length).join(',')}`);
    const rejoined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { rejoined.set(c, o); o += c.length; }
    assert.ok(new TextDecoder().decode(rejoined) === 'CONF12,180.0,45.0,15.0\n',
      `chunks rejoin byte-for-byte: ${JSON.stringify(new TextDecoder().decode(rejoined))}`);
  });

  it('short lines are not split', () => {
    assert.ok(ble.chunkForBle(enc.encode('P0,0,2\n')).length === 1, 'a short line is not split: short line was split');
    assert.ok(ble.chunkForBle(enc.encode('P123.45,999.9,0\n'.padEnd(20, ' '))).length === 1,
      'a line at exactly one MTU is not split: a 20 B line was split');
  });

  it('NUS UUIDs are lower-case (Web Bluetooth rejects upper-case)', () => {
    assert.ok([ble.NUS_SERVICE_UUID, ble.NUS_RX_CHAR_UUID, ble.NUS_TX_CHAR_UUID]
      .every((u) => u === u.toLowerCase() && /^[0-9a-f-]{36}$/.test(u)),
    [ble.NUS_SERVICE_UUID, ble.NUS_RX_CHAR_UUID, ble.NUS_TX_CHAR_UUID].join(' '));
  });
});

describe('4. CDC descriptor walk', () => {
  const cdcConfig = {
    interfaces: [
      {
        interfaceNumber: 0,
        alternates: [{ interfaceClass: 0x02, endpoints: [{ direction: 'in', type: 'interrupt', endpointNumber: 1 }] }]
      },
      {
        interfaceNumber: 1,
        alternates: [{
          interfaceClass: 0x0a,
          endpoints: [
            { direction: 'out', type: 'bulk', endpointNumber: 2 },
            { direction: 'in', type: 'bulk', endpointNumber: 3 }
          ]
        }]
      }
    ]
  };

  it('finds the data interface, bulk endpoints and control interface', () => {
    const found = usb.findCdcEndpoints(cdcConfig);
    assert.ok(found?.interfaceNumber === 1, `CDC data interface found: ${JSON.stringify(found)}`);
    assert.ok(found?.endpointIn === 3 && found?.endpointOut === 2, `bulk endpoints assigned by direction: ${JSON.stringify(found)}`);
    assert.ok(usb.findCdcControlInterface(cdcConfig) === 0, `CDC control interface found: ${usb.findCdcControlInterface(cdcConfig)}`);
  });

  it('rejects a HID-only device and a missing config', () => {
    assert.ok(usb.findCdcEndpoints({
      interfaces: [{ interfaceNumber: 0, alternates: [{ interfaceClass: 0x03, endpoints: [] }] }]
    }) === null, 'HID-only device rejected: a non-CDC device was accepted');
    assert.ok(usb.findCdcEndpoints(null) === null, 'missing config is not a crash: null config threw');
  });
});

describe('5. status ↔ connectionKind, badge labels', () => {
  const kinds = ['mock', 'serial', 'bluetooth', 'usb'];
  for (const kind of kinds) {
    it(`${kind} → status → kind round-trips`, () => {
      const status = statusForTransportKind(kind);
      assert.ok(connectionKindForStatus(status) === kind,
        `${kind} → status "${status}" → kind: round-tripped to ${connectionKindForStatus(status)}`);
    });
  }
  it('serial keeps the legacy "connected" status', () => {
    assert.ok(statusForTransportKind('serial') === 'connected', statusForTransportKind('serial'));
  });
  for (const status of ['disconnected', 'connecting', 'error', 'nonsense']) {
    it(`status "${status}" → disconnected`, () => {
      assert.ok(connectionKindForStatus(status) === 'disconnected', connectionKindForStatus(status));
    });
  }

  // The header badge must label every kind, or a connected twin reads "Twin off".
  const badgeSrc = read('src/hardware-twin-badge.ts');
  for (const kind of [...kinds, 'disconnected']) {
    it(`badge labels ${kind}`, () => {
      assert.ok(new RegExp(`\\n\\s*${kind}: '`).test(badgeSrc), `no LABELS entry for ${kind} in hardware-twin-badge.ts`);
    });
  }
  // Telemetry consumers must accept the same set.
  const typesSrc = read('src/telemetry/types.ts');
  const stateUnion = typesSrc.match(/connectionState: ([^;]+);/)?.[1] ?? '';
  for (const kind of [...kinds, 'disconnected']) {
    it(`telemetry connectionState includes ${kind}`, () => {
      assert.ok(stateUnion.includes(`'${kind}'`), `connectionState union is ${stateUnion}`);
    });
  }
});

describe('6. safety: coast on disconnect / switch / drop', () => {
  let bridge;
  let second;
  before(() => { bridge = new HardwareBridge(); });

  it('disconnect coasts, turns coils off, flushes, then closes', async () => {
    const t = new FakeTransport();
    await bridge.connectTransport(t);
    assert.ok(bridge.isConnected && bridge.connectionKind === 'mock', `pre-built transport connects: status ${bridge.status}`);

    bridge.setManualCoils(0b11, 0.75);
    assert.ok(bridge.manualMode === true, 'manual override armed: setManualCoils did not arm');

    t.log.length = 0;
    await bridge.disconnect();
    const coastIdx = t.log.indexOf('write:P0,0,2');
    const coilsIdx = t.log.indexOf('write:C0,0,0');
    const flushIdx = t.log.indexOf('flush');
    const closeIdx = t.log.indexOf('close');
    assert.ok(coastIdx >= 0, `disconnect writes coast (P0,0,2): ${t.log.join(' ')}`);
    assert.ok(coilsIdx >= 0, `disconnect writes coils off (C0,0,0): ${t.log.join(' ')}`);
    assert.ok(coastIdx < flushIdx && coilsIdx < flushIdx && flushIdx < closeIdx,
      `coast + coils off precede flush and close: ${t.log.join(' ')}`);
    assert.ok(bridge.manualMode === false && bridge.manualPwmDuty === 0,
      `disconnect clears the manual override: manualMode=${bridge.manualMode} duty=${bridge.manualPwmDuty}`);
    assert.ok(bridge.status === 'disconnected' && bridge.connectionKind === 'disconnected',
      `disconnect reports disconnected: ${bridge.status}`);
  });

  it('a transport switch coasts and closes the old link first', async () => {
    // Switching links must coast the old one before opening the new one.
    const first = new FakeTransport();
    second = new FakeTransport();
    second.kind = 'bluetooth';
    await bridge.connectTransport(first);
    first.log.length = 0;
    await bridge.connectTransport(second);
    assert.ok(first.log.includes('write:P0,0,2') && first.log.includes('write:C0,0,0'),
      `transport switch coasts the old link: ${first.log.join(' ')}`);
    assert.ok(first.closeCalls === 1, `transport switch closes the old link: ${first.closeCalls} close(s)`);
    assert.ok(bridge.connectionKind === 'bluetooth', `transport switch reports the new kind: ${bridge.connectionKind}`);
  });

  it('same-kind connect is a no-op', async () => {
    // Re-connecting the same kind is a no-op, not a reconnect storm.
    const closesBefore = second.closeCalls;
    await bridge.connectTransport('bluetooth');
    assert.ok(second.closeCalls === closesBefore && bridge.isConnected,
      `same-kind connect is a no-op: closes ${second.closeCalls} → ${closesBefore}`);
  });

  it('a dropped link stops claiming a link and drops the override', async () => {
    // A yanked cable / out-of-range BLE board: nothing to write to, but the host
    // must stop claiming a link and must drop the override.
    bridge.setManualCoils(0b101, 1);
    second.die(new Error('gattserverdisconnected'));
    assert.ok(bridge.status === 'error', `dropped link leaves error status: ${bridge.status}`);
    assert.ok(bridge.isConnected === false, `dropped link is not "connected": isConnected=${bridge.isConnected}`);
    assert.ok(bridge.manualMode === false && bridge.manualCoilMask === 0,
      `dropped link clears the manual override: manualMode=${bridge.manualMode} mask=${bridge.manualCoilMask}`);
    assert.ok(bridge.lastError === 'gattserverdisconnected', `dropped link records the reason: ${bridge.lastError}`);
    assert.ok((() => {
      const writtenBefore = second.written.length;
      bridge._writeLine('P1,1,0');
      return second.written.length === writtenBefore;
    })(), 'writes after a drop are no-ops: a command was written to a dead link');
    await bridge.disconnect();
  });
});

describe('7. slow-link throttle stays inside the watchdogs', () => {
  it('BLE widens the command period within both timeouts, and closing restores it', async () => {
    const bridge = new HardwareBridge();
    const defaultThrottle = bridge.commandThrottleMs;
    const slow = new FakeTransport();
    slow.kind = 'bluetooth';
    Object.defineProperty(slow, 'preferredCommandThrottleMs', { value: ble.BLE_COMMAND_THROTTLE_MS });
    await bridge.connectTransport(slow);
    assert.ok(bridge.commandThrottleMs === ble.BLE_COMMAND_THROTTLE_MS,
      `BLE widens the command period to ${ble.BLE_COMMAND_THROTTLE_MS} ms: ${bridge.commandThrottleMs} ms`);
    assert.ok(ble.BLE_COMMAND_THROTTLE_MS < bridge.watchdogMs,
      `BLE period stays under the firmware watchdog (100 ms): ${ble.BLE_COMMAND_THROTTLE_MS} vs ${bridge.watchdogMs}`);
    assert.ok(ble.BLE_COMMAND_THROTTLE_MS < bridge.commandTimeoutMs,
      `BLE period stays under the host timeout (200 ms): ${ble.BLE_COMMAND_THROTTLE_MS} vs ${bridge.commandTimeoutMs}`);
    await bridge.disconnect();
    assert.ok(bridge.commandThrottleMs === defaultThrottle,
      `closing the link restores the configured period: ${bridge.commandThrottleMs} ms`);
  });
});

describe('8. protocol v2 hello (firmware/seg-driver, #217 WS C)', () => {
  // The firmware's own numbers, read from the header the sketch compiles.
  const protocolH = read('firmware/seg-driver/protocol.h');
  const define = (name) => Number(protocolH.match(new RegExp(`#define\\s+${name}\\s+(\\d+)`))?.[1]);
  const fwVersion = define('PROTOCOL_VERSION');
  const fwWatchdog = define('WATCHDOG_TIMEOUT_MS');
  const fwBrake = `${define('BRAKE_PWM_MAX')}/${define('BRAKE_MAX_MS')}`;

  // Parse what the firmware actually prints: fill seg_safety.h's format string.
  const safetyH = read('firmware/seg-driver/seg_safety.h');
  const fmt = safetyH.match(/"(I v=%u[^"]*)"/)?.[1] ?? '';
  const args = [String(fwVersion), 'uno', 'serial', '6', '2', String(fwWatchdog), ...fwBrake.split('/')];
  let ai = 0;
  const printed = fmt.replace(/%[us]/g, () => args[ai++]);

  let parseFirmwareHello, HOST_PROTOCOL_VERSION, HELLO_COMMAND, HELLO_ATTEMPTS, MockSerialTransport;
  before(() => {
    ({ parseFirmwareHello, HOST_PROTOCOL_VERSION, HELLO_COMMAND, HELLO_ATTEMPTS } = shared);
    ({ MockSerialTransport } = bridgeMod);
  });

  /** Lines the host may ever put on the wire: v1 commands plus the hello. */
  const WIRE = /^(P\d+(\.\d+)?,-?\d+(\.\d+)?,[012]|C\d+,\d+,\d+|CONF\d+,-?\d+\.\d,-?\d+\.\d,-?\d+\.\d|V2)$/;
  const sent = (t) => t.written.map((w) => w.trim());
  const helloCount = (t) => sent(t).filter((l) => l === HELLO_COMMAND).length;
  /** Make the next update() eligible to send both a command and a hello. */
  const rewind = (b) => { b._lastCommandTime = -Infinity; b._lastHelloAt = -Infinity; };

  it('host version / watchdog / hello command match the firmware headers', () => {
    assert.ok(HOST_PROTOCOL_VERSION === fwVersion,
      `host protocol v${HOST_PROTOCOL_VERSION} = protocol.h PROTOCOL_VERSION: host ${HOST_PROTOCOL_VERSION}, firmware ${fwVersion}`);
    assert.ok(new HardwareBridge().watchdogMs === fwWatchdog,
      `host watchdogMs = protocol.h WATCHDOG_TIMEOUT_MS (${fwWatchdog} ms): host ${new HardwareBridge().watchdogMs}`);
    assert.ok(HELLO_COMMAND === 'V2', `hello request is "V2": ${HELLO_COMMAND}`);
  });

  it('parses the hello seg_safety.h prints', () => {
    assert.ok(fmt !== '' && ai === 8, `seg_safety.h hello format found (8 fields): format ${JSON.stringify(fmt)}, ${ai} fields`);
    const hello = parseFirmwareHello(printed);
    assert.ok(hello?.protocol === fwVersion && hello.firmware === 'seg-driver'
      && hello.board === 'uno' && hello.link === 'serial' && hello.coils === 6 && hello.halls === 2
      && hello.watchdogMs === fwWatchdog && `${hello.brakePwmMax}/${hello.brakeMaxMs}` === fwBrake,
    `firmware hello parses: ${printed} → ${JSON.stringify(hello)}`);
    assert.ok(parseFirmwareHello('v=2 board=mega')?.board === 'mega',
      `hello parses without the leading I: ${JSON.stringify(parseFirmwareHello('v=2 board=mega'))}`);
  });

  for (const [label, line] of [
    ['ordinary info line', 'ISEG Driver Ready'],
    ['mock config ack', 'Iconfig_ack:8,0.0,67.5,0.0'],
    ['v=1 (v1 never says hello)', 'I v=1 fw=seg-driver'],
    ['non-numeric version', 'I v=two board=uno'],
    ['signed version', 'I v=+2 board=uno'],
    ['key not first', 'I fw=seg-driver v=2']
  ]) {
    it(`not a hello: ${label}`, () => {
      assert.ok(parseFirmwareHello(line) === null, JSON.stringify(parseFirmwareHello(line)));
    });
  }

  it('hostile hello fields are sanitised', () => {
    const hostile = parseFirmwareHello('I v=2 board=<img/src=x> link=serial coils=-3 wd=1e9 brake=128');
    assert.ok(hostile?.board === 'unknown' && hostile.coils === null && hostile.watchdogMs === null
      && hostile.brakePwmMax === 128 && hostile.brakeMaxMs === null && hostile.firmware === 'unknown',
    JSON.stringify(hostile));
  });

  it('a v1 board: the host retries, gives up, and drives it anyway', async () => {
    const bridge = new HardwareBridge();
    const v1 = new FakeTransport();
    await bridge.connectTransport(v1);
    bridge.setTarget(90, 60);
    bridge.update();
    const first = sent(v1);
    assert.ok(helloCount(v1) === 1, `connect asks for the hello: ${first.join(' | ')}`);
    assert.ok(first.findIndex((l) => l.startsWith('P')) < first.indexOf(HELLO_COMMAND),
      `the hello goes after this frame's P (never delays a watchdog feed): ${first.join(' | ')}`);
    bridge._lastCommandTime = -Infinity;
    bridge.update();
    assert.ok(helloCount(v1) === 1, `no second hello inside a second: ${helloCount(v1)} hellos`);
    assert.ok(bridge.firmwareLabel === 'fw …', `waiting label: ${bridge.firmwareLabel}`);
    for (let i = 0; i < HELLO_ATTEMPTS + 3; i++) { rewind(bridge); bridge.update(); }
    assert.ok(helloCount(v1) === HELLO_ATTEMPTS, `hello retried at most ${HELLO_ATTEMPTS} times: ${helloCount(v1)} hellos`);
    bridge._lastHelloAt = performance.now() - 1001;
    assert.ok(bridge.firmwareLabel === 'no hello (v1 firmware)', `v1 board is reported as such: ${bridge.firmwareLabel}`);
    assert.ok(bridge.firmware === null, `v1 board: firmware stays null: ${JSON.stringify(bridge.firmware)}`);
    assert.ok(twin.buildHardwareTwinTelemetry(bridge)?.firmwareProtocol === null,
      `v1 board: telemetry firmwareProtocol is null: ${JSON.stringify(twin.buildHardwareTwinTelemetry(bridge))}`);
    bridge.setManualCoils(0b1000, 1);
    rewind(bridge);
    bridge.update();
    v1.log.length = 0;
    await bridge.disconnect();
    assert.ok(v1.log.includes('write:P0,0,2') && v1.log.includes('write:C0,0,0'),
      `v1 board still coasts on disconnect: ${v1.log.join(' ')}`);
    const bad = sent(v1).filter((l) => !WIRE.test(l));
    assert.ok(bad.length === 0, `every line sent to a v1 board is P / C / CONF / V2: ${bad.join(' | ')}`);
  });

  it('a v2 board answers the first request; the host stops asking and forgets it with the link', async () => {
    class V2Board extends FakeTransport {
      writeBytes(bytes) {
        super.writeBytes(bytes);
        if (new TextDecoder().decode(bytes).startsWith('V')) this.feed(`${printed}\n`);
      }
    }
    const bridge = new HardwareBridge();
    const board = new V2Board();
    await bridge.connectTransport(board);
    bridge.update();
    assert.ok(bridge.firmware?.protocol === fwVersion && bridge.firmware.coils === 6,
      `v2 hello stored on the bridge: ${JSON.stringify(bridge.firmware)}`);
    assert.ok(bridge.firmwareLabel === `fw v${fwVersion} · uno · 6 coils`, `panel label names the board: ${bridge.firmwareLabel}`);
    assert.ok(twin.buildHardwareTwinTelemetry(bridge)?.firmwareProtocol === fwVersion,
      `hub publishes firmwareProtocol: ${JSON.stringify(twin.buildHardwareTwinTelemetry(bridge)?.firmwareProtocol)}`);
    for (let i = 0; i < 4; i++) { rewind(bridge); bridge.update(); }
    assert.ok(helloCount(board) === 1, `no hello requests after an answer: ${helloCount(board)} hellos`);
    board.log.length = 0;
    await bridge.disconnect();
    assert.ok(board.log.includes('write:P0,0,2') && board.log.includes('write:C0,0,0'),
      `v2 board coasts on disconnect too: ${board.log.join(' ')}`);
    assert.ok(bridge.firmware === null && bridge.firmwareLabel === '',
      `disconnect forgets the hello: ${JSON.stringify(bridge.firmware)} / ${bridge.firmwareLabel}`);

    // The next board on the same bridge must not inherit the old hello.
    const next = new FakeTransport();
    await bridge.connectTransport(next);
    bridge._lastCommandTime = -Infinity; // the old link's last frame was microseconds ago
    bridge.update();
    assert.ok(bridge.firmware === null && helloCount(next) === 1,
      `a new link starts without a hello and asks again: ${JSON.stringify(bridge.firmware)}, ${helloCount(next)}`);
    next.feed(`${printed}\n`);
    next.die(new Error('unplugged'));
    assert.ok(bridge.firmware === null, `a dropped link forgets the hello: ${JSON.stringify(bridge.firmware)}`);
  });

  it('a board that says hello at boot (before the host asks) is never asked', async () => {
    const bridge = new HardwareBridge();
    const boot = new FakeTransport();
    await bridge.connectTransport(boot);
    boot.feed(`${printed}\n`);
    bridge.update();
    assert.ok(bridge.firmware?.protocol === fwVersion && helloCount(boot) === 0,
      `boot hello is enough — no request sent: ${JSON.stringify(bridge.firmware)}, ${helloCount(boot)} hellos`);
    await bridge.disconnect();
  });

  it('the mock answers like a v2 board, with the firmware\'s limits', () => {
    const mock = new MockSerialTransport();
    const lines = [];
    mock.onLine((l) => lines.push(l));
    mock.writeLine('V2');
    const mh = parseFirmwareHello(lines[0] ?? '');
    assert.ok(mh?.protocol === HOST_PROTOCOL_VERSION && mh.board === 'mock', `mock answers V2 with a hello: ${JSON.stringify(lines)}`);
    assert.ok(mh?.watchdogMs === fwWatchdog && `${mh.brakePwmMax}/${mh.brakeMaxMs}` === fwBrake,
      `mock hello carries the firmware watchdog and brake caps: ${JSON.stringify(mh)}`);
    lines.length = 0;
    mock.writeLine('CONF8,0.0,67.5,0.0');
    assert.ok(lines.length === 1 && lines[0] === 'Iconfig_ack:8,0.0,67.5,0.0',
      `mock reaches its CONF branch (was shadowed by C): ${JSON.stringify(lines)}`);
    mock.writeLine('C8,255,0');
    assert.ok(mock._manual === true, `mock C override still arms: ${mock._manual}`);
    mock.writeLine('C0,0,0');
    assert.ok(mock._manual === false, `mock C0 releases: ${mock._manual}`);
  });
});

describe('9. stale WebUSB pump vs a fast reconnect', () => {
  it('no stale drop, one pump, live pump delivers', async () => {
    const cdcConfig = {
      interfaces: [{
        interfaceNumber: 1,
        alternates: [{
          interfaceClass: 0x0a,
          endpoints: [
            { direction: 'out', type: 'bulk', endpointNumber: 2 },
            { direction: 'in', type: 'bulk', endpointNumber: 3 }
          ]
        }]
      }]
    };
    const pending = new Set();
    const device = {
      configuration: cdcConfig,
      async open() {},
      // Real USB stacks settle in-flight transfers after close() returns.
      async close() {
        const stale = [...pending];
        pending.clear();
        setTimeout(() => { for (const p of stale) p.reject(new Error('device closed')); }, 5);
      },
      async selectConfiguration() {},
      async claimInterface() {},
      async releaseInterface() {},
      async controlTransferOut() {},
      async transferOut() { return { status: 'ok' }; },
      transferIn() {
        return new Promise((resolve, reject) => { pending.add({ resolve, reject }); });
      },
      feed(text) {
        const p = [...pending][0];
        pending.delete(p);
        p.resolve({ status: 'ok', data: new DataView(new TextEncoder().encode(text).buffer) });
      }
    };
    const nav = globalThis.navigator;
    const hadUsb = nav && 'usb' in nav;
    if (nav) Object.defineProperty(nav, 'usb', { value: { requestDevice: async () => device }, configurable: true });

    try {
      const t = new usb.WebUsbCdcTransport(device);
      const drops = [];
      const lines = [];
      t.onDrop((err) => drops.push(err));
      t.onLine((line) => lines.push(line));
      await t.open();
      await t.close();
      await t.open();
      await new Promise((r) => setTimeout(r, 20)); // let any stale rejection land
      assert.ok(drops.length === 0, `stale pump reports no drop on the next open: drops: ${drops.map((d) => d?.message).join(', ')}`);
      assert.ok(pending.size === 1, `exactly one pump reads after a reconnect: ${pending.size} transfers in flight`);
      device.feed('I hello\n');
      await new Promise((r) => setTimeout(r, 0));
      assert.ok(lines.length === 1 && lines[0] === 'I hello', `the live pump delivers lines: ${JSON.stringify(lines)}`);
      await t.close();
    } finally {
      if (nav && !hadUsb) delete nav.usb;
    }
  });
});

describe('10. bridge events: multi-subscriber, unsubscribe, isolation', () => {
  it('status subscribers, a throwing listener, unsubscribe, twinMode', () => {
    const bridge = new HardwareBridge();
    const seen = { a: [], b: [] };
    const offA = bridge.on('status', (st) => seen.a.push(st));
    bridge.on('status', () => { throw new Error('panel bug'); });
    bridge.on('status', (st) => seen.b.push(st));
    const origError = console.error;
    console.error = () => {};
    try {
      bridge._setStatus('connecting');
      offA();
      bridge._setStatus('disconnected');
    } finally {
      console.error = origError;
    }
    assert.ok(seen.a[0] === 'connecting' && seen.b[0] === 'connecting',
      `every status subscriber hears the change: ${JSON.stringify(seen)}`);
    assert.ok(seen.b.length === 2, `a throwing listener does not starve later ones: ${JSON.stringify(seen.b)}`);
    assert.ok(seen.a.length === 1, `unsubscribe stops delivery: ${JSON.stringify(seen.a)}`);

    const twinModes = [];
    bridge.on('twinMode', (m) => twinModes.push(m));
    bridge.setTwinMode('shadow');
    assert.ok(twinModes[0] === 'shadow', `twinMode event fires: ${JSON.stringify(twinModes)}`);
  });
});
