#!/usr/bin/env node
/**
 * test-camera-gestures.mjs — contracts for touch camera input (#224 §5).
 *
 * The DOM half (listeners, pointer capture) is pinned by e2e with a touch
 * context; everything that can be *wrong* is arithmetic and bookkeeping, so it
 * is checked here:
 *
 *   1. One pointer orbits by exactly its delta; a mouse never taps.
 *   2. Double-tap: two quick, still taps on touch/pen fire once, at the second
 *      tap; slow, far, dragged, two-finger or cancelled taps never do — and the
 *      `lostpointercapture` that follows every pointerup must not eat tap one.
 *   3. Two fingers: centroid pan + span-ratio zoom, no orbit; per-sample zoom
 *      clamp; a third finger is ignored; lifting one finger hands back to orbit
 *      without a jump.
 *   4. camera-touch.ts: pan moves eye and target together and keeps the
 *      distance; dolly scales it and clamps; junk input is a no-op.
 *   5. Double-tap pick: the device nearest the tap within the radius, never a
 *      disabled one, never one behind the eye; and the touch router maps a
 *      double-tap to focus ↔ overview, a one-finger drag to the mouse's orbit.
 *   6. Structure: Pointer Events only, capture kept, the mouse path unchanged,
 *      touch/pen routed to the lazy chunk, `touch-action: none` in CSS.
 *
 * Usage: node scripts/test-camera-gestures.mjs   (exit 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The device registry pulls in every plugin (and their `?raw` shaders); the
 * pick only needs positions, so tests hand it a fixture lab instead.
 */
const registryStub = {
  name: 'device-registry-stub',
  setup(build) {
    build.onResolve({ filter: /\/device-registry$/ }, () => ({ path: 'registry', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const getMergedDeviceConfig = () => globalThis.__TEST_DEVICES__ ?? {};',
      loader: 'js'
    }));
  }
};

