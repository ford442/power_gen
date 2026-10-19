#!/usr/bin/env node
/**
 * test-hardware-transports.mjs — contracts for the hardware-twin transports
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
 * Usage: node scripts/test-hardware-transports.mjs   (exit 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Bundle a TS entry point so its relative imports resolve. `format: esm` +
 * a data: URL keeps this dependency-free like the other contract tests.
 */
async function importTsBundle(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent'
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

const transport = await importTsBundle('src/hardware-transport.ts');
const ble = await importTsBundle('src/bluetooth-uart-transport.ts');
const usb = await importTsBundle('src/webusb-cdc-transport.ts');
const bridgeMod = await importTsBundle('src/hardware-bridge.ts');

const { LineTransport, WriteQueue, MAX_LINE_BYTES } = transport;
const { HardwareBridge, statusForTransportKind, connectionKindForStatus } = bridgeMod;

/** Minimal LineTransport that records what was written and replays what we feed. */
class FakeTransport extends LineTransport {
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
}

// ── 1. Line framing ────────────────────────────────────────────────────────
{
  const t = new FakeTransport();
  const lines = [];
  t.onLine((l) => lines.push(l));
  await t.open();

  t.feed('S1,2,3');            // partial — nothing yet
  check('partial line is buffered', lines.length === 0, `emitted ${lines.length}`);
  t.feed(',4,5,6,7,8\n');
  check('split line reassembles', lines[0] === 'S1,2,3,4,5,6,7,8', `got ${lines[0]}`);

  lines.length = 0;
  t.feed('Ifoo\nIbar\nIbaz\n');
  check('several lines per chunk', lines.join('|') === 'Ifoo|Ibar|Ibaz', lines.join('|'));

  lines.length = 0;
  t.feed('Icrlf\r\n');
  check('CRLF is trimmed', lines[0] === 'Icrlf', JSON.stringify(lines[0]));

  lines.length = 0;
  t.feed('\n\n  \nIafter\n');
  check('blank lines are dropped', lines.join('|') === 'Iafter', lines.join('|'));

  lines.length = 0;
  t.feed(new TextEncoder().encode('Ibytes\n'));
  check('binary chunk decodes', lines[0] === 'Ibytes', JSON.stringify(lines[0]));

  // A device at the wrong baud rate emits newline-free garbage forever.
  lines.length = 0;
  t.feed('x'.repeat(MAX_LINE_BYTES * 3));
  t.feed('Isurvivor\n');
  check('unframed babble does not grow the buffer',
    lines.length === 1 && lines[0] === 'Isurvivor', `got ${JSON.stringify(lines)}`);

  // A multi-byte character split across two chunks must not be mangled.
  lines.length = 0;
  const mu = new TextEncoder().encode('Iµ\n');
  t.feed(mu.subarray(0, 2));
  t.feed(mu.subarray(2));
  check('UTF-8 split across chunks', lines[0] === 'Iµ', JSON.stringify(lines[0]));

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
  check('a throwing line listener is isolated', seen.length === 1, `got ${seen.length}`);
}

// ── 2. WriteQueue ──────────────────────────────────────────────────────────
{
  const order = [];
  const errs = [];
  const q = new WriteQueue((e) => errs.push(e.message));
  const slow = (tag, ms) => () => new Promise((res) => setTimeout(() => { order.push(tag); res(); }, ms));
  q.push(slow('a', 12));
  q.push(slow('b', 1));
  q.push(slow('c', 1));
  await q.drain();
  check('WriteQueue preserves order despite differing latency',
    order.join('') === 'abc', order.join(''));

  q.push(() => Promise.reject(new Error('gatt busy')));
  q.push(slow('d', 1));
  await q.drain();
  check('a rejected op is reported, not thrown', errs.length === 1 && errs[0] === 'gatt busy',
    JSON.stringify(errs));
  check('queue keeps running after a failed op', order.includes('d'), order.join(''));

  // Backlog cap: setpoints are re-sent every frame, so a deep queue is stale data.
  const capped = new WriteQueue(() => {}, 3);
  let ran = 0;
  const block = new Promise((res) => setTimeout(res, 20));
  for (let i = 0; i < 20; i++) capped.push(async () => { await block; ran += 1; });
  await capped.drain();
  check(`WriteQueue caps backlog (ran ${ran} of 20)`, ran === 3, `ran ${ran}, expected 3`);
}

// ── 3. BLE chunking ────────────────────────────────────────────────────────
{
  const enc = new TextEncoder();
  // A 12-coil CONF line is 23 B framed — more than one MTU write.
  const line = enc.encode('CONF12,180.0,45.0,15.0\n');
  const chunks = ble.chunkForBle(line);
  check(`BLE chunk size ${ble.BLE_WRITE_CHUNK_BYTES} B`, ble.BLE_WRITE_CHUNK_BYTES === 20,
    `got ${ble.BLE_WRITE_CHUNK_BYTES}`);
  check('long line is split', chunks.length === 2, `${chunks.length} chunk(s) for ${line.length} B`);
  check('every chunk fits an MTU write',
    chunks.every((c) => c.length <= ble.BLE_WRITE_CHUNK_BYTES),
    chunks.map((c) => c.length).join(','));
  const rejoined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { rejoined.set(c, o); o += c.length; }
  check('chunks rejoin byte-for-byte',
    new TextDecoder().decode(rejoined) === 'CONF12,180.0,45.0,15.0\n',
    JSON.stringify(new TextDecoder().decode(rejoined)));
  check('a short line is not split', ble.chunkForBle(enc.encode('P0,0,2\n')).length === 1,
    'short line was split');
  check('a line at exactly one MTU is not split',
    ble.chunkForBle(enc.encode('P123.45,999.9,0\n'.padEnd(20, ' '))).length === 1,
    'a 20 B line was split');
  check('NUS UUIDs are lower-case (Web Bluetooth rejects upper-case)',
    [ble.NUS_SERVICE_UUID, ble.NUS_RX_CHAR_UUID, ble.NUS_TX_CHAR_UUID]
      .every((u) => u === u.toLowerCase() && /^[0-9a-f-]{36}$/.test(u)),
    [ble.NUS_SERVICE_UUID, ble.NUS_RX_CHAR_UUID, ble.NUS_TX_CHAR_UUID].join(' '));
}

// ── 4. CDC descriptor walk ─────────────────────────────────────────────────
{
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
  const found = usb.findCdcEndpoints(cdcConfig);
  check('CDC data interface found', found?.interfaceNumber === 1, JSON.stringify(found));
  check('bulk endpoints assigned by direction',
    found?.endpointIn === 3 && found?.endpointOut === 2, JSON.stringify(found));
  check('CDC control interface found', usb.findCdcControlInterface(cdcConfig) === 0,
    String(usb.findCdcControlInterface(cdcConfig)));
  check('HID-only device rejected', usb.findCdcEndpoints({
    interfaces: [{ interfaceNumber: 0, alternates: [{ interfaceClass: 0x03, endpoints: [] }] }]
  }) === null, 'a non-CDC device was accepted');
  check('missing config is not a crash', usb.findCdcEndpoints(null) === null, 'null config threw');
}

// ── 5. status ↔ connectionKind, badge labels ────────────────────────────────
{
  const kinds = ['mock', 'serial', 'bluetooth', 'usb'];
  for (const kind of kinds) {
    const status = statusForTransportKind(kind);
    check(`${kind} → status "${status}" → kind`, connectionKindForStatus(status) === kind,
      `round-tripped to ${connectionKindForStatus(status)}`);
  }
  check('serial keeps the legacy "connected" status',
    statusForTransportKind('serial') === 'connected', statusForTransportKind('serial'));
  for (const status of ['disconnected', 'connecting', 'error', 'nonsense']) {
    check(`status "${status}" → disconnected`, connectionKindForStatus(status) === 'disconnected',
      connectionKindForStatus(status));
  }

  // The header badge must label every kind, or a connected twin reads "Twin off".
  const badgeSrc = read('src/hardware-twin-badge.ts');
  for (const kind of [...kinds, 'disconnected']) {
    check(`badge labels ${kind}`, new RegExp(`\\n\\s*${kind}: '`).test(badgeSrc),
      `no LABELS entry for ${kind} in hardware-twin-badge.ts`);
  }
  // Telemetry consumers must accept the same set.
  const typesSrc = read('src/telemetry/types.ts');
  const stateUnion = typesSrc.match(/connectionState: ([^;]+);/)?.[1] ?? '';
  for (const kind of [...kinds, 'disconnected']) {
    check(`telemetry connectionState includes ${kind}`, stateUnion.includes(`'${kind}'`),
      `connectionState union is ${stateUnion}`);
  }
}

// ── 6. Safety: coast on disconnect / switch / drop ─────────────────────────
{
  const bridge = new HardwareBridge();
  const t = new FakeTransport();
  await bridge.connectTransport(t);
  check('pre-built transport connects', bridge.isConnected && bridge.connectionKind === 'mock',
    `status ${bridge.status}`);

  bridge.setManualCoils(0b11, 0.75);
  check('manual override armed', bridge.manualMode === true, 'setManualCoils did not arm');

  t.log.length = 0;
  await bridge.disconnect();
  const coastIdx = t.log.indexOf('write:P0,0,2');
  const coilsIdx = t.log.indexOf('write:C0,0,0');
  const flushIdx = t.log.indexOf('flush');
  const closeIdx = t.log.indexOf('close');
  check('disconnect writes coast (P0,0,2)', coastIdx >= 0, t.log.join(' '));
  check('disconnect writes coils off (C0,0,0)', coilsIdx >= 0, t.log.join(' '));
  check('coast + coils off precede flush and close',
    coastIdx < flushIdx && coilsIdx < flushIdx && flushIdx < closeIdx, t.log.join(' '));
  check('disconnect clears the manual override',
    bridge.manualMode === false && bridge.manualPwmDuty === 0,
    `manualMode=${bridge.manualMode} duty=${bridge.manualPwmDuty}`);
  check('disconnect reports disconnected', bridge.status === 'disconnected' &&
    bridge.connectionKind === 'disconnected', bridge.status);

  // Switching links must coast the old one before opening the new one.
  const first = new FakeTransport();
  const second = new FakeTransport();
  second.kind = 'bluetooth';
  await bridge.connectTransport(first);
  first.log.length = 0;
  await bridge.connectTransport(second);
  check('transport switch coasts the old link',
    first.log.includes('write:P0,0,2') && first.log.includes('write:C0,0,0'),
    first.log.join(' '));
  check('transport switch closes the old link', first.closeCalls === 1, `${first.closeCalls} close(s)`);
  check('transport switch reports the new kind', bridge.connectionKind === 'bluetooth',
    bridge.connectionKind);

  // Re-connecting the same kind is a no-op, not a reconnect storm.
  const closesBefore = second.closeCalls;
  await bridge.connectTransport('bluetooth');
  check('same-kind connect is a no-op', second.closeCalls === closesBefore && bridge.isConnected,
    `closes ${second.closeCalls} → ${closesBefore}`);

  // A yanked cable / out-of-range BLE board: nothing to write to, but the host
  // must stop claiming a link and must drop the override.
  bridge.setManualCoils(0b101, 1);
  second.die(new Error('gattserverdisconnected'));
  check('dropped link leaves error status', bridge.status === 'error', bridge.status);
  check('dropped link is not "connected"', bridge.isConnected === false, `isConnected=${bridge.isConnected}`);
  check('dropped link clears the manual override',
    bridge.manualMode === false && bridge.manualCoilMask === 0,
    `manualMode=${bridge.manualMode} mask=${bridge.manualCoilMask}`);
  check('dropped link records the reason', bridge.lastError === 'gattserverdisconnected',
    String(bridge.lastError));
  check('writes after a drop are no-ops', (() => {
    const before = second.written.length;
    bridge._writeLine('P1,1,0');
    return second.written.length === before;
  })(), 'a command was written to a dead link');
  await bridge.disconnect();
}

// ── 7. Slow-link throttle stays inside the watchdogs ───────────────────────
{
  const bridge = new HardwareBridge();
  const defaultThrottle = bridge.commandThrottleMs;
  const slow = new FakeTransport();
  slow.kind = 'bluetooth';
  Object.defineProperty(slow, 'preferredCommandThrottleMs', { value: ble.BLE_COMMAND_THROTTLE_MS });
  await bridge.connectTransport(slow);
  check(`BLE widens the command period to ${ble.BLE_COMMAND_THROTTLE_MS} ms`,
    bridge.commandThrottleMs === ble.BLE_COMMAND_THROTTLE_MS, `${bridge.commandThrottleMs} ms`);
  check('BLE period stays under the firmware watchdog (100 ms)',
    ble.BLE_COMMAND_THROTTLE_MS < bridge.watchdogMs, `${ble.BLE_COMMAND_THROTTLE_MS} vs ${bridge.watchdogMs}`);
  check('BLE period stays under the host timeout (200 ms)',
    ble.BLE_COMMAND_THROTTLE_MS < bridge.commandTimeoutMs,
    `${ble.BLE_COMMAND_THROTTLE_MS} vs ${bridge.commandTimeoutMs}`);
  await bridge.disconnect();
  check('closing the link restores the configured period',
    bridge.commandThrottleMs === defaultThrottle, `${bridge.commandThrottleMs} ms`);
}

// ── 8. Protocol v2 hello (firmware/seg-driver, #217 WS C) ──────────────────
{
  const shared = await importTsBundle('src/hardware-protocol-shared.ts');
  const twin = await importTsBundle('src/visualizer/hardware-twin.ts');
  const { parseFirmwareHello, HOST_PROTOCOL_VERSION, HELLO_COMMAND, HELLO_ATTEMPTS } = shared;
  const { MockSerialTransport } = bridgeMod;

  // The firmware's own numbers, read from the header the sketch compiles.
  const protocolH = read('firmware/seg-driver/protocol.h');
  const define = (name) => Number(protocolH.match(new RegExp(`#define\\s+${name}\\s+(\\d+)`))?.[1]);
  const fwVersion = define('PROTOCOL_VERSION');
  const fwWatchdog = define('WATCHDOG_TIMEOUT_MS');
  const fwBrake = `${define('BRAKE_PWM_MAX')}/${define('BRAKE_MAX_MS')}`;
  check(`host protocol v${HOST_PROTOCOL_VERSION} = protocol.h PROTOCOL_VERSION`,
    HOST_PROTOCOL_VERSION === fwVersion, `host ${HOST_PROTOCOL_VERSION}, firmware ${fwVersion}`);
  check(`host watchdogMs = protocol.h WATCHDOG_TIMEOUT_MS (${fwWatchdog} ms)`,
    new HardwareBridge().watchdogMs === fwWatchdog, `host ${new HardwareBridge().watchdogMs}`);
  check('hello request is "V2"', HELLO_COMMAND === 'V2', HELLO_COMMAND);

  // Parse what the firmware actually prints: fill seg_safety.h's format string.
  const safetyH = read('firmware/seg-driver/seg_safety.h');
  const fmt = safetyH.match(/"(I v=%u[^"]*)"/)?.[1] ?? '';
  const args = [String(fwVersion), 'uno', 'serial', '6', '2', String(fwWatchdog), ...fwBrake.split('/')];
  let ai = 0;
  const printed = fmt.replace(/%[us]/g, () => args[ai++]);
  check('seg_safety.h hello format found (8 fields)', fmt !== '' && ai === 8, `format ${JSON.stringify(fmt)}, ${ai} fields`);
  const hello = parseFirmwareHello(printed);
  check('firmware hello parses', hello?.protocol === fwVersion && hello.firmware === 'seg-driver'
    && hello.board === 'uno' && hello.link === 'serial' && hello.coils === 6 && hello.halls === 2
    && hello.watchdogMs === fwWatchdog && `${hello.brakePwmMax}/${hello.brakeMaxMs}` === fwBrake,
  `${printed} → ${JSON.stringify(hello)}`);
  check('hello parses without the leading I', parseFirmwareHello('v=2 board=mega')?.board === 'mega',
    JSON.stringify(parseFirmwareHello('v=2 board=mega')));

  for (const [label, line] of [
    ['ordinary info line', 'ISEG Driver Ready'],
    ['mock config ack', 'Iconfig_ack:8,0.0,67.5,0.0'],
    ['v=1 (v1 never says hello)', 'I v=1 fw=seg-driver'],
    ['non-numeric version', 'I v=two board=uno'],
    ['signed version', 'I v=+2 board=uno'],
    ['key not first', 'I fw=seg-driver v=2']
  ]) {
    check(`not a hello: ${label}`, parseFirmwareHello(line) === null, JSON.stringify(parseFirmwareHello(line)));
  }
  const hostile = parseFirmwareHello('I v=2 board=<img/src=x> link=serial coils=-3 wd=1e9 brake=128');
  check('hostile hello fields are sanitised',
    hostile?.board === 'unknown' && hostile.coils === null && hostile.watchdogMs === null
      && hostile.brakePwmMax === 128 && hostile.brakeMaxMs === null && hostile.firmware === 'unknown',
    JSON.stringify(hostile));

  /** Lines the host may ever put on the wire: v1 commands plus the hello. */
  const WIRE = /^(P\d+(\.\d+)?,-?\d+(\.\d+)?,[012]|C\d+,\d+,\d+|CONF\d+,-?\d+\.\d,-?\d+\.\d,-?\d+\.\d|V2)$/;
  const sent = (t) => t.written.map((w) => w.trim());
  const helloCount = (t) => sent(t).filter((l) => l === HELLO_COMMAND).length;
  /** Make the next update() eligible to send both a command and a hello. */
  const rewind = (b) => { b._lastCommandTime = -Infinity; b._lastHelloAt = -Infinity; };

  // A v1 board: never answers. The host retries, gives up, and drives it anyway.
  {
    const bridge = new HardwareBridge();
    const v1 = new FakeTransport();
    await bridge.connectTransport(v1);
    bridge.setTarget(90, 60);
    bridge.update();
    const first = sent(v1);
    check('connect asks for the hello', helloCount(v1) === 1, first.join(' | '));
    check('the hello goes after this frame\'s P (never delays a watchdog feed)',
      first.findIndex((l) => l.startsWith('P')) < first.indexOf(HELLO_COMMAND), first.join(' | '));
    bridge._lastCommandTime = -Infinity;
    bridge.update();
    check('no second hello inside a second', helloCount(v1) === 1, `${helloCount(v1)} hellos`);
    check('waiting label', bridge.firmwareLabel === 'fw …', bridge.firmwareLabel);
    for (let i = 0; i < HELLO_ATTEMPTS + 3; i++) { rewind(bridge); bridge.update(); }
    check(`hello retried at most ${HELLO_ATTEMPTS} times`, helloCount(v1) === HELLO_ATTEMPTS,
      `${helloCount(v1)} hellos`);
    bridge._lastHelloAt = performance.now() - 1001;
    check('v1 board is reported as such', bridge.firmwareLabel === 'no hello (v1 firmware)', bridge.firmwareLabel);
    check('v1 board: firmware stays null', bridge.firmware === null, JSON.stringify(bridge.firmware));
    check('v1 board: telemetry firmwareProtocol is null',
      twin.buildHardwareTwinTelemetry(bridge)?.firmwareProtocol === null,
      JSON.stringify(twin.buildHardwareTwinTelemetry(bridge)));
    bridge.setManualCoils(0b1000, 1);
    rewind(bridge);
    bridge.update();
    v1.log.length = 0;
    await bridge.disconnect();
    check('v1 board still coasts on disconnect',
      v1.log.includes('write:P0,0,2') && v1.log.includes('write:C0,0,0'), v1.log.join(' '));
    const bad = sent(v1).filter((l) => !WIRE.test(l));
    check('every line sent to a v1 board is P / C / CONF / V2', bad.length === 0, bad.join(' | '));
  }

  // A v2 board: answers the first request; the host stops asking.
  {
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
    check('v2 hello stored on the bridge', bridge.firmware?.protocol === fwVersion && bridge.firmware.coils === 6,
      JSON.stringify(bridge.firmware));
    check('panel label names the board', bridge.firmwareLabel === `fw v${fwVersion} · uno · 6 coils`, bridge.firmwareLabel);
    check('hub publishes firmwareProtocol',
      twin.buildHardwareTwinTelemetry(bridge)?.firmwareProtocol === fwVersion,
      JSON.stringify(twin.buildHardwareTwinTelemetry(bridge)?.firmwareProtocol));
    for (let i = 0; i < 4; i++) { rewind(bridge); bridge.update(); }
    check('no hello requests after an answer', helloCount(board) === 1, `${helloCount(board)} hellos`);
    board.log.length = 0;
    await bridge.disconnect();
    check('v2 board coasts on disconnect too',
      board.log.includes('write:P0,0,2') && board.log.includes('write:C0,0,0'), board.log.join(' '));
    check('disconnect forgets the hello', bridge.firmware === null && bridge.firmwareLabel === '',
      `${JSON.stringify(bridge.firmware)} / ${bridge.firmwareLabel}`);

    // The next board on the same bridge must not inherit the old hello.
    const next = new FakeTransport();
    await bridge.connectTransport(next);
    bridge._lastCommandTime = -Infinity; // the old link's last frame was microseconds ago
    bridge.update();
    check('a new link starts without a hello and asks again',
      bridge.firmware === null && helloCount(next) === 1, `${JSON.stringify(bridge.firmware)}, ${helloCount(next)}`);
    next.feed(`${printed}\n`);
    next.die(new Error('unplugged'));
    check('a dropped link forgets the hello', bridge.firmware === null, JSON.stringify(bridge.firmware));
  }

  // A board that says hello at boot (before the host asks) is never asked.
  {
    const bridge = new HardwareBridge();
    const boot = new FakeTransport();
    await bridge.connectTransport(boot);
    boot.feed(`${printed}\n`);
    bridge.update();
    check('boot hello is enough — no request sent', bridge.firmware?.protocol === fwVersion && helloCount(boot) === 0,
      `${JSON.stringify(bridge.firmware)}, ${helloCount(boot)} hellos`);
    await bridge.disconnect();
  }

  // The mock answers like a v2 board, with the firmware's limits.
  {
    const mock = new MockSerialTransport();
    const lines = [];
    mock.onLine((l) => lines.push(l));
    mock.writeLine('V2');
    const mh = parseFirmwareHello(lines[0] ?? '');
    check('mock answers V2 with a hello', mh?.protocol === HOST_PROTOCOL_VERSION && mh.board === 'mock',
      JSON.stringify(lines));
    check('mock hello carries the firmware watchdog and brake caps',
      mh?.watchdogMs === fwWatchdog && `${mh.brakePwmMax}/${mh.brakeMaxMs}` === fwBrake, JSON.stringify(mh));
    lines.length = 0;
    mock.writeLine('CONF8,0.0,67.5,0.0');
    check('mock reaches its CONF branch (was shadowed by C)',
      lines.length === 1 && lines[0] === 'Iconfig_ack:8,0.0,67.5,0.0', JSON.stringify(lines));
    mock.writeLine('C8,255,0');
    check('mock C override still arms', mock._manual === true, String(mock._manual));
    mock.writeLine('C0,0,0');
    check('mock C0 releases', mock._manual === false, String(mock._manual));
  }
}

