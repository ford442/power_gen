/**
 * lab-url — `#lab=` share links must never inject NaN or out-of-range
 * values, and restored bench parameters must survive the next physics step.
 *
 *   1. decode: non-finite fields (`drive=abc`, `lfield=NaN`) are absent, finite
 *      ones are clamped into LAB_PARAM_RANGES; encode → decode round-trips.
 *   2. apply: `drive=abc` leaves the operator's previous finite drive alone.
 *   3. Halbach: a restored `hseg` pins the catalog `halbachSegments` setpoint —
 *      it survives steps and a drive change (the drive still sets the
 *      magnetisation angle). Releasing it (the slider's Auto) hands N back
 *      to the drive sweep.
 *   4. Halbach: `hlin=1` sets the layout once and stepping does not revert it
 *      (the step no longer re-parses `location.search`).
 *
 * Usage: npm run test:lab-url   (node --test scripts/tests/lab-url.test.mjs)
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { bundleTs } from '../test-harness.mjs';

// lab-url → seg-tour-player pulls in Vite `?raw` shader imports; the harness stubs them.
const ENTRY = `
export { decodeLabHash, encodeLabHash, applyLabState, LAB_PARAM_RANGES } from './src/seg-explainer/lab-url.ts';
export { createHalbachVizPhysicsState, stepHalbachVizPhysics } from './src/devices/quanta/halbach-viz.ts';
export { HALBACH_VIZ } from './generated/physics-constants.ts';
`;

let m;
before(async () => {
  m = await bundleTs({ contents: ENTRY, sourcefile: 'lab-url-entry.ts' });
});

describe('decode', () => {
  const BAD_KEYS = ['drive', 'field', 'bmult', 'halbachSegments', 'pulseCoilCharge', 'lorentzFieldT', 'step'];

  it('non-finite fields decode as absent; valid ones beside them still decode', () => {
    const bad = m.decodeLabHash('#lab=v1;mode=seg;drive=abc;field=;bmult=NaN;hseg=x;pcap=Infinity;lfield=-;step=q');
    for (const k of BAD_KEYS) {
      assert.ok(bad[k] === undefined, `non-finite ${k} must decode as absent (got ${bad[k]})`);
    }
    assert.ok(bad.mode === 'seg', 'valid fields beside bad ones still decode');
  });

  it('finite fields clamp into LAB_PARAM_RANGES', () => {
    const wide = m.decodeLabHash('#lab=v1;drive=7;field=-2;bmult=99;hseg=1000000000;pcap=-1;lfield=50;step=-5');
    const R = m.LAB_PARAM_RANGES;
    assert.ok(wide.drive === R.drive[1], `drive clamps to ${R.drive[1]} (got ${wide.drive})`);
    assert.ok(wide.field === R.field[0], `field clamps to ${R.field[0]} (got ${wide.field})`);
    assert.ok(wide.bmult === R.bmult[1], `bmult clamps to ${R.bmult[1]} (got ${wide.bmult})`);
    assert.ok(wide.halbachSegments === m.HALBACH_VIZ.segmentMax, `hseg clamps to segmentMax (got ${wide.halbachSegments})`);
    assert.ok(wide.pulseCoilCharge === 0, `pcap clamps to 0 (got ${wide.pulseCoilCharge})`);
    assert.ok(wide.lorentzFieldT === R.lorentzFieldT[1], `lfield clamps to fieldTMax (got ${wide.lorentzFieldT})`);
    assert.ok(wide.step === 0, `step clamps to 0 (got ${wide.step})`);
  });

  it('exponent notation reaches the clamp; non-integers decode as absent', () => {
    // parseInt('1e9') is 1 — the whole value must reach the clamp.
    const R = m.LAB_PARAM_RANGES;
    const exp = m.decodeLabHash('#lab=v1;hseg=1e9;step=2e3');
    assert.ok(exp.halbachSegments === m.HALBACH_VIZ.segmentMax, `hseg=1e9 clamps to segmentMax (got ${exp.halbachSegments})`);
    assert.ok(exp.step === R.step[1], `step=2e3 clamps to ${R.step[1]} (got ${exp.step})`);
    const frac = m.decodeLabHash('#lab=v1;hseg=4.5;step=1.5');
    assert.ok(frac.halbachSegments === undefined && frac.step === undefined, 'non-integer hseg/step decode as absent');
  });

  it('encode → decode round-trips, ring layout included', () => {
    const opts = { mode: 'halbach-viz', drive: 0.25, field: 0.75, bmult: 1.5, halbachSegments: 12, halbachLinear: true, step: 3 };
    const round = m.decodeLabHash(m.encodeLabHash(opts));
    for (const [k, v] of Object.entries(opts)) {
      assert.ok(round[k] === v, `round-trip ${k}: expected ${v}, got ${round[k]}`);
    }
    const ring = m.decodeLabHash(m.encodeLabHash({ mode: 'halbach-viz', halbachLinear: false }));
    assert.ok(ring.halbachLinear === false, `a ring layout is encoded too (got ${ring.halbachLinear})`);
  });
});

// Sequential: these share one stub dashboard and one Halbach bench.
describe('apply against a stub dashboard', () => {
  let halbach, operator;
  before(() => {
    halbach = m.createHalbachVizPhysicsState();
    operator = { targetDrive: 0.37 };
    globalThis.window = {
      segOperator: operator,
      multiVisualizer: { devices: { 'halbach-viz': { physicsState: halbach } } },
      setMode() {},
      location: { search: '' },
    };
    globalThis.document = { getElementById: () => null };
  });

  it('drive=abc keeps the previous finite drive', async () => {
    await m.applyLabState(m.decodeLabHash('#lab=v1;mode=seg;drive=abc'));
    assert.ok(operator.targetDrive === 0.37, `drive=abc must keep the previous drive (got ${operator.targetDrive})`);
    assert.ok(Number.isFinite(operator.targetDrive), 'drive stays finite');
  });

  it('a restored hseg pins N across steps and drive changes; releasing hands it back', async () => {
    const drive = 0.5;
    const fromDrive = m.HALBACH_VIZ.segmentMin + Math.round(drive * m.HALBACH_VIZ.segmentSpan);
    const restored = fromDrive === 20 ? 10 : 20;
    await m.applyLabState(m.decodeLabHash(`#lab=v1;mode=halbach-viz;hseg=${restored}`));
    for (let i = 0; i < 5; i++) m.stepHalbachVizPhysics(halbach, 1 / 60, drive);
    assert.ok(halbach.halbachSegmentCount === restored,
      `restored hseg must survive steps at the same drive (got ${halbach.halbachSegmentCount}, want ${restored})`);

    m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
    assert.ok(halbach.halbachSegmentCount === restored,
      `a pinned N survives a drive change (got ${halbach.halbachSegmentCount}, want ${restored})`);
    assert.ok(halbach.halbachSegmentSetpoint === restored, 'setpoint stays pinned when the drive moves');

    halbach.halbachSegmentSetpoint = null; // the slider's Auto button
    m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
    const moved = m.HALBACH_VIZ.segmentMin + Math.round(0.6 * m.HALBACH_VIZ.segmentSpan);
    assert.ok(halbach.halbachSegmentCount === moved,
      `releasing the setpoint hands N back to the drive (got ${halbach.halbachSegmentCount}, want ${moved})`);
  });

  it('hlin=1 sticks across steps and hlin=0 returns to ring', async () => {
    assert.ok(halbach.halbachLayout === 'ring', 'default layout is ring');
    const ringLines = JSON.stringify(halbach.halbachFieldLines);
    await m.applyLabState(m.decodeLabHash('#lab=v1;mode=halbach-viz;hlin=1'));
    for (let i = 0; i < 3; i++) m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
    assert.ok(halbach.halbachLayout === 'linear', `hlin=1 must stick across steps (got ${halbach.halbachLayout})`);
    assert.ok(Array.isArray(halbach.halbachFieldLines) || halbach.halbachFieldLines != null,
      'linear layout rebuilds the field lines');
    assert.ok(JSON.stringify(halbach.halbachFieldLines) !== ringLines, 'linear field lines differ from the ring ones');

    await m.applyLabState(m.decodeLabHash('#lab=v1;mode=halbach-viz;hlin=0'));
    for (let i = 0; i < 3; i++) m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
    assert.ok(halbach.halbachLayout === 'ring', `hlin=0 returns a linear recipient to ring (got ${halbach.halbachLayout})`);
  });
});