/** Bundle, so a module's relative imports resolve. */
async function importTsBundle(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    plugins: [registryStub]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const g = await importTsBundle('src/camera-gestures.ts');
const { GESTURE } = g;
const { createGestureTracker } = g;

/** Pointer sample helper: touch unless told otherwise. */
const P = (id, x, y, t, type = 'touch') => ({ id, x, y, t, type });
const kinds = (intents) => intents.map((i) => i.kind);
const sum = (intents, kind, key) => intents.filter((i) => i.kind === kind).reduce((s, i) => s + i[key], 0);

// ── 1. One pointer orbits ──────────────────────────────────────────────────
{
  for (const type of ['mouse', 'touch', 'pen']) {
    const tr = createGestureTracker();
    tr.down(P(1, 100, 100, 0, type));
    const out = [
      ...tr.move(P(1, 110, 95, 16, type)),
      ...tr.move(P(1, 140, 80, 32, type)),
      ...tr.move(P(1, 140, 80, 48, type))
    ];
    check(`${type}: one pointer only orbits`, kinds(out).every((k) => k === 'orbit'), kinds(out).join(','));
    check(`${type}: orbit deltas sum to the drag`, sum(out, 'orbit', 'dx') === 40 && sum(out, 'orbit', 'dy') === -20,
      `dx=${sum(out, 'orbit', 'dx')} dy=${sum(out, 'orbit', 'dy')}`);
    check(`${type}: a zero move emits nothing`, out.length === 2, `${out.length} intents`);
    tr.up(P(1, 140, 80, 60, type));
    check(`${type}: pointer released`, tr.activeCount === 0, String(tr.activeCount));
  }

  const tr = createGestureTracker();
  check('moves of an untracked pointer are ignored (mouse hover)',
    tr.move(P(9, 5, 5, 0, 'mouse')).length === 0, 'hover produced intents');

  const taps = [];
  for (let i = 0; i < 2; i++) {
    tr.down(P(1, 50, 50, i * 100, 'mouse'));
    taps.push(...tr.up(P(1, 50, 50, i * 100 + 40, 'mouse')));
  }
  check('a mouse double-click is not a double-tap', taps.length === 0, kinds(taps).join(','));
}

// ── 2. Double-tap ──────────────────────────────────────────────────────────
{
  const tapTwice = (tr, a, b, opts = {}) => {
    const out = [];
    tr.down(P(1, a.x, a.y, a.t, opts.type));
    out.push(...tr.up(P(1, a.x, a.y, a.t + (opts.hold ?? 60), opts.type)));
    if (opts.lostCapture) tr.cancel(1); // fires after every pointerup
    if (opts.between) opts.between(tr);
    tr.down(P(2, b.x, b.y, b.t, opts.type));
    out.push(...tr.up(P(2, b.x, b.y, b.t + (opts.hold ?? 60), opts.type)));
    return out;
  };

  let out = tapTwice(createGestureTracker(), { x: 200, y: 120, t: 0 }, { x: 205, y: 118, t: 200 });
  check('two quick taps fire one doubleTap', kinds(out).join(',') === 'doubleTap', kinds(out).join(','));
  check('doubleTap reports the second tap', out[0]?.x === 205 && out[0]?.y === 118, JSON.stringify(out[0]));

  out = tapTwice(createGestureTracker(), { x: 200, y: 120, t: 0 }, { x: 200, y: 120, t: 200 }, { type: 'pen' });
  check('pen double-taps too', kinds(out).join(',') === 'doubleTap', kinds(out).join(','));

  out = tapTwice(createGestureTracker(), { x: 200, y: 120, t: 0 }, { x: 200, y: 120, t: 200 }, { lostCapture: true });
  check('lostpointercapture after pointerup does not eat the first tap',
    kinds(out).join(',') === 'doubleTap', kinds(out).join(',') || 'none');

  out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 60 + GESTURE.doubleTapMs + 1 });
  check('too slow is two single taps', out.length === 0, kinds(out).join(','));

  out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: GESTURE.doubleTapSlopPx + 1, y: 0, t: 200 });
  check('too far apart is two single taps', out.length === 0, kinds(out).join(','));

  out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 400 }, { hold: GESTURE.tapMs + 1 });
  check('a long press is not a tap', out.length === 0, kinds(out).join(','));

  out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 200 }, {
    between: (tr) => { tr.down(P(7, 0, 0, 100)); tr.move(P(7, 40, 0, 120)); tr.up(P(7, 40, 0, 140)); }
  });
  check('a drag between taps breaks the pair', out.length === 0, kinds(out).join(','));

  out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 200 }, {
    between: (tr) => { tr.down(P(7, 0, 0, 100)); tr.cancel(7); }
  });
  check('a cancelled pointer between taps breaks the pair', out.length === 0, kinds(out).join(','));

  const tr = createGestureTracker();
  tr.down(P(1, 0, 0, 0));
  tr.move(P(1, GESTURE.tapSlopPx + 1, 0, 20));
  tr.move(P(1, 0, 0, 40)); // back where it started — still a drag
  const dragUp = tr.up(P(1, 0, 0, 60));
  tr.down(P(2, 0, 0, 100));
  out = [...dragUp, ...tr.up(P(2, 0, 0, 140))];
  check('a drag that returns home is not a tap', out.length === 0, kinds(out).join(','));

  const tr2 = createGestureTracker();
  tr2.down(P(1, 0, 0, 0));
  tr2.down(P(2, 50, 0, 10));
  tr2.up(P(2, 50, 0, 40));
  out = tr2.up(P(1, 0, 0, 50));
  tr2.down(P(3, 0, 0, 120));
  out.push(...tr2.up(P(3, 0, 0, 160)));
  check('a two-finger touch is never half of a double-tap', out.length === 0, kinds(out).join(','));

  const tr3 = createGestureTracker();
  out = [];
  for (let i = 0; i < 3; i++) {
    tr3.down(P(i, 10, 10, i * 150));
    out.push(...tr3.up(P(i, 10, 10, i * 150 + 30)));
  }
  check('a triple tap fires once, not twice', kinds(out).join(',') === 'doubleTap', kinds(out).join(','));
}

