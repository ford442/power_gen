/**
 * camera-gestures — contracts for touch camera input (#224 §5).
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
 * Usage: npm run test:camera-gestures   (node --test scripts/tests/camera-gestures.test.mjs)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { ROOT, bundleTs, near } from '../test-harness.mjs';

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
const importTsBundle = (rel) => bundleTs(rel, { plugins: [registryStub] });

const g = await importTsBundle('src/camera-gestures.ts');
const { GESTURE, createGestureTracker } = g;
const touchMod = await importTsBundle('src/camera-touch.ts');
const { CameraController } = await importTsBundle('src/camera-controller.ts');
const { MultiDeviceCamera } = await importTsBundle('src/multi-device-camera.ts');

/** Pointer sample helper: touch unless told otherwise. */
const P = (id, x, y, t, type = 'touch') => ({ id, x, y, t, type });
const kinds = (intents) => intents.map((i) => i.kind);
const sum = (intents, kind, key) => intents.filter((i) => i.kind === kind).reduce((s, i) => s + i[key], 0);

describe('1. one pointer orbits', () => {
  for (const type of ['mouse', 'touch', 'pen']) {
    it(`${type}: only orbits, deltas sum to the drag, zero move emits nothing, pointer released`, () => {
      const tr = createGestureTracker();
      tr.down(P(1, 100, 100, 0, type));
      const out = [
        ...tr.move(P(1, 110, 95, 16, type)),
        ...tr.move(P(1, 140, 80, 32, type)),
        ...tr.move(P(1, 140, 80, 48, type))
      ];
      assert.ok(kinds(out).every((k) => k === 'orbit'), `${type}: one pointer only orbits — ${kinds(out).join(',')}`);
      assert.ok(sum(out, 'orbit', 'dx') === 40 && sum(out, 'orbit', 'dy') === -20,
        `${type}: orbit deltas sum to the drag — dx=${sum(out, 'orbit', 'dx')} dy=${sum(out, 'orbit', 'dy')}`);
      assert.ok(out.length === 2, `${type}: a zero move emits nothing — ${out.length} intents`);
      tr.up(P(1, 140, 80, 60, type));
      assert.ok(tr.activeCount === 0, `${type}: pointer released — ${tr.activeCount}`);
    });
  }

  describe('untracked and mouse pointers', () => {
    const tr = createGestureTracker();
    it('moves of an untracked pointer are ignored (mouse hover)', () => {
      assert.ok(tr.move(P(9, 5, 5, 0, 'mouse')).length === 0, 'hover produced intents');
    });
    it('a mouse double-click is not a double-tap', () => {
      const taps = [];
      for (let i = 0; i < 2; i++) {
        tr.down(P(1, 50, 50, i * 100, 'mouse'));
        taps.push(...tr.up(P(1, 50, 50, i * 100 + 40, 'mouse')));
      }
      assert.ok(taps.length === 0, kinds(taps).join(','));
    });
  });
});

