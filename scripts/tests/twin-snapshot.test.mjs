/**
 * twin-snapshot — which ω wins when a plant snapshot is restored while the
 * hardware twin runs **closed loop** (#239 §2, docs/SNAPSHOTS.md).
 *
 * Closed loop writes the rig's rotor over the SEG plant's ω every frame —
 * since #257 the twin's *filtered* ω (the EKF in sim_core), before the plant
 * step and after it. The rule: the snapshot's ω wins at its epoch boundary,
 * then the **next** sensor sample (through the filter) takes over — not the
 * last pre-restore estimate, which would otherwise overwrite the restored ω
 * on the very next frame. The snapshot also carries the filter (ADR-0015
 * amendment): its state and covariance come back with the plant.
 *
 * A real headless lab (scripts/lib/live-lab.mjs: LabSession, frame loop in
 * WebGL2 order) connects the real `?mockHardware=1` transport
 * (MockSerialTransport). Its 125 Hz timer is stopped and `_tick()` is called
 * by hand, so every sensor sample lands exactly where the test puts it.
 *
 *   0. The estimator is up (sim_core through the test shim).
 *   1. Closed loop follows the filtered estimate (baseline).
 *   2. Restore a snapshot: the next frames keep the snapshot's ω while no new
 *      sample has arrived.
 *   3. The next sample takes over again, and the filter state + covariance
 *      are the snapshot's (then one update on).
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
  /** Closed loop's map from rotor RPM to the normalised plant ω (lab-session.ts). */
  const wOf = (rpm) => Math.min(1, Math.abs(X.HardwareBridge.sanitizeRpm(rpm)) / 3000);
  /** What closed loop writes now: the filtered rotor RPM. */
  const est = () => session.twin.closedLoopRpm();
  /** One sensor sample with the mock rig's rotor pinned at `rpm`. Protocol range ±999.9. */
  function sample(rpm) {
    mock._targetRpm = rpm;
    mock.pinRpm(rpm);
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

  it('0. the twin estimator is up on the shipped sim_core', async () => {
    const host = await session.twin.ensureHost();
    assert.ok(host && session.twin.state === 'ready', `estimator ready — ${session.twin.state} ${session.twin.message}`);
  });

  it('snapshot A carries the operator ω (no twin override yet)', async () => {
    hw.twinMode = X.TWIN_MODES.OPEN;
    op.physics.segOmega = 0.02;
    snapA = await X.captureLabSnapshot();
    wA = snapA.operator?.physics?.segOmega;
    assert.ok(wA === 0.02, `snapshot A carries the operator ω — ${wA}`);
  });

  it('1. closed loop follows the filtered estimate', () => {
    hw.twinMode = X.TWIN_MODES.CLOSED;
    sample(960);
    frame(DT);
    const rpm = est();
    assert.ok(rpm !== null && Math.abs(rpm - 960) < 20,
      `1. the estimate starts at the first reading — ${rpm} RPM vs 960`);
    assert.ok(Math.abs(session.segOmega - wOf(rpm)) < 1e-9,
      `1. closed loop: ω follows the filtered estimate — ω ${session.segOmega} vs ${wOf(rpm)}`);
    assert.ok(Math.abs(op.physics.segOmega - wOf(rpm)) < 1e-9, '1. …written into the operator plant too');
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
    assert.ok(Math.abs(hw.actualRpm - 960) < 20,
      `2. hardware panel still shows the old reading (only the override is held) — ${hw.actualRpm}`);
  });

  it('3. the next sample takes over; the filter resumed from the snapshot', () => {
    // Snapshot A was taken before any sample: its filter sat at rest with the
    // initial covariance, so the update at 600 RPM starts from there.
    assert.ok(snapA.twin && Array.isArray(snapA.twin.values) && snapA.twin.values.length > 8,
      `3. snapshot A carries the twin filter block — ${JSON.stringify(snapA.twin)?.slice(0, 80)}`);
    sample(600);
    frame(DT);
    const rpm = est();
    assert.ok(rpm !== null && Math.abs(session.segOmega - wOf(rpm)) < 1e-9,
      `3. the next sensor sample overrides again (filtered) — ω ${session.segOmega} vs ${wOf(rpm)}`);
    assert.ok(Math.abs(rpm - 600) < 60 && Math.abs(rpm - 960) > 200,
      `3. …from the restored filter, not the pre-restore one — ${rpm} RPM`);
    sample(600);
    frame(DT);
    assert.ok(Math.abs(session.segOmega - wOf(est())) < 1e-9, `3. …and every sample after it — ${session.segOmega}`);
  });

  it('3b. a mid-run snapshot restores the filter state and covariance exactly', async () => {
    for (let k = 0; k < 20; k++) sample(500);
    frame(DT);
    const snapB = await X.captureLabSnapshot();
    const before = session.twin.host.estimate;
    for (let k = 0; k < 20; k++) sample(800);
    frame(DT);
    assert.ok(Math.abs(session.twin.host.estimate.x[0] - before.x[0]) > 1, '3b. the filter moved on after the snapshot');
    assert.ok(await X.restoreLabSnapshot(snapB), '3b. restore resolves true');
    const after = session.twin.host.estimate;
    assert.deepEqual([after.t, ...after.x, ...after.P], [before.t, ...before.x, ...before.P],
      '3b. t, x̂ and P are the snapshot\'s, bit for bit');
  });

  it('4. open loop: the sim drives the coils, the hold changes nothing', async () => {
    hw.twinMode = X.TWIN_MODES.OPEN;
    await X.restoreLabSnapshot(snapA);
    sample(990);
    frame(DT);
    assert.ok(Math.abs(session.segOmega - wA) < 0.05 && Math.abs(session.segOmega - wOf(990)) > 0.2,
      `4. open loop never writes the sensor into ω — ${session.segOmega}`);
    assert.ok(Math.abs(est() - 990) < 100, `4. …while the estimator still follows the rig — ${est()}`);
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
    reconnected.pinRpm(450);
    reconnected._tick();
    frame(DT);
    const rpm = est();
    assert.ok(rpm !== null && Math.abs(rpm - 450) < 20 && Math.abs(session.segOmega - wOf(rpm)) < 1e-9,
      `5. after a reconnect the first sample overrides at once (no stale hold; the filter restarts) — ${session.segOmega}, ${rpm} RPM`);
    await hw.disconnect();
  });
});
