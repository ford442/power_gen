#!/usr/bin/env node
/**
 * src/frame-clock.ts — the one clock UI panels repaint on.
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
 * Usage: node scripts/test-frame-clock.mjs   (exit 1 on failure)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

// One bundle so LabSession and the test share the same clock module instance.
const result = await esbuild.build({
  stdin: {
    contents: "export * from './src/frame-clock.ts'; export { LabSession } from './src/session/lab-session.ts';",
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  write: false,
  logLevel: 'silent',
  loader: { '.wgsl': 'text', '.glsl': 'text' },
  define: { 'import.meta.url': '"file:///stub/frame-clock-test.js"' },
  plugins: [viteRawStub]
});
const { onFrame, tickFrameClock, frameClockSubscriberCount, LabSession } = await import(
  `data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`
);

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

/** Drive `frames` ticks at `fps` from t0, with optional ±jitter ms. */
function drive(frames, fps, t0 = 0, jitter = 0) {
  for (let i = 0; i < frames; i++) {
    const j = jitter ? (i % 2 ? jitter : -jitter) : 0;
    tickFrameClock(t0 + (i * 1000) / fps + j);
  }
}

// ── 1. hz throttle ──────────────────────────────────────────────
{
  let every = 0;
  let ten = 0;
  let twenty = 0;
  const offs = [
    onFrame(() => every++),
    onFrame(() => ten++, { hz: 10 }),
    onFrame(() => twenty++, { hz: 20 })
  ];
  drive(60, 60);
  check('unthrottled subscriber runs every tick', every === 60, `ran ${every}`);
  check('10 Hz subscriber runs 10× in one 60 Hz second', ten === 10, `ran ${ten}`);
  check('20 Hz subscriber runs 20× in one 60 Hz second', twenty === 20, `ran ${twenty}`);
  offs.forEach((off) => off());

  let jittered = 0;
  const off = onFrame(() => jittered++, { hz: 10 });
  drive(60, 60, 5000, 1.5);
  off();
  check('10 Hz survives ±1.5 ms frame jitter', jittered === 10, `ran ${jittered}`);

  let slow = 0;
  const offSlow = onFrame(() => slow++, { hz: 10 });
  drive(30, 30, 9000);
  offSlow();
  check('10 Hz subscriber on a 30 Hz display still runs 10×/s', slow === 10, `ran ${slow}`);
}

// ── 2. dt ───────────────────────────────────────────────────────
{
  const dts = [];
  const off = onFrame(({ dt }) => dts.push(dt), { hz: 10 });
  drive(13, 60, 20000);
  off();
  check('dt is 0 on the first call', dts[0] === 0, `got ${dts[0]}`);
  check('dt is seconds since this subscriber last ran', Math.abs(dts[1] - 0.1) < 1e-9, `got ${dts[1]}`);
}

// ── 3. Unsubscribe ──────────────────────────────────────────────
{
  const before = frameClockSubscriberCount();
  let n = 0;
  const off = onFrame(() => n++);
  tickFrameClock(30000);
  off();
  tickFrameClock(30016);
  check('returned off() stops the subscriber', n === 1, `ran ${n}`);

  const ctrl = new AbortController();
  let m = 0;
  onFrame(() => m++, { signal: ctrl.signal });
  tickFrameClock(30032);
  ctrl.abort();
  tickFrameClock(30048);
  check('aborted signal stops the subscriber', m === 1, `ran ${m}`);

  const pre = new AbortController();
  pre.abort();
  let never = 0;
  onFrame(() => never++, { signal: pre.signal });
  tickFrameClock(30064);
  check('already-aborted signal never subscribes', never === 0, `ran ${never}`);

  // Mid-tick: A removes B before B's turn; B must not run this tick.
  let bRan = 0;
  let offB = () => {};
  const offA = onFrame(() => offB());
  offB = onFrame(() => bRan++);
  tickFrameClock(30080);
  offA();
  check('unsubscribed mid-tick does not run that tick', bRan === 0, `ran ${bRan}`);
  check('no subscriber leaked', frameClockSubscriberCount() === before, `${frameClockSubscriberCount()} vs ${before}`);
}

// ── 4. Throwing subscriber ──────────────────────────────────────
{
  const err = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  let after = 0;
  const offBad = onFrame(() => { throw new Error('boom'); });
  const offGood = onFrame(() => after++);
  try {
    tickFrameClock(40000);
  } catch {
    check('tickFrameClock never throws', false);
  }
  console.error = err;
  offBad();
  offGood();
  check('a throwing subscriber does not stop the others', after === 1, `ran ${after}`);
  check('the throw is logged', logged === 1, `logged ${logged}`);
}

// ── 5. LabSession.publishFrame ticks the clock ──────────────────
{
  const session = new LabSession();
  let n = 0;
  const off = onFrame(() => n++);
  session.publishFrame(1 / 60, 0);
  session.publishFrame(1 / 60, 0);
  check('publishFrame ticks the clock once per call', n === 2, `ticked ${n}`);
  session.replayLocked = true;
  session.publishFrame(1 / 60, 0);
  check('replay-locked publishFrame still ticks (panels keep painting during replay)', n === 3, `ticked ${n}`);
  off();
}

if (failures.length) {
  for (const f of failures) console.error('[frame-clock] FAIL', f);
  process.exit(1);
}
console.log(`[frame-clock] ${checks} checks OK — hz throttle, dt, unsubscribe, error isolation, publishFrame tick`);