// ── 3. Two fingers: pan + pinch ────────────────────────────────────────────
{
  const tr = createGestureTracker();
  tr.down(P(1, 100, 100, 0));
  tr.down(P(2, 200, 100, 5));
  check('second finger down emits nothing', tr.activeCount === 2, String(tr.activeCount));

  // Spread symmetrically: span 100 → 200, centroid fixed.
  let out = [];
  for (let s = 1; s <= 10; s++) {
    out.push(...tr.move(P(1, 100 - 5 * s, 100, 10 + s)));
    out.push(...tr.move(P(2, 200 + 5 * s, 100, 10 + s)));
  }
  check('pinch emits no orbit', !kinds(out).includes('orbit'), kinds(out).join(','));
  const product = out.filter((i) => i.kind === 'zoom').reduce((p, i) => p * i.scale, 1);
  check('spreading 100 → 200 px halves the distance', near(product, 0.5, 1e-9), String(product));
  check('every zoom sample is closer (< 1) when spreading',
    out.filter((i) => i.kind === 'zoom').every((i) => i.scale < 1), 'a zoom-out sample while spreading');
  const panDx = sum(out, 'pan', 'dx');
  check('a symmetric spread barely pans', Math.abs(panDx) <= 5 + 1e-9 && Math.abs(sum(out, 'pan', 'dy')) < 1e-9,
    `pan dx=${panDx}`);

  // Both fingers slide right 60 px: pure pan, no zoom.
  out = [];
  for (let s = 1; s <= 6; s++) {
    out.push(...tr.move(P(1, 50 + 10 * s, 100, 30 + s)));
    out.push(...tr.move(P(2, 250 + 10 * s, 100, 30 + s)));
  }
  check('a two-finger slide pans by the centroid travel', near(sum(out, 'pan', 'dx'), 60) && near(sum(out, 'pan', 'dy'), 0),
    `dx=${sum(out, 'pan', 'dx')} dy=${sum(out, 'pan', 'dy')}`);
  const zoomDrift = out.filter((i) => i.kind === 'zoom').reduce((p, i) => p * i.scale, 1);
  check('…and the net zoom over the slide is 1', near(zoomDrift, 1, 1e-9), String(zoomDrift));

  // A third finger is ignored.
  tr.down(P(3, 500, 500, 50));
  out = tr.move(P(3, 600, 600, 51));
  check('a third finger drives nothing', out.length === 0, kinds(out).join(','));

  // Lift finger 1 then 3: finger 2 alone orbits from its *last* sample.
  tr.up(P(1, 110, 100, 60));
  tr.up(P(3, 600, 600, 61));
  out = tr.move(P(2, 320, 104, 70));
  check('lifting to one finger hands back to orbit without a jump',
    kinds(out).join(',') === 'orbit' && out[0].dx === 10 && out[0].dy === 4, JSON.stringify(out));

  const clamp = createGestureTracker();
  clamp.down(P(1, 0, 0, 0));
  clamp.down(P(2, 10, 0, 0));
  const big = clamp.move(P(2, 1000, 0, 1)).find((i) => i.kind === 'zoom');
  check('one wild sample is clamped to minZoomScale', big?.scale === GESTURE.minZoomScale, JSON.stringify(big));
  const back = clamp.move(P(2, 10, 0, 2)).find((i) => i.kind === 'zoom');
  check('…and to maxZoomScale the other way', back?.scale === GESTURE.maxZoomScale, JSON.stringify(back));
  const stacked = createGestureTracker();
  stacked.down(P(1, 0, 0, 0));
  stacked.down(P(2, 2, 0, 0));
  const tiny = stacked.move(P(2, 4, 0, 1));
  check('fingers on top of each other give no zoom ratio', !kinds(tiny).includes('zoom'), kinds(tiny).join(','));
}