// ── 9. Stale WebUSB pump vs a fast reconnect ───────────────────────────────
{
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

  const t = new usb.WebUsbCdcTransport(device);
  const drops = [];
  const lines = [];
  t.onDrop((err) => drops.push(err));
  t.onLine((line) => lines.push(line));
  await t.open();
  await t.close();
  await t.open();
  await new Promise((r) => setTimeout(r, 20)); // let any stale rejection land
  check('stale pump reports no drop on the next open', drops.length === 0,
    `drops: ${drops.map((d) => d?.message).join(', ')}`);
  check('exactly one pump reads after a reconnect', pending.size === 1, `${pending.size} transfers in flight`);
  device.feed('I hello\n');
  await new Promise((r) => setTimeout(r, 0));
  check('the live pump delivers lines', lines.length === 1 && lines[0] === 'I hello', JSON.stringify(lines));
  await t.close();
  if (nav && !hadUsb) delete nav.usb;
}

// ── 10. Bridge events: multi-subscriber, unsubscribe, isolation ─────────────
{
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
  check('every status subscriber hears the change', seen.a[0] === 'connecting' && seen.b[0] === 'connecting',
    JSON.stringify(seen));
  check('a throwing listener does not starve later ones', seen.b.length === 2, JSON.stringify(seen.b));
  check('unsubscribe stops delivery', seen.a.length === 1, JSON.stringify(seen.a));

  const twin = [];
  bridge.on('twinMode', (m) => twin.push(m));
  bridge.setTwinMode('shadow');
  check('twinMode event fires', twin[0] === 'shadow', JSON.stringify(twin));
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[hardware-transports] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[hardware-transports] ${ok.length} checks passed`);
