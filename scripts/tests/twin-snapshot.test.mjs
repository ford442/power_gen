/**
 * twin-snapshot — which ω wins when a plant snapshot is restored while the
 * hardware twin runs **closed loop** (#239 §2, docs/SNAPSHOTS.md).
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
 * Usage: npm run test:twin-snapshot   (node --test scripts/tests/twin-snapshot.test.mjs)
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootLiveLab } from '../lib/live-lab.mjs';

const DT = 1 / 60;

// Sequential: one live lab per process, and every step builds on the last.
describe('closed-loop twin vs a restored snapshot', () => {
  let X, session, frame, hw, op, mock, snapA, wA;
  /** Closed loop's map from sensor RPM to the normalised plant ω (lab-session.ts). */
  const wOf = (rpm) => Math.min(1, Math.abs(X.HardwareBridge.sanitizeRpm(rpm)) / 3000);
  /** One sensor sample at `rpm` (the mock lags toward its target; pin both). Protocol range ±999.9. */
  function sample(rpm) {
    mock._targetRpm = rpm;
    mock._rpm = rpm;
    mock._tick();
  }

  before(async () => {
    ({ X, session, frame } = await bootLiveLab({ backend: 'js', search: '?mockHardware=1' }));
    hw = session.hardwareBridge;
    op = X.segOperator;
  });

  after(async () => {
    if (hw?.isConnected) await hw.disconnect();
  });

  it('?mockHardware=1 connects the real MockSerialTransport', async () => {
    await hw.connect();
    assert.ok(hw.isConnected && hw.status === 'mock', `?mockHardware=1 connects the mock transport — ${hw.status}`);
    mock = hw.transport;
    assert.ok(typeof mock?._tick === 'function' && typeof mock?.stop === 'function', 'the transport is the real MockSerialTransport');
    mock.stop();
    op.start();
    session.setMode('seg');
  });

  it('snapshot A carries the operator ω (no twin override yet)', async () => {
    hw.twinMode = X.TWIN_MODES.OPEN;
    op.physics.segOmega = 0.02;
    snapA = await X.captureLabSnapshot();
    wA = snapA.operator?.physics?.segOmega;
    assert.ok(wA === 0.02, `snapshot A carries the operator ω — ${wA}`);
  });

  it('1. closed loop follows the sensor', () => {
    hw.twinMode = X.TWIN_MODES.CLOSED;
    sample(960);
    frame(DT);
    assert.ok(Math.abs(session.segOmega - wOf(960)) < 1e-9,
      `1. closed loop: ω follows the sensor sample — ω ${session.segOmega} vs sensor ${wOf(960)}`);
    assert.ok(Math.abs(op.physics.segOmega - wOf(960)) < 1e-9, '1. …written into the operator plant too');
  });

  it('2. restore: the snapshot ω holds until a newer sample', async () => {
    const restored = await X.restoreLabSnapshot(snapA);
    assert.ok(restored === true, '2. restoreLabSnapshot resolves true');
    assert.ok(Math.abs(op.physics.segOmega - wA) < 1e-9,
      `2. the operator holds the snapshot ω right after restore — ${op.physics.segOmega}`);
    for (let i = 0; i < 5; i++) frame(DT);
    // The plant integrates on from the snapshot (a small change per frame), but
    // is never snapped back to the pre-restore sensor reading.
    assert.ok(Math.abs(session.segOmega - wA) < 0.05 && Math.abs(session.segOmega - wOf(960)) > 0.2,
      `2. five frames later ω is the plant integrating from the snapshot, not the old sensor — ω ${session.segOmega}, snapshot ${wA}, old sensor ${wOf(960)}`);
    assert.ok(hw.actualRpm === 960,
      `2. hardware panel still shows the old reading (only the override is held) — ${hw.actualRpm}`);
  });

  it('3. the next sample takes over', () => {
    sample(600);
    frame(DT);
    assert.ok(Math.abs(session.segOmega - wOf(600)) < 1e-9,
      `3. the next sensor sample overrides again — ω ${session.segOmega} vs sensor ${wOf(600)}`);
    sample(300);
    frame(DT);
    assert.ok(Math.abs(session.segOmega - wOf(300)) < 1e-9, `3. …and every sample after it — ${session.segOmega}`);
  });

  it('4. open loop: the sim drives the coils, the hold changes nothing', async () => {
    hw.twinMode = X.TWIN_MODES.OPEN;
    await X.restoreLabSnapshot(snapA);
    sample(990);
    frame(DT);
    assert.ok(Math.abs(session.segOmega - wA) < 0.05 && Math.abs(session.segOmega - wOf(990)) > 0.2,
      `4. open loop never writes the sensor into ω — ${session.segOmega}`);
  });

  it('5. disconnect clears the hold', async () => {
    hw.twinMode = X.TWIN_MODES.CLOSED;
    await X.restoreLabSnapshot(snapA);
    await hw.disconnect();
    frame(DT);
    assert.ok(session.hardwareTwinTelemetry === null, '5. disconnected: no twin telemetry');
    await hw.connect();
    hw.transport.stop();
    hw.twinMode = X.TWIN_MODES.CLOSED;
    const reconnected = hw.transport;
    reconnected._targetRpm = 450;
    reconnected._rpm = 450;
    reconnected._tick();
    frame(DT);
    assert.ok(Math.abs(session.segOmega - wOf(450)) < 1e-9,
      `5. after a reconnect the first sample overrides at once (no stale hold) — ${session.segOmega}`);
    await hw.disconnect();
  });
});