describe('2. double-tap', () => {
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

  it('two quick taps fire one doubleTap, at the second tap', () => {
    const out = tapTwice(createGestureTracker(), { x: 200, y: 120, t: 0 }, { x: 205, y: 118, t: 200 });
    assert.ok(kinds(out).join(',') === 'doubleTap', `two quick taps fire one doubleTap — ${kinds(out).join(',')}`);
    assert.ok(out[0]?.x === 205 && out[0]?.y === 118, `doubleTap reports the second tap — ${JSON.stringify(out[0])}`);
  });
  it('pen double-taps too', () => {
    const out = tapTwice(createGestureTracker(), { x: 200, y: 120, t: 0 }, { x: 200, y: 120, t: 200 }, { type: 'pen' });
    assert.ok(kinds(out).join(',') === 'doubleTap', kinds(out).join(','));
  });
  it('lostpointercapture after pointerup does not eat the first tap', () => {
    const out = tapTwice(createGestureTracker(), { x: 200, y: 120, t: 0 }, { x: 200, y: 120, t: 200 }, { lostCapture: true });
    assert.ok(kinds(out).join(',') === 'doubleTap', kinds(out).join(',') || 'none');
  });
  it('too slow is two single taps', () => {
    const out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 60 + GESTURE.doubleTapMs + 1 });
    assert.ok(out.length === 0, kinds(out).join(','));
  });
  it('too far apart is two single taps', () => {
    const out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: GESTURE.doubleTapSlopPx + 1, y: 0, t: 200 });
    assert.ok(out.length === 0, kinds(out).join(','));
  });
  it('a long press is not a tap', () => {
    const out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 400 }, { hold: GESTURE.tapMs + 1 });
    assert.ok(out.length === 0, kinds(out).join(','));
  });
  it('a drag between taps breaks the pair', () => {
    const out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 200 }, {
      between: (tr) => { tr.down(P(7, 0, 0, 100)); tr.move(P(7, 40, 0, 120)); tr.up(P(7, 40, 0, 140)); }
    });
    assert.ok(out.length === 0, kinds(out).join(','));
  });
  it('a cancelled pointer between taps breaks the pair', () => {
    const out = tapTwice(createGestureTracker(), { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 200 }, {
      between: (tr) => { tr.down(P(7, 0, 0, 100)); tr.cancel(7); }
    });
    assert.ok(out.length === 0, kinds(out).join(','));
  });
  it('a drag that returns home is not a tap', () => {
    const tr = createGestureTracker();
    tr.down(P(1, 0, 0, 0));
    tr.move(P(1, GESTURE.tapSlopPx + 1, 0, 20));
    tr.move(P(1, 0, 0, 40)); // back where it started — still a drag
    const dragUp = tr.up(P(1, 0, 0, 60));
    tr.down(P(2, 0, 0, 100));
    const out = [...dragUp, ...tr.up(P(2, 0, 0, 140))];
    assert.ok(out.length === 0, kinds(out).join(','));
  });
  it('a two-finger touch is never half of a double-tap', () => {
    const tr2 = createGestureTracker();
    tr2.down(P(1, 0, 0, 0));
    tr2.down(P(2, 50, 0, 10));
    tr2.up(P(2, 50, 0, 40));
    const out = tr2.up(P(1, 0, 0, 50));
    tr2.down(P(3, 0, 0, 120));
    out.push(...tr2.up(P(3, 0, 0, 160)));
    assert.ok(out.length === 0, kinds(out).join(','));
  });
  it('a triple tap fires once, not twice', () => {
    const tr3 = createGestureTracker();
    const out = [];
    for (let i = 0; i < 3; i++) {
      tr3.down(P(i, 10, 10, i * 150));
      out.push(...tr3.up(P(i, 10, 10, i * 150 + 30)));
    }
    assert.ok(kinds(out).join(',') === 'doubleTap', kinds(out).join(','));
  });
});

describe('3. two fingers: pan + pinch', () => {
  // One tracker through the whole sequence: spread, slide, third finger, lift.
  const tr = createGestureTracker();

  it('second finger down emits nothing', () => {
    tr.down(P(1, 100, 100, 0));
    tr.down(P(2, 200, 100, 5));
    assert.ok(tr.activeCount === 2, String(tr.activeCount));
  });

  // Spread symmetrically: span 100 → 200, centroid fixed.
  it('spreading 100 → 200 px: no orbit, halves the distance, every sample closer, barely pans', () => {
    const out = [];
    for (let s = 1; s <= 10; s++) {
      out.push(...tr.move(P(1, 100 - 5 * s, 100, 10 + s)));
      out.push(...tr.move(P(2, 200 + 5 * s, 100, 10 + s)));
    }
    assert.ok(!kinds(out).includes('orbit'), `pinch emits no orbit — ${kinds(out).join(',')}`);
    const product = out.filter((i) => i.kind === 'zoom').reduce((p, i) => p * i.scale, 1);
    assert.ok(near(product, 0.5, 1e-9), `spreading 100 → 200 px halves the distance — ${product}`);
    assert.ok(out.filter((i) => i.kind === 'zoom').every((i) => i.scale < 1),
      'every zoom sample is closer (< 1) when spreading — a zoom-out sample while spreading');
    const panDx = sum(out, 'pan', 'dx');
    assert.ok(Math.abs(panDx) <= 5 + 1e-9 && Math.abs(sum(out, 'pan', 'dy')) < 1e-9, `a symmetric spread barely pans — pan dx=${panDx}`);
  });

  // Both fingers slide right 60 px: pure pan, no zoom.
  it('a two-finger slide pans by the centroid travel, net zoom 1', () => {
    const out = [];
    for (let s = 1; s <= 6; s++) {
      out.push(...tr.move(P(1, 50 + 10 * s, 100, 30 + s)));
      out.push(...tr.move(P(2, 250 + 10 * s, 100, 30 + s)));
    }
    assert.ok(near(sum(out, 'pan', 'dx'), 60) && near(sum(out, 'pan', 'dy'), 0),
      `a two-finger slide pans by the centroid travel — dx=${sum(out, 'pan', 'dx')} dy=${sum(out, 'pan', 'dy')}`);
    const zoomDrift = out.filter((i) => i.kind === 'zoom').reduce((p, i) => p * i.scale, 1);
    assert.ok(near(zoomDrift, 1, 1e-9), `…and the net zoom over the slide is 1 — ${zoomDrift}`);
  });

  it('a third finger drives nothing', () => {
    tr.down(P(3, 500, 500, 50));
    const out = tr.move(P(3, 600, 600, 51));
    assert.ok(out.length === 0, kinds(out).join(','));
  });

  // Lift finger 1 then 3: finger 2 alone orbits from its *last* sample.
  it('lifting to one finger hands back to orbit without a jump', () => {
    tr.up(P(1, 110, 100, 60));
    tr.up(P(3, 600, 600, 61));
    const out = tr.move(P(2, 320, 104, 70));
    assert.ok(kinds(out).join(',') === 'orbit' && out[0].dx === 10 && out[0].dy === 4, JSON.stringify(out));
  });

  it('one wild sample is clamped to minZoomScale, and to maxZoomScale the other way', () => {
    const clamp = createGestureTracker();
    clamp.down(P(1, 0, 0, 0));
    clamp.down(P(2, 10, 0, 0));
    const big = clamp.move(P(2, 1000, 0, 1)).find((i) => i.kind === 'zoom');
    assert.ok(big?.scale === GESTURE.minZoomScale, `one wild sample is clamped to minZoomScale — ${JSON.stringify(big)}`);
    const back = clamp.move(P(2, 10, 0, 2)).find((i) => i.kind === 'zoom');
    assert.ok(back?.scale === GESTURE.maxZoomScale, `…and to maxZoomScale the other way — ${JSON.stringify(back)}`);
  });
  it('fingers on top of each other give no zoom ratio', () => {
    const stacked = createGestureTracker();
    stacked.down(P(1, 0, 0, 0));
    stacked.down(P(2, 2, 0, 0));
    const tiny = stacked.move(P(2, 4, 0, 1));
    assert.ok(!kinds(tiny).includes('zoom'), kinds(tiny).join(','));
  });
});

