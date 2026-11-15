/**
 * frame-clock — src/frame-clock.ts, the one clock UI panels repaint on.
 *
 * 1. hz throttle: a 10 Hz subscriber on a 60 Hz tick stream runs 10×/s, an
 *    unthrottled one every tick; jittered timestamps do not drop a slot.
 * 2. dt: 0 on the first call, then seconds since that subscriber last ran.
 * 3. Unsubscribe: the returned function and an aborted signal both stop it,
 *    including mid-tick; an already-aborted signal never subscribes.
 * 4. A throwing subscriber is contained; the others still run.
 * 5. LabSession.publishFrame ticks the clock once per call (the render loop's
 *    single publish point), even when the publish itself is replay-locked.
 *
 * Usage: npm run test:frame-clock   (node --test scripts/tests/frame-clock.test.mjs)
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { bundleTs } from '../test-harness.mjs';

let onFrame, tickFrameClock, frameClockSubscriberCount, LabSession;
before(async () => {
  // One bundle so LabSession and the test share the same clock module instance.
  ({ onFrame, tickFrameClock, frameClockSubscriberCount, LabSession } = await bundleTs({
    contents: "export * from './src/frame-clock.ts'; export { LabSession } from './src/session/lab-session.ts';",
    sourcefile: 'frame-clock-entry.ts'
  }));
});

/** Drive `frames` ticks at `fps` from t0, with optional ±jitter ms. */
function drive(frames, fps, t0 = 0, jitter = 0) {
  for (let i = 0; i < frames; i++) {
    const j = jitter ? (i % 2 ? jitter : -jitter) : 0;
    tickFrameClock(t0 + (i * 1000) / fps + j);
  }
}

describe('hz throttle', () => {
  it('unthrottled / 10 Hz / 20 Hz subscribers on one 60 Hz second', () => {
    let every = 0;
    let ten = 0;
    let twenty = 0;
    const offs = [
      onFrame(() => every++),
      onFrame(() => ten++, { hz: 10 }),
      onFrame(() => twenty++, { hz: 20 })
    ];
    drive(60, 60);
    offs.forEach((off) => off());
    assert.ok(every === 60, `unthrottled subscriber runs every tick: ran ${every}`);
    assert.ok(ten === 10, `10 Hz subscriber runs 10× in one 60 Hz second: ran ${ten}`);
    assert.ok(twenty === 20, `20 Hz subscriber runs 20× in one 60 Hz second: ran ${twenty}`);
  });

  it('10 Hz survives ±1.5 ms frame jitter', () => {
    let jittered = 0;
    const off = onFrame(() => jittered++, { hz: 10 });
    drive(60, 60, 5000, 1.5);
    off();
    assert.ok(jittered === 10, `ran ${jittered}`);
  });

  it('10 Hz subscriber on a 30 Hz display still runs 10×/s', () => {
    let slow = 0;
    const offSlow = onFrame(() => slow++, { hz: 10 });
    drive(30, 30, 9000);
    offSlow();
    assert.ok(slow === 10, `ran ${slow}`);
  });
});

describe('dt', () => {
  it('0 on the first call, then seconds since this subscriber last ran', () => {
    const dts = [];
    const off = onFrame(({ dt }) => dts.push(dt), { hz: 10 });
    drive(13, 60, 20000);
    off();
    assert.ok(dts[0] === 0, `dt is 0 on the first call: got ${dts[0]}`);
    assert.ok(Math.abs(dts[1] - 0.1) < 1e-9, `dt is seconds since this subscriber last ran: got ${dts[1]}`);
  });
});

describe('unsubscribe', () => {
  let countBefore;
  before(() => { countBefore = frameClockSubscriberCount(); });

  it('returned off() stops the subscriber', () => {
    let n = 0;
    const off = onFrame(() => n++);
    tickFrameClock(30000);
    off();
    tickFrameClock(30016);
    assert.ok(n === 1, `ran ${n}`);
  });

  it('aborted signal stops the subscriber', () => {
    const ctrl = new AbortController();
    let m = 0;
    onFrame(() => m++, { signal: ctrl.signal });
    tickFrameClock(30032);
    ctrl.abort();
    tickFrameClock(30048);
    assert.ok(m === 1, `ran ${m}`);
  });

  it('already-aborted signal never subscribes', () => {
    const pre = new AbortController();
    pre.abort();
    let never = 0;
    onFrame(() => never++, { signal: pre.signal });
    tickFrameClock(30064);
    assert.ok(never === 0, `ran ${never}`);
  });

  it('unsubscribed mid-tick does not run that tick; no subscriber leaked', () => {
    // Mid-tick: A removes B before B's turn; B must not run this tick.
    let bRan = 0;
    let offB = () => {};
    const offA = onFrame(() => offB());
    offB = onFrame(() => bRan++);
    tickFrameClock(30080);
    offA();
    assert.ok(bRan === 0, `unsubscribed mid-tick does not run that tick: ran ${bRan}`);
    assert.ok(frameClockSubscriberCount() === countBefore, `no subscriber leaked: ${frameClockSubscriberCount()} vs ${countBefore}`);
  });
});

describe('throwing subscriber', () => {
  it('is contained and logged; the others still run', () => {
    const err = console.error;
    let logged = 0;
    console.error = () => { logged++; };
    let after = 0;
    const offBad = onFrame(() => { throw new Error('boom'); });
    const offGood = onFrame(() => after++);
    try {
      assert.doesNotThrow(() => tickFrameClock(40000), 'tickFrameClock never throws');
    } finally {
      console.error = err;
      offBad();
      offGood();
    }
    assert.ok(after === 1, `a throwing subscriber does not stop the others: ran ${after}`);
    assert.ok(logged === 1, `the throw is logged: logged ${logged}`);
  });
});

describe('LabSession.publishFrame ticks the clock', () => {
  it('once per call, and still when replay-locked', () => {
    const session = new LabSession();
    let n = 0;
    const off = onFrame(() => n++);
    try {
      session.publishFrame(1 / 60, 0);
      session.publishFrame(1 / 60, 0);
      assert.ok(n === 2, `publishFrame ticks the clock once per call: ticked ${n}`);
      session.replayLocked = true;
      session.publishFrame(1 / 60, 0);
      assert.ok(n === 3, `replay-locked publishFrame still ticks (panels keep painting during replay): ticked ${n}`);
    } finally {
      off();
    }
  });
});