// ── 4. Pan / dolly ─────────────────────────────────────────────────────────
const touchMod = await importTsBundle('src/camera-touch.ts');
const { CameraController } = await importTsBundle('src/camera-controller.ts');
const dist = (c) => Math.hypot(...c.position.map((v, i) => v - c.target[i]));
{
  const { panCamera, dollyCamera, MIN_DISTANCE, MAX_DISTANCE } = touchMod;
  const cam = new CameraController().camera;
  const d0 = dist(cam);
  dollyCamera(cam, 0.5);
  check('dolly(0.5) halves the eye–target distance', near(dist(cam), d0 * 0.5, 1e-9), `${dist(cam)} vs ${d0 / 2}`);
  check('dolly keeps the target', cam.target.every((v) => v === 0), JSON.stringify(cam.target));
  const dir = cam.position.map((v) => v / dist(cam));
  check('dolly keeps the view direction',
    near(dir[1], 8 / Math.hypot(8, 18), 1e-9) && near(dir[2], 18 / Math.hypot(8, 18), 1e-9), JSON.stringify(dir));
  for (let i = 0; i < 40; i++) dollyCamera(cam, 0.5);
  check('dolly clamps at the near limit', near(dist(cam), MIN_DISTANCE, 1e-9), String(dist(cam)));
  for (let i = 0; i < 40; i++) dollyCamera(cam, 2);
  check('dolly clamps at the far limit', near(dist(cam), MAX_DISTANCE, 1e-9), String(dist(cam)));
  check('the far limit stays inside the far plane (200)', MAX_DISTANCE < 200, String(MAX_DISTANCE));
  const before = [...cam.position];
  for (const junk of [Number.NaN, 0, -1, Infinity]) dollyCamera(cam, junk);
  check('dolly ignores NaN / 0 / negative / Infinity', cam.position.every((v, i) => v === before[i]),
    JSON.stringify(cam.position));

  const pc = new CameraController().camera;
  const pd0 = dist(pc);
  const eye0 = [...pc.position];
  const tgt0 = [...pc.target];
  const viewport = 800;
  panCamera(pc, viewport, 0, viewport);
  const moved = pc.target.map((v, i) => v - tgt0[i]);
  const eyeMoved = pc.position.map((v, i) => v - eye0[i]);
  check('pan moves eye and target by the same vector', moved.every((v, i) => near(v, eyeMoved[i], 1e-9)),
    `${JSON.stringify(moved)} vs ${JSON.stringify(eyeMoved)}`);
  check('pan keeps the distance', near(dist(pc), pd0, 1e-9), `${dist(pc)} vs ${pd0}`);
  const expect = 2 * pd0 * Math.tan((pc.fov * Math.PI) / 360);
  check('one viewport of drag moves one view-height of world at the target',
    near(Math.hypot(...moved), expect, 1e-9), `${Math.hypot(...moved)} vs ${expect}`);
  // Camera at +z looking at the origin: screen-right is +x, so dragging the
  // scene right slides the camera to −x.
  check('dragging right slides the camera left (scene follows the fingers)', moved[0] < 0 && near(moved[1], 0, 1e-9),
    JSON.stringify(moved));
  const q = new CameraController().camera;
  panCamera(q, 0, 100, 800);
  check('dragging down slides the camera up', q.target[1] > 0, JSON.stringify(q.target));

  const top = new CameraController().camera;
  top.position = [0, 10, 0];
  panCamera(top, 50, 50, 800);
  check('pan straight down the up-axis is a no-op, not NaN', top.position.every(Number.isFinite)
    && top.target.every((v) => v === 0), JSON.stringify(top));
  const z = new CameraController().camera;
  panCamera(z, 10, 10, 0);
  check('pan with a zero-height viewport is a no-op', z.target.every((v) => v === 0), JSON.stringify(z.target));
}