describe('4. pan / dolly', () => {
  const dist = (c) => Math.hypot(...c.position.map((v, i) => v - c.target[i]));
  const { panCamera, dollyCamera, MIN_DISTANCE, MAX_DISTANCE } = touchMod;

  it('dolly: halves, keeps target and direction, clamps near/far, ignores junk', () => {
    const cam = new CameraController().camera;
    const d0 = dist(cam);
    dollyCamera(cam, 0.5);
    assert.ok(near(dist(cam), d0 * 0.5, 1e-9), `dolly(0.5) halves the eye–target distance — ${dist(cam)} vs ${d0 / 2}`);
    assert.ok(cam.target.every((v) => v === 0), `dolly keeps the target — ${JSON.stringify(cam.target)}`);
    const dir = cam.position.map((v) => v / dist(cam));
    assert.ok(near(dir[1], 8 / Math.hypot(8, 18), 1e-9) && near(dir[2], 18 / Math.hypot(8, 18), 1e-9),
      `dolly keeps the view direction — ${JSON.stringify(dir)}`);
    for (let i = 0; i < 40; i++) dollyCamera(cam, 0.5);
    assert.ok(near(dist(cam), MIN_DISTANCE, 1e-9), `dolly clamps at the near limit — ${dist(cam)}`);
    for (let i = 0; i < 40; i++) dollyCamera(cam, 2);
    assert.ok(near(dist(cam), MAX_DISTANCE, 1e-9), `dolly clamps at the far limit — ${dist(cam)}`);
    assert.ok(MAX_DISTANCE < 200, `the far limit stays inside the far plane (200) — ${MAX_DISTANCE}`);
    const prev = [...cam.position];
    for (const junk of [Number.NaN, 0, -1, Infinity]) dollyCamera(cam, junk);
    assert.ok(cam.position.every((v, i) => v === prev[i]), `dolly ignores NaN / 0 / negative / Infinity — ${JSON.stringify(cam.position)}`);
  });

  it('pan: eye and target move together, distance kept, one viewport = one view-height, scene follows the fingers', () => {
    const pc = new CameraController().camera;
    const pd0 = dist(pc);
    const eye0 = [...pc.position];
    const tgt0 = [...pc.target];
    const viewport = 800;
    panCamera(pc, viewport, 0, viewport);
    const moved = pc.target.map((v, i) => v - tgt0[i]);
    const eyeMoved = pc.position.map((v, i) => v - eye0[i]);
    assert.ok(moved.every((v, i) => near(v, eyeMoved[i], 1e-9)),
      `pan moves eye and target by the same vector — ${JSON.stringify(moved)} vs ${JSON.stringify(eyeMoved)}`);
    assert.ok(near(dist(pc), pd0, 1e-9), `pan keeps the distance — ${dist(pc)} vs ${pd0}`);
    const expect = 2 * pd0 * Math.tan((pc.fov * Math.PI) / 360);
    assert.ok(near(Math.hypot(...moved), expect, 1e-9),
      `one viewport of drag moves one view-height of world at the target — ${Math.hypot(...moved)} vs ${expect}`);
    // Camera at +z looking at the origin: screen-right is +x, so dragging the
    // scene right slides the camera to −x.
    assert.ok(moved[0] < 0 && near(moved[1], 0, 1e-9), `dragging right slides the camera left (scene follows the fingers) — ${JSON.stringify(moved)}`);
  });
  it('dragging down slides the camera up', () => {
    const q = new CameraController().camera;
    panCamera(q, 0, 100, 800);
    assert.ok(q.target[1] > 0, JSON.stringify(q.target));
  });
  it('pan straight down the up-axis is a no-op, not NaN', () => {
    const top = new CameraController().camera;
    top.position = [0, 10, 0];
    panCamera(top, 50, 50, 800);
    assert.ok(top.position.every(Number.isFinite) && top.target.every((v) => v === 0), JSON.stringify(top));
  });
  it('pan with a zero-height viewport is a no-op', () => {
    const z = new CameraController().camera;
    panCamera(z, 10, 10, 0);
    assert.ok(z.target.every((v) => v === 0), JSON.stringify(z.target));
  });
});

