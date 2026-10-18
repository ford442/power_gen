#!/usr/bin/env node
/**
 * test-lab-mode.mjs — contracts for the Showroom / Lab / Twin switch, the
 * catalog setpoint sliders and the focus live region.
 *
 * The parts that can go wrong without a browser are all arithmetic and
 * precedence, so they are checked here; the DOM side is pinned by e2e.
 *
 *   1. Presets: every mode states every field (switching must restore chrome the
 *      previous mode hid), and the three modes differ where ADR-0005 says so.
 *   2. Precedence: an explicit flag beats the bundle (look, audio, class, each
 *      bus separately); an explicit-on bus or classroom keeps its controls on
 *      screen; a hand-set look never gets overwritten.
 *   3. Resolution: `?labMode=` beats the remembered mode; junk is ignored.
 *   4. Setpoints: catalog rows validate, their ranges match the plant constants
 *      they stand in for, writes clamp, `api` is preferred over `stateKey`, and
 *      a releasable setpoint returns control to the plant.
 *   5. Plants: a pinned Halbach N / pulse-coil target is honoured, an unset one
 *      changes nothing, and the drive still decides what it always decided.

 *   6. Live region: one sentence, mode + one number, never NaN.
 *   7. Structure: no UI framework and no new runtime dependency.
 *
 * Usage: node scripts/test-lab-mode.mjs   (exit 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

async function importTsBundle(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    plugins: [viteRawStub]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

const lm = await importTsBundle('src/lab-mode.ts');
const MODES = lm.LAB_MODES;

// ── 1. Presets ─────────────────────────────────────────────────────────────
{
  check('exactly showroom | lab | twin', JSON.stringify(MODES) === '["showroom","lab","twin"]', JSON.stringify(MODES));
  const keys = Object.keys(lm.LAB_MODE_PRESETS.showroom).sort().join();
  for (const m of MODES) {
    const p = lm.LAB_MODE_PRESETS[m];
    check(`${m} states every preset field`, Object.keys(p).sort().join() === keys, Object.keys(p).join());
    check(`${m} has a label and blurb`, !!p.label && !!p.blurb, JSON.stringify(p));
  }
  const s = lm.LAB_MODE_PRESETS.showroom;
  const l = lm.LAB_MODE_PRESETS.lab;
  const t = lm.LAB_MODE_PRESETS.twin;
  check('showroom: studio look, no explainer, couplings off, twin folded, post held',
    s.look === 'studio' && !s.explainer && s.couplingOff && s.twinPanelCollapsed && s.postFloor === 'high'
      && !s.couplingControls && s.classroomOff && s.muteAudio, JSON.stringify(s));
  check('lab: lab look, explainer + coupling controls visible, couplings not forced off',
    l.look === 'lab' && l.explainer && l.couplingControls && !l.couplingOff && !l.muteAudio, JSON.stringify(l));
  check('twin: panel open, residual gauges on, coast on leave, hardware not auto-forced',
    !t.twinPanelCollapsed && t.residualGauges && t.coastOnLeave && t.look === null, JSON.stringify(t));
  check('only twin opens the residual gauges / coasts on leave',
    !s.residualGauges && !l.residualGauges && !s.coastOnLeave && !l.coastOnLeave, 'leaks into showroom/lab');
  check('only showroom holds the post stack', l.postFloor === null && t.postFloor === null, 'floor leaks');
}

// ── 2. Precedence ──────────────────────────────────────────────────────────
{
  const plain = lm.planLabMode('showroom', {});
  check('showroom plan with no overrides applies the whole bundle',
    plain.look === 'studio' && plain.muteAudio && plain.forceOff.fieldCoupling && plain.forceOff.chargeCoupling
      && plain.forceOff.energyCoupling && !plain.showExplainer && !plain.showCouplingControls && plain.classroomOff,
    JSON.stringify(plain));

  const drama = lm.planLabMode('showroom', { look: 'drama' });
  check('?look=drama beats the showroom look', drama.look === null, String(drama.look));
  check('an invalid ?look= does not suppress the preset look',
    lm.planLabMode('showroom', { look: 'neon' }).look === 'studio', 'invalid look swallowed the preset');

  check('?audio=1 keeps showroom from muting', lm.planLabMode('showroom', { audio: '1' }).muteAudio === false, 'muted anyway');
  check('showroom without ?audio mutes (it never starts audio)', plain.muteAudio === true, 'not muted');

  const fieldOn = lm.planLabMode('showroom', { fieldCoupling: '1' });
  check('?fieldCoupling=1 is not forced off by showroom, the other buses still are',
    !fieldOn.forceOff.fieldCoupling && fieldOn.forceOff.chargeCoupling && fieldOn.forceOff.energyCoupling,
    JSON.stringify(fieldOn.forceOff));
  check('an explicit-on bus keeps its controls on screen in showroom',
    fieldOn.showCouplingControls === true, 'live bus with hidden switch');
  const fieldOff = lm.planLabMode('showroom', { fieldCoupling: '0' });
  check('an explicit-off bus is left alone and does not reveal the controls',
    !fieldOff.forceOff.fieldCoupling && fieldOff.showCouplingControls === false, JSON.stringify(fieldOff));

  const cls = lm.planLabMode('showroom', { classroom: '1' });
  check('?class=1 keeps classroom on and the explainer visible in showroom',
    !cls.classroomOff && cls.showExplainer === true, JSON.stringify(cls));
  check('?class=0 does not reveal the explainer', lm.planLabMode('showroom', { classroom: '0' }).showExplainer === false, 'revealed');

  for (const m of ['lab', 'twin']) {
    const p = lm.planLabMode(m, {});
    check(`${m} forces nothing off and mutes nothing`,
      !p.forceOff.fieldCoupling && !p.forceOff.chargeCoupling && !p.forceOff.energyCoupling && !p.muteAudio && !p.classroomOff,
      JSON.stringify(p));
    check(`${m} shows explainer and coupling controls`, p.showExplainer && p.showCouplingControls, JSON.stringify(p));
  }
  check('twin leaves the look alone', lm.planLabMode('twin', {}).look === null, 'twin set a look');
}

// ── 3. Resolution ──────────────────────────────────────────────────────────
{
  check('?labMode= wins over the remembered mode', lm.resolveBootLabMode('?labMode=twin', 'lab') === 'twin', 'url lost');
  check('remembered mode applies with no param', lm.resolveBootLabMode('', 'showroom') === 'showroom', 'stored lost');
  check('no param and nothing stored → no mode', lm.resolveBootLabMode('?renderer=webgl2', null) === null, 'invented a mode');
  check('junk ?labMode= falls back to the remembered mode', lm.resolveBootLabMode('?labMode=disco', 'lab') === 'lab', 'junk accepted');
  check('junk everywhere → no mode', lm.resolveBootLabMode('?labMode=disco', 'disco') === null, 'junk accepted');
  check('mode names are case-sensitive and exact', lm.resolveBootLabMode('?labMode=Lab', null) === null, 'Lab accepted');

  const o = lm.readLabModeOverrides('?look=drama&audio=1&class=1&fieldCoupling=0&chargeCoupling=1&renderer=webgl2');
  check('overrides read look/audio/class/buses and nothing else',
    o.look === 'drama' && o.audio === '1' && o.classroom === '1' && o.fieldCoupling === '0'
      && o.chargeCoupling === '1' && o.energyCoupling === undefined && !('renderer' in o), JSON.stringify(o));
  check('?lighting= is the same override as ?look=', lm.readLabModeOverrides('?lighting=lab').look === 'lab', 'alias lost');
  check('a #lab= share link with class=1 is an explicit classroom',
    lm.readLabModeOverrides('', '#lab=v1;mode=seg;class=1;tour=1').classroom === '1', 'hash class lost');
  check('a #lab= link without class=1 is not', lm.readLabModeOverrides('', '#lab=v1;mode=seg').classroom === undefined, 'hash class invented');
  check('storage key is seg-lab-mode', lm.LAB_MODE_STORAGE_KEY === 'seg-lab-mode', lm.LAB_MODE_STORAGE_KEY);
}

// ── 4. Setpoints (catalog) ────────────────────────────────────────────────
const sp = await importTsBundle('src/setpoint-sliders.ts');
const cat = JSON.parse(read('physics/devices.json'));
const consts = JSON.parse(read('physics/constants.json'));
{
  const rows = [];
  for (const d of cat.devices) for (const s of d.setpoints || []) rows.push({ ...s, deviceId: d.id });
  const ids = rows.map((r) => r.id);
  check('catalog declares the Lorentz, Halbach and pulse-coil setpoints',
    ['lorentzField', 'halbachSegments', 'pulseCoilCharge'].every((i) => ids.includes(i)), ids.join());
  check('setpoint ids are unique', new Set(ids).size === ids.length, ids.join());
  check('generated DEVICE_SETPOINTS matches the catalog row for row',
    sp.setpointsForDevice('lorentz-sled').length === 1 && sp.setpointById('halbachSegments')?.deviceId === 'halbach-viz'
      && sp.setpointById('pulseCoilCharge')?.max === 48, 'codegen stale?');
  for (const r of rows) {
    check(`${r.id}: min < max, 0 < step <= span`, r.min < r.max && r.step > 0 && r.step <= r.max - r.min, JSON.stringify(r));
  }

  // The slider range stands in for the plant's own clamp — it must not drift.
  const lor = sp.setpointById('lorentzField');
  check('Lorentz slider max == plant fieldTMax', lor.max === consts.lorentzSled?.fieldTMax || lor.max === findKey(consts, 'fieldTMax'),
    `${lor.max} vs ${findKey(consts, 'fieldTMax')}`);
  const hal = sp.setpointById('halbachSegments');
  check('Halbach slider range == plant segmentMin..segmentMax',
    hal.min === findKey(consts, 'segmentMin') && hal.max === findKey(consts, 'segmentMax'),
    `${hal.min}..${hal.max} vs ${findKey(consts, 'segmentMin')}..${findKey(consts, 'segmentMax')}`);
  const pc = sp.setpointById('pulseCoilCharge');
  check('pulse-coil slider max == vChargeMax', pc.max === findKey(consts, 'vChargeMax'), `${pc.max} vs ${findKey(consts, 'vChargeMax')}`);

  // Write semantics against a fake window.
  const calls = [];
  const phys = { lorentzFieldLocalT: 0.8, halbachSegmentSetpoint: null, halbachSegmentCount: 9, pulseCoilChargeSetpointV: null, pulseCoilVCap: 5 };
  const win = {
    multiVisualizer: { devices: { 'lorentz-sled': { physicsState: phys }, 'halbach-viz': { physicsState: phys }, 'pulse-coil': { physics: phys } } },
    setLorentzFieldT: (v) => calls.push(v)
  };
  check('api setpoint calls the window API, not the state key',
    sp.applySetpoint(lor, 0.5, win) && calls.join() === '0.5' && phys.lorentzFieldLocalT === 0.8, `${calls} ${phys.lorentzFieldLocalT}`);
  sp.applySetpoint(lor, 99, win);
  check('api write is clamped to the catalog range', calls[1] === lor.max, String(calls[1]));
  sp.applySetpoint(lor, Number.NaN, win);
  check('NaN clamps to min rather than reaching the plant', calls[2] === lor.min, String(calls[2]));
  check('stateKey setpoint writes physicsState', sp.applySetpoint(hal, 13, win) && phys.halbachSegmentSetpoint === 13, String(phys.halbachSegmentSetpoint));
  check('reads back the pinned value', sp.readSetpoint(hal, win) === 13, String(sp.readSetpoint(hal, win)));
  check('stateKey write clamps', (sp.applySetpoint(hal, 500, win), phys.halbachSegmentSetpoint === hal.max), String(phys.halbachSegmentSetpoint));
  check('releasing hands control back (null)', sp.applySetpoint(hal, null, win) && phys.halbachSegmentSetpoint === null, String(phys.halbachSegmentSetpoint));
  check('unset setpoint displays the live plant value', sp.displaySetpoint(hal, win) === 9, String(sp.displaySetpoint(hal, win)));
  check('a non-releasable setpoint refuses to be released', sp.applySetpoint(lor, null, win) === false, 'released Lorentz');
  check('writing before the bench exists is a no-op, not a throw', sp.applySetpoint(hal, 8, { multiVisualizer: { devices: {} } }) === false, 'wrote');
  check('writing with no visualizer is a no-op', sp.applySetpoint(hal, 8, {}) === false, 'wrote');
}

function findKey(obj, key) {
  if (obj && typeof obj === 'object') {
    if (key in obj && typeof obj[key] === 'number') return obj[key];
    for (const v of Object.values(obj)) {
      const r = findKey(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

// ── 5. Plants honour the setpoints ─────────────────────────────────────────
{
  const hv = await importTsBundle('src/devices/quanta/halbach-viz.ts');
  const pcm = await importTsBundle('src/devices/quanta/pulse-coil.ts');
  const stepHalbach = hv.stepHalbachVizPhysics;
  const stepPulse = pcm.stepPulseCoilPhysics;

  const free = {};
  stepHalbach(free, 0.016, 0.5);
  const sweptN = free.halbachSegmentCount;
  check('Halbach unset: drive sweeps N (4 + round(0.5×20) = 14)', sweptN === 14, String(sweptN));

  const pinned = { halbachSegmentSetpoint: 6 };
  stepHalbach(pinned, 0.016, 0.5);
  check('Halbach pinned: N follows the setpoint, not the drive', pinned.halbachSegmentCount === 6, String(pinned.halbachSegmentCount));
  check('Halbach pinned: the magnetisation angle still follows the drive',
    Math.abs(pinned.halbachMagAngleDeg - (360 / 6) * (hv.HALBACH_VIZ.magAngleBase + 0.5 * hv.HALBACH_VIZ.magAngleSpan)) < 1e-9,
    String(pinned.halbachMagAngleDeg));
  const sliderPinned = { halbachSegmentSetpoint: 6, halbachSegmentSetpointSource: 'slider' };
  stepHalbach(sliderPinned, 0.016, 0.8);
  check('Halbach slider pin survives drive changes', sliderPinned.halbachSegmentCount === 6, String(sliderPinned.halbachSegmentCount));
  const wild = { halbachSegmentSetpoint: 1e9 };
  stepHalbach(wild, 0.016, 0);
  check('Halbach pinned: out-of-range clamps to segmentMax', wild.halbachSegmentCount === hv.HALBACH_VIZ.segmentMax, String(wild.halbachSegmentCount));
  const nan = { halbachSegmentSetpoint: Number.NaN };
  stepHalbach(nan, 0.016, 0.5);
  check('Halbach NaN setpoint falls back to the drive sweep', nan.halbachSegmentCount === sweptN, String(nan.halbachSegmentCount));
  const nul = { halbachSegmentSetpoint: null };
  stepHalbach(nul, 0.016, 0.5);
  check('Halbach null setpoint (released) falls back to the drive sweep', nul.halbachSegmentCount === sweptN, String(nul.halbachSegmentCount));

  const vmax = pcm.PULSE_COIL.vChargeMax;
  const settle = (state, drive, steps = 3000) => {
    for (let i = 0; i < steps; i++) stepPulse(state, 0.001, drive);
    return state;
  };
  // Idle charging only: drive below the auto-fire threshold so the bank never discharges.
  const noSet = settle({ pulseCoilVCap: 0 }, 0.05);
  check('pulse-coil unset: bank charges toward drive × V_max', Math.abs(noSet.pulseCoilVCap - 0.05 * vmax) < 0.15 * vmax * 0.05 + 0.3,
    `${noSet.pulseCoilVCap} vs ${0.05 * vmax}`);
  const set24 = settle({ pulseCoilVCap: 0, pulseCoilChargeSetpointV: 24 }, 0.05);
  check('pulse-coil pinned: bank charges toward the setpoint, not drive × V_max',
    set24.pulseCoilVCap > 0.05 * vmax + 5 && set24.pulseCoilVCap <= 24 + 1e-6, `${set24.pulseCoilVCap}`);
  const over = settle({ pulseCoilVCap: 0, pulseCoilChargeSetpointV: 1e6 }, 0.05);
  check('pulse-coil pinned: target is clamped to vChargeMax', over.pulseCoilVCap <= vmax + 1e-6, `${over.pulseCoilVCap}`);
  const zero = settle({ pulseCoilVCap: 30, pulseCoilChargeSetpointV: 0 }, 0.05);
  check('pulse-coil pinned at 0 V drains the bank to 0 rather than falling back to drive',
    zero.pulseCoilVCap < 1, `${zero.pulseCoilVCap}`);
  const nanPc = settle({ pulseCoilVCap: 0, pulseCoilChargeSetpointV: Number.NaN }, 0.05);
  check('pulse-coil NaN setpoint falls back to drive × V_max', Math.abs(nanPc.pulseCoilVCap - noSet.pulseCoilVCap) < 1e-9, `${nanPc.pulseCoilVCap}`);
}

// ── 6. Live region ─────────────────────────────────────────────────────────
{
  const lr = await importTsBundle('src/focus-live-region.ts');
  const snapPulse = { view: 'pulse-coil', seg: null, devices: { 'pulse-coil': { id: 'pulse-coil', pulseCoilCurrentA: 12.4 } } };
  const a = lr.announcementFor(snapPulse, 'lab');
  check('announces lab mode + bench + one catalog number', /^Lab mode\. Pulse Coil.*, I 12\.40 A$/.test(a), a);
  check('no lab mode → no mode prefix', !/mode/.test(lr.announcementFor(snapPulse, null)), lr.announcementFor(snapPulse, null));
  check('an unknown mode string is not announced', !/mode/.test(lr.announcementFor(snapPulse, 'disco')), lr.announcementFor(snapPulse, 'disco'));
  const nanSnap = { view: 'pulse-coil', seg: null, devices: { 'pulse-coil': { id: 'pulse-coil', pulseCoilCurrentA: Number.NaN } } };
  check('a NaN reading is "—", never "NaN"', !/NaN/.test(lr.announcementFor(nanSnap, 'twin')) && /—/.test(lr.announcementFor(nanSnap, 'twin')),
    lr.announcementFor(nanSnap, 'twin'));
  check('overview announces just "Overview"', lr.headlineFor({ view: 'overview', seg: null, devices: {} }) === 'Overview', 'overview');
  check('SEG announces inner-ring RPM', lr.headlineFor({ view: 'seg', seg: { rpmDisplay: 1234.6 }, devices: {} }) === 'SEG, inner ring 1235 RPM',
    lr.headlineFor({ view: 'seg', seg: { rpmDisplay: 1234.6 }, devices: {} }));
  check('SEG with no plant yet still announces a name', lr.headlineFor({ view: 'seg', seg: null, devices: {} }) === 'SEG', 'seg null');
  check('a bench with no snapshot yet still announces its name',
    lr.headlineFor({ view: 'pulse-coil', seg: null, devices: {} }) === 'Pulse Coil (R–L)', lr.headlineFor({ view: 'pulse-coil', seg: null, devices: {} }));
}

// ── 7. Structure ───────────────────────────────────────────────────────────
{
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys(pkg.dependencies || {});
  check('no UI framework in runtime dependencies', !deps.some((d) => /^(react|vue|lit|svelte|preact|solid-js)/.test(d)), deps.join());
  check('no i18n package in runtime dependencies', !deps.some((d) => /i18n|intl/.test(d)), deps.join());
  const idx = read('src/index.html');
  check('index.html carries only the header host + setpoint host, no per-device slider markup',
    idx.includes('id="lab-mode-switch"') && idx.includes('id="device-setpoints"') && !idx.includes('id="lorentzFieldSlider"')
      && !idx.includes('id="halbachSegmentsSlider"') && !idx.includes('id="pulseCoilChargeSlider"'), 'hand-wired slider crept back');
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[lab-mode] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[lab-mode] ${ok.length} checks passed`);