// ── 5. Double-tap pick + the touch router ──────────────────────────────────
{
  const { pickDeviceAt, createTouchInput } = touchMod;
  const { MultiDeviceCamera } = await importTsBundle('src/multi-device-camera.ts');
  globalThis.__TEST_DEVICES__ = {
    seg: { position: [0, 0, -8] },
    heron: { position: [-7, 0, 4] },
    kelvin: { position: [7, 0, 4] },
    behind: { position: [0, 8, 40] } // past the default eye at z = 18
  };
  const W = 800;
  const H = 600;
  const canvas = { width: W, height: H, clientHeight: H, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  const host = { currentView: 'overview', devicesEnabled: { seg: true, heron: true, kelvin: true, behind: true } };
  const controller = new CameraController();
  const mdc = new MultiDeviceCamera(canvas, controller.camera, host);
  const screenOf = (p) => {
    const m = mdc.getViewProjMatrix();
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return {
      x: ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) * 0.5 * W,
      y: (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * 0.5 * H
    };
  };
  const seg = screenOf([0, 0, -8]);
  const heron = screenOf([-7, 0, 4]);
  check('a tap on the SEG picks seg', pickDeviceAt(mdc, seg.x, seg.y) === 'seg', String(pickDeviceAt(mdc, seg.x, seg.y)));
  check('a tap 20 px off the Heron still picks heron', pickDeviceAt(mdc, heron.x + 20, heron.y) === 'heron',
    String(pickDeviceAt(mdc, heron.x + 20, heron.y)));
  check('a tap in an empty corner picks nothing', pickDeviceAt(mdc, 2, 2) === null, String(pickDeviceAt(mdc, 2, 2)));
  host.devicesEnabled.seg = false;
  check('a disabled device is never picked', pickDeviceAt(mdc, seg.x, seg.y) !== 'seg', String(pickDeviceAt(mdc, seg.x, seg.y)));
  host.devicesEnabled.seg = true;
  const ghost = screenOf([0, 8, 40]);
  check('a device behind the eye is never picked', pickDeviceAt(mdc, ghost.x, ghost.y) !== 'behind',
    String(pickDeviceAt(mdc, ghost.x, ghost.y)));

  // Router: PointerEvent-shaped objects through handle().
  const modes = [];
  const input = createTouchInput(controller, canvas, (m) => modes.push(m), () => mdc);
  let t = 0;
  const ev = (type, id, x, y) => input.handle({ type, pointerId: id, clientX: x, clientY: y, pointerType: 'touch', timeStamp: (t += 40) });
  const tap = (x, y) => { ev('pointerdown', 1, x, y); ev('pointerup', 1, x, y); ev('lostpointercapture', 1, x, y); };
  tap(seg.x, seg.y);
  tap(seg.x, seg.y);
  check('double-tap on a device in the overview focuses it', modes.join(',') === 'seg', modes.join(','));
  host.currentView = 'seg';
  tap(10, 10);
  tap(10, 10);
  check('double-tap in a device view returns to the overview', modes.join(',') === 'seg,overview', modes.join(','));
  host.currentView = 'overview';
  tap(2, 2);
  tap(2, 2);
  check('double-tap on empty space re-frames the overview', modes.at(-1) === 'overview' && modes.length === 3,
    modes.join(','));

  const ref = new CameraController();
  ref.orbit(100 * 0.01, 0);
  const yawRef = Math.atan2(ref.camera.position[2], ref.camera.position[0]);
  const c2 = new CameraController();
  const drag = createTouchInput(c2, canvas, () => {}, () => null);
  drag.handle({ type: 'pointerdown', pointerId: 5, clientX: 100, clientY: 100, pointerType: 'touch', timeStamp: 0 });
  drag.handle({ type: 'pointermove', pointerId: 5, clientX: 200, clientY: 100, pointerType: 'touch', timeStamp: 16 });
  const yaw = Math.atan2(c2.camera.position[2], c2.camera.position[0]);
  check('a 100 px finger drag orbits exactly like a 100 px mouse drag', near(yaw, yawRef, 1e-12), `${yaw} vs ${yawRef}`);
  const noFocus = [];
  const blind = createTouchInput(new CameraController(), canvas, (m) => noFocus.push(m));
  for (let i = 0; i < 2; i++) {
    blind.handle({ type: 'pointerdown', pointerId: 1, clientX: 5, clientY: 5, pointerType: 'touch', timeStamp: i * 100 });
    blind.handle({ type: 'pointerup', pointerId: 1, clientX: 5, clientY: 5, pointerType: 'touch', timeStamp: i * 100 + 30 });
  }
  check('without a focus host, double-tap changes no mode', noFocus.length === 0, noFocus.join(','));
}

// ── 6. Structure ───────────────────────────────────────────────────────────
{
  const src = read('src/camera-controller.ts');
  check('camera input is Pointer Events only', !/addEventListener\('(mouse|touch)[a-z]+'/.test(src),
    'a mouse or touch listener crept back in');
  check('pointer capture is kept (#221)', /setPointerCapture/.test(src) && /lostpointercapture/.test(src),
    'setPointerCapture / lostpointercapture missing');
  check('the mouse path still orbits left-drags at ORBIT_RAD_PER_PX',
    /this\.mouseButtons & 1/.test(src) && /this\.orbit\(deltaX \* ORBIT_RAD_PER_PX, deltaY \* ORBIT_RAD_PER_PX\)/.test(src),
    'mouse orbit path changed');
  check('the wheel still zooms by deltaY * 0.001', /this\.zoom\(e\.deltaY \* 0\.001\)/.test(src), 'wheel path changed');
  check('touch/pen go to the lazy chunk', /pointerType !== 'mouse'/.test(src) && /import\('\.\/camera-touch'\)/.test(src),
    'non-mouse pointers are not routed to camera-touch.ts');
  check('camera-touch is only type-imported by the controller (stays lazy)',
    !/^import \{[^}]*\} from '\.\/camera-touch'/m.test(src), 'a value import would pull camera-touch into the entry');
  const css = read('src/styles/seg-dashboard-layout.css');
  check('#gpuCanvas has touch-action: none in CSS', /#gpuCanvas\s*\{[^}]*touch-action:\s*none/.test(css),
    'no touch-action rule for #gpuCanvas');
  for (const rel of ['src/visualizer/init-methods.ts', 'src/renderers/webgl2/index.js']) {
    check(`${rel} wires double-tap focus`, /setupInteraction\([^;]*\(\) => this\.cameraController\)/.test(read(rel)),
      'setupInteraction is called without the focus getter');
  }
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[camera-gestures] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[camera-gestures] ${ok.length} checks passed`);