describe('5. double-tap pick + the touch router', () => {
  const { pickDeviceAt, createTouchInput } = touchMod;
  const W = 800;
  const H = 600;
  const canvas = { width: W, height: H, clientHeight: H, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  const host = { currentView: 'overview', devicesEnabled: { seg: true, heron: true, kelvin: true, behind: true } };
  let controller, mdc, seg, heron;
  const screenOf = (p) => {
    const m = mdc.getViewProjMatrix();
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return {
      x: ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) * 0.5 * W,
      y: (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * 0.5 * H
    };
  };
  before(() => {
    globalThis.__TEST_DEVICES__ = {
      seg: { position: [0, 0, -8] },
      heron: { position: [-7, 0, 4] },
      kelvin: { position: [7, 0, 4] },
      behind: { position: [0, 8, 40] } // past the default eye at z = 18
    };
    controller = new CameraController();
    mdc = new MultiDeviceCamera(canvas, controller.camera, host);
    seg = screenOf([0, 0, -8]);
    heron = screenOf([-7, 0, 4]);
  });

  it('a tap on the SEG picks seg', () => {
    assert.ok(pickDeviceAt(mdc, seg.x, seg.y) === 'seg', String(pickDeviceAt(mdc, seg.x, seg.y)));
  });
  it('a tap 20 px off the Heron still picks heron', () => {
    assert.ok(pickDeviceAt(mdc, heron.x + 20, heron.y) === 'heron', String(pickDeviceAt(mdc, heron.x + 20, heron.y)));
  });
  it('a tap in an empty corner picks nothing', () => {
    assert.ok(pickDeviceAt(mdc, 2, 2) === null, String(pickDeviceAt(mdc, 2, 2)));
  });
  it('a disabled device is never picked', () => {
    host.devicesEnabled.seg = false;
    try {
      assert.ok(pickDeviceAt(mdc, seg.x, seg.y) !== 'seg', String(pickDeviceAt(mdc, seg.x, seg.y)));
    } finally {
      host.devicesEnabled.seg = true;
    }
  });
  it('a device behind the eye is never picked', () => {
    const ghost = screenOf([0, 8, 40]);
    assert.ok(pickDeviceAt(mdc, ghost.x, ghost.y) !== 'behind', String(pickDeviceAt(mdc, ghost.x, ghost.y)));
  });

  // Router: PointerEvent-shaped objects through handle().
  it('the router maps a double-tap to focus ↔ overview', () => {
    const modes = [];
    const input = createTouchInput(controller, canvas, (m) => modes.push(m), () => mdc);
    let t = 0;
    const ev = (type, id, x, y) => input.handle({ type, pointerId: id, clientX: x, clientY: y, pointerType: 'touch', timeStamp: (t += 40) });
    const tap = (x, y) => { ev('pointerdown', 1, x, y); ev('pointerup', 1, x, y); ev('lostpointercapture', 1, x, y); };
    tap(seg.x, seg.y);
    tap(seg.x, seg.y);
    assert.ok(modes.join(',') === 'seg', `double-tap on a device in the overview focuses it — ${modes.join(',')}`);
    host.currentView = 'seg';
    tap(10, 10);
    tap(10, 10);
    assert.ok(modes.join(',') === 'seg,overview', `double-tap in a device view returns to the overview — ${modes.join(',')}`);
    host.currentView = 'overview';
    tap(2, 2);
    tap(2, 2);
    assert.ok(modes.at(-1) === 'overview' && modes.length === 3, `double-tap on empty space re-frames the overview — ${modes.join(',')}`);
  });

  it('a 100 px finger drag orbits exactly like a 100 px mouse drag', () => {
    const ref = new CameraController();
    ref.orbit(100 * 0.01, 0);
    const yawRef = Math.atan2(ref.camera.position[2], ref.camera.position[0]);
    const c2 = new CameraController();
    const drag = createTouchInput(c2, canvas, () => {}, () => null);
    drag.handle({ type: 'pointerdown', pointerId: 5, clientX: 100, clientY: 100, pointerType: 'touch', timeStamp: 0 });
    drag.handle({ type: 'pointermove', pointerId: 5, clientX: 200, clientY: 100, pointerType: 'touch', timeStamp: 16 });
    const yaw = Math.atan2(c2.camera.position[2], c2.camera.position[0]);
    assert.ok(near(yaw, yawRef, 1e-12), `${yaw} vs ${yawRef}`);
  });
  it('without a focus host, double-tap changes no mode', () => {
    const noFocus = [];
    const blind = createTouchInput(new CameraController(), canvas, (m) => noFocus.push(m));
    for (let i = 0; i < 2; i++) {
      blind.handle({ type: 'pointerdown', pointerId: 1, clientX: 5, clientY: 5, pointerType: 'touch', timeStamp: i * 100 });
      blind.handle({ type: 'pointerup', pointerId: 1, clientX: 5, clientY: 5, pointerType: 'touch', timeStamp: i * 100 + 30 });
    }
    assert.ok(noFocus.length === 0, noFocus.join(','));
  });
});

describe('6. structure', () => {
  const src = read('src/camera-controller.ts');
  it('camera input is Pointer Events only', () => {
    assert.ok(!/addEventListener\('(mouse|touch)[a-z]+'/.test(src), 'a mouse or touch listener crept back in');
  });
  it('pointer capture is kept (#221)', () => {
    assert.ok(/setPointerCapture/.test(src) && /lostpointercapture/.test(src), 'setPointerCapture / lostpointercapture missing');
  });
  it('the mouse path still orbits left-drags at ORBIT_RAD_PER_PX', () => {
    assert.ok(/this\.mouseButtons & 1/.test(src) && /this\.orbit\(deltaX \* ORBIT_RAD_PER_PX, deltaY \* ORBIT_RAD_PER_PX\)/.test(src),
      'mouse orbit path changed');
  });
  it('the wheel still zooms by deltaY * 0.001', () => {
    assert.ok(/this\.zoom\(e\.deltaY \* 0\.001\)/.test(src), 'wheel path changed');
  });
  it('touch/pen go to the lazy chunk', () => {
    assert.ok(/pointerType !== 'mouse'/.test(src) && /import\('\.\/camera-touch'\)/.test(src),
      'non-mouse pointers are not routed to camera-touch.ts');
  });
  it('camera-touch is only type-imported by the controller (stays lazy)', () => {
    assert.ok(!/^import \{[^}]*\} from '\.\/camera-touch'/m.test(src), 'a value import would pull camera-touch into the entry');
  });
  it('#gpuCanvas has touch-action: none in CSS', () => {
    const css = read('src/styles/seg-dashboard-layout.css');
    assert.ok(/#gpuCanvas\s*\{[^}]*touch-action:\s*none/.test(css), 'no touch-action rule for #gpuCanvas');
  });
  for (const rel of ['src/visualizer/init-methods.ts', 'src/renderers/webgl2/index.js']) {
    it(`${rel} wires double-tap focus`, () => {
      assert.ok(/setupInteraction\([^;]*\(\) => this\.cameraController\)/.test(read(rel)),
        'setupInteraction is called without the focus getter');
    });
  }
});
