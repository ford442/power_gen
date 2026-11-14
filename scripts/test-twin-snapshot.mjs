#!/usr/bin/env node
/**
 * test-twin-snapshot.mjs — which ω wins when a plant snapshot is restored
 * while the hardware twin runs **closed loop** (#239 §2, docs/SNAPSHOTS.md).
 *
 * Closed loop writes the bridge's sensor RPM over the SEG plant's ω every
 * frame. The rule: the snapshot's ω wins at its epoch boundary, then the
 * **next** sensor sample takes over — not the last pre-restore reading, which
 * would otherwise overwrite the restored ω on the very next frame.
 *
 * A real headless lab (scripts/lib/live-lab.mjs: LabSession, frame loop in
 * WebGL2 order) connects the real `?mockHardware=1` transport
 * (MockSerialTransport). Its 125 Hz timer is stopped and `_tick()` is called
 * by hand, so every sensor sample lands exactly where the test puts it.
 *
 *   1. Closed loop follows the sensor (baseline).
 *   2. Restore a snapshot: the next frames keep the snapshot's ω while no new
 *      sample has arrived.
 *   3. The next sample takes over again.
 *   4. Open loop is untouched by the hold (the sim drives the coils).
 *   5. Disconnect clears the hold.
 *
 * Usage: node scripts/test-twin-snapshot.mjs   (exit 1 on failure)
 */
import { bootLiveLab } from './lib/live-lab.mjs';

const { X, session, frame, say } = await bootLiveLab({ backend: 'js', search: '?mockHardware=1' });

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const DT = 1 / 60;
const hw = session.hardwareBridge;
const op = X.segOperator;
/** Closed loop's map from sensor RPM to the normalised plant ω (lab-session.ts). */
const wOf = (rpm) => Math.min(1, Math.abs(X.HardwareBridge.sanitizeRpm(rpm)) / 3000);

await hw.connect();
check('?mockHardware=1 connects the mock transport', hw.isConnected && hw.status === 'mock', hw.status);
const mock = hw.transport;
check('the transport is the real MockSerialTransport', typeof mock?._tick === 'function' && typeof mock?.stop === 'function');
mock.stop();

/** One sensor sample at `rpm` (the mock lags toward its target; pin both). Protocol range ±999.9. */
function sample(rpm) {
  mock._targetRpm = rpm;
  mock._rpm = rpm;
  mock._tick();
}

op.start();
session.setMode('seg');

// ── snapshot A: the plant at a known ω, no twin override yet ─────────────
hw.twinMode = X.TWIN_MODES.OPEN;
op.physics.segOmega = 0.02;
const snapA = await X.captureLabSnapshot();
const wA = snapA.operator?.physics?.segOmega;
check('snapshot A carries the operator ω', wA === 0.02, String(wA));

// ── 1. closed loop follows the sensor ────────────────────────────────────
hw.twinMode = X.TWIN_MODES.CLOSED;
sample(960);
frame(DT);
check('1. closed loop: ω follows the sensor sample', Math.abs(session.segOmega - wOf(960)) < 1e-9,
  `ω ${session.segOmega} vs sensor ${wOf(960)}`);
check('1. …written into the operator plant too', Math.abs(op.physics.segOmega - wOf(960)) < 1e-9);

// ── 2. restore: the snapshot's ω holds until a newer sample ──────────────
const restored = await X.restoreLabSnapshot(snapA);
check('2. restoreLabSnapshot resolves true', restored === true);
check('2. the operator holds the snapshot ω right after restore', Math.abs(op.physics.segOmega - wA) < 1e-9,
  String(op.physics.segOmega));
for (let i = 0; i < 5; i++) frame(DT);
// The plant integrates on from the snapshot (a small change per frame), but
// is never snapped back to the pre-restore sensor reading.
check('2. five frames later ω is the plant integrating from the snapshot, not the old sensor',
  Math.abs(session.segOmega - wA) < 0.05 && Math.abs(session.segOmega - wOf(960)) > 0.2,
  `ω ${session.segOmega}, snapshot ${wA}, old sensor ${wOf(960)}`);
check('2. hardware panel still shows the old reading (only the override is held)', hw.actualRpm === 960, String(hw.actualRpm));

// ── 3. the next sample takes over ────────────────────────────────────────
sample(600);
frame(DT);
check('3. the next sensor sample overrides again', Math.abs(session.segOmega - wOf(600)) < 1e-9,
  `ω ${session.segOmega} vs sensor ${wOf(600)}`);
sample(300);
frame(DT);
check('3. …and every sample after it', Math.abs(session.segOmega - wOf(300)) < 1e-9, String(session.segOmega));

// ── 4. open loop: the sim drives the coils, the hold changes nothing ─────
hw.twinMode = X.TWIN_MODES.OPEN;
await X.restoreLabSnapshot(snapA);
sample(990);
frame(DT);
check('4. open loop never writes the sensor into ω', Math.abs(session.segOmega - wA) < 0.05 && Math.abs(session.segOmega - wOf(990)) > 0.2,
  String(session.segOmega));

// ── 5. disconnect clears the hold ────────────────────────────────────────
hw.twinMode = X.TWIN_MODES.CLOSED;
await X.restoreLabSnapshot(snapA);
await hw.disconnect();
frame(DT);
check('5. disconnected: no twin telemetry', session.hardwareTwinTelemetry === null);
await hw.connect();
hw.transport.stop();
hw.twinMode = X.TWIN_MODES.CLOSED;
const reconnected = hw.transport;
reconnected._targetRpm = 450;
reconnected._rpm = 450;
reconnected._tick();
frame(DT);
check('5. after a reconnect the first sample overrides at once (no stale hold)',
  Math.abs(session.segOmega - wOf(450)) < 1e-9, String(session.segOmega));
await hw.disconnect();

if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error(`[twin-snapshot] ${failures.length} failure(s) of ${checks}`);
  process.exit(1);
}
say(`[twin-snapshot] ${checks} checks passed — snapshot ω wins at the epoch boundary, the next sensor sample after it`);
process.exit(0);
