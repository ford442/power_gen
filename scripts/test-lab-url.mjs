#!/usr/bin/env node
/**
 * test-lab-url.mjs — `#lab=` share links must never inject NaN or out-of-range
 * values, and restored bench parameters must survive the next physics step.
 *
 *   1. decode: non-finite fields (`drive=abc`, `lfield=NaN`) are absent, finite
 *      ones are clamped into LAB_PARAM_RANGES; encode → decode round-trips.
 *   2. apply: `drive=abc` leaves the operator's previous finite drive alone.
 *   3. Halbach: a restored `hseg` is a catalog setpoint — stepping keeps it
 *      even when the drive moves (the drive still sets the magnetisation
 *      angle). Releasing the pin (null) hands N back to the drive sweep.
 *   4. Halbach: `hlin=1` sets the layout once and stepping does not revert it
 *      (the step no longer re-parses `location.search`).
 *
 * Usage: node scripts/test-lab-url.mjs   (exit 1 on failure)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}

const ENTRY = `
export { decodeLabHash, encodeLabHash, applyLabState, LAB_PARAM_RANGES } from './src/seg-explainer/lab-url.ts';
export { createHalbachVizPhysicsState, stepHalbachVizPhysics } from './src/devices/quanta/halbach-viz.ts';
export { HALBACH_VIZ } from './generated/physics-constants.ts';
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'lab-url-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  // lab-url → seg-tour-player pulls in Vite `?raw` shader imports; unused here.
  plugins: [{
    name: 'raw-stub',
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: a.path, namespace: 'raw-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
    },
  }],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

// ── 1. decode ────────────────────────────────────────────────────────────
{
  const bad = m.decodeLabHash('#lab=v1;mode=seg;drive=abc;field=;bmult=NaN;hseg=x;pcap=Infinity;lfield=-;step=q');
  for (const k of ['drive', 'field', 'bmult', 'halbachSegments', 'pulseCoilCharge', 'lorentzFieldT', 'step']) {
    check(bad[k] === undefined, `non-finite ${k} must decode as absent (got ${bad[k]})`);
  }
  check(bad.mode === 'seg', 'valid fields beside bad ones still decode');

  const wide = m.decodeLabHash('#lab=v1;drive=7;field=-2;bmult=99;hseg=1000000000;pcap=-1;lfield=50;step=-5');
  const R = m.LAB_PARAM_RANGES;
  check(wide.drive === R.drive[1], `drive clamps to ${R.drive[1]} (got ${wide.drive})`);
  check(wide.field === R.field[0], `field clamps to ${R.field[0]} (got ${wide.field})`);
  check(wide.bmult === R.bmult[1], `bmult clamps to ${R.bmult[1]} (got ${wide.bmult})`);
  check(wide.halbachSegments === m.HALBACH_VIZ.segmentMax, `hseg clamps to segmentMax (got ${wide.halbachSegments})`);
  check(wide.pulseCoilCharge === 0, `pcap clamps to 0 (got ${wide.pulseCoilCharge})`);
  check(wide.lorentzFieldT === R.lorentzFieldT[1], `lfield clamps to fieldTMax (got ${wide.lorentzFieldT})`);
  check(wide.step === 0, `step clamps to 0 (got ${wide.step})`);

  // parseInt('1e9') is 1 — the whole value must reach the clamp.
  const exp = m.decodeLabHash('#lab=v1;hseg=1e9;step=2e3');
  check(exp.halbachSegments === m.HALBACH_VIZ.segmentMax, `hseg=1e9 clamps to segmentMax (got ${exp.halbachSegments})`);
  check(exp.step === R.step[1], `step=2e3 clamps to ${R.step[1]} (got ${exp.step})`);
  const frac = m.decodeLabHash('#lab=v1;hseg=4.5;step=1.5');
  check(frac.halbachSegments === undefined && frac.step === undefined, 'non-integer hseg/step decode as absent');

  const opts = { mode: 'halbach-viz', drive: 0.25, field: 0.75, bmult: 1.5, halbachSegments: 12, halbachLinear: true, step: 3 };
  const round = m.decodeLabHash(m.encodeLabHash(opts));
  for (const [k, v] of Object.entries(opts)) {
    check(round[k] === v, `round-trip ${k}: expected ${v}, got ${round[k]}`);
  }
  const ring = m.decodeLabHash(m.encodeLabHash({ mode: 'halbach-viz', halbachLinear: false }));
  check(ring.halbachLinear === false, `a ring layout is encoded too (got ${ring.halbachLinear})`);
}

// ── 2–4. apply against a stub dashboard ──────────────────────────────────
const halbach = m.createHalbachVizPhysicsState();
const operator = { targetDrive: 0.37 };
globalThis.window = {
  segOperator: operator,
  multiVisualizer: { devices: { 'halbach-viz': { physicsState: halbach } } },
  setMode() {},
  location: { search: '' },
};
globalThis.document = { getElementById: () => null };

{
  await m.applyLabState(m.decodeLabHash('#lab=v1;mode=seg;drive=abc'));
  check(operator.targetDrive === 0.37, `drive=abc must keep the previous drive (got ${operator.targetDrive})`);
  check(Number.isFinite(operator.targetDrive), 'drive stays finite');
}

{
  const drive = 0.5;
  const fromDrive = m.HALBACH_VIZ.segmentMin + Math.round(drive * m.HALBACH_VIZ.segmentSpan);
  const restored = fromDrive === 20 ? 10 : 20;
  await m.applyLabState(m.decodeLabHash(`#lab=v1;mode=halbach-viz;hseg=${restored}`));
  for (let i = 0; i < 5; i++) m.stepHalbachVizPhysics(halbach, 1 / 60, drive);
  check(halbach.halbachSegmentCount === restored,
    `restored hseg must survive steps at the same drive (got ${halbach.halbachSegmentCount}, want ${restored})`);

  m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
  check(halbach.halbachSegmentCount === restored,
    `pinned hseg stays when the drive moves (got ${halbach.halbachSegmentCount}, want ${restored})`);
  check(halbach.halbachSegmentSetpoint === restored, 'setpoint stays pinned when the drive moves');

  halbach.halbachSegmentSetpoint = null;
  m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
  const moved = m.HALBACH_VIZ.segmentMin + Math.round(0.6 * m.HALBACH_VIZ.segmentSpan);
  check(halbach.halbachSegmentCount === moved,
    `releasing the pin hands N back to the drive (got ${halbach.halbachSegmentCount}, want ${moved})`);
}

{
  check(halbach.halbachLayout === 'ring', 'default layout is ring');
  const ringLines = JSON.stringify(halbach.halbachFieldLines);
  await m.applyLabState(m.decodeLabHash('#lab=v1;mode=halbach-viz;hlin=1'));
  for (let i = 0; i < 3; i++) m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
  check(halbach.halbachLayout === 'linear', `hlin=1 must stick across steps (got ${halbach.halbachLayout})`);
  check(Array.isArray(halbach.halbachFieldLines) || halbach.halbachFieldLines != null,
    'linear layout rebuilds the field lines');
  check(JSON.stringify(halbach.halbachFieldLines) !== ringLines, 'linear field lines differ from the ring ones');

  await m.applyLabState(m.decodeLabHash('#lab=v1;mode=halbach-viz;hlin=0'));
  for (let i = 0; i < 3; i++) m.stepHalbachVizPhysics(halbach, 1 / 60, 0.6);
  check(halbach.halbachLayout === 'ring', `hlin=0 returns a linear recipient to ring (got ${halbach.halbachLayout})`);
}

if (failures.length) {
  console.error(`test-lab-url: ${failures.length}/${checks} checks failed`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`test-lab-url: ${checks} checks passed`);
