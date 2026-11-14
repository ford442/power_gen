/**
 * lab-mode — contracts for the Showroom / Lab / Twin switch, the catalog
 * setpoint sliders and the focus live region.
 *
 * The parts that can go wrong without a browser are all arithmetic and
 * precedence, so they are checked here; the DOM side is pinned by e2e.
 *
 *   1. Presets: every mode states every field (switching must restore chrome the
 *      previous mode hid), and the three modes differ where ADR-0005 says so.
 *   2. Precedence: an explicit flag beats the bundle (look, audio, class, each
 *      bus separately); an explicit-on bus or classroom keeps its controls on
 *      screen; a hand-set look never gets overwritten.
 *   3. Resolution: `?labMode=` beats the remembered mode; junk is ignored;
 *      values go through the one LabConfig parser (src/config/lab-config.ts).
 *   4. Setpoints: catalog rows validate, their ranges match the plant constants
 *      they stand in for, writes clamp, `api` is preferred over `stateKey`, and
 *      a releasable setpoint returns control to the plant.
 *   5. Plants: a pinned Halbach N / pulse-coil target / drop-tube σ is honoured,
 *      an unset one changes nothing, and the drive still decides what it always
 *      decided.
 *   6. Live region: one sentence, mode + one number, never NaN.
 *   7. Structure: no UI framework and no new runtime dependency.
 *
 * Usage: npm run test:lab-mode   (node --test scripts/tests/lab-mode.test.mjs)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

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

let lm, shareUrl;
/** A share hash as boot sees it: decoded (both codecs are a lazy chunk). */
const hashFields = (h) => shareUrl.decodeHashFields(h);
before(async () => {
  lm = await bundleTs('src/lab-mode.ts');
  shareUrl = await bundleTs('src/config/share-url.ts');
});

describe('presets', () => {
  // LAB_MODES is checked below; the loop needs the names at collection time.
  const MODES = ['showroom', 'lab', 'twin'];

  it('exactly showroom | lab | twin', () => {
    assert.ok(JSON.stringify(lm.LAB_MODES) === '["showroom","lab","twin"]', JSON.stringify(lm.LAB_MODES));
  });

  for (const m of MODES) {
    it(`${m} states every preset field`, () => {
      const keys = Object.keys(lm.LAB_MODE_PRESETS.showroom).sort().join();
      const p = lm.LAB_MODE_PRESETS[m];
      assert.ok(Object.keys(p).sort().join() === keys, Object.keys(p).join());
    });
    it(`${m} has a label and blurb`, () => {
      const p = lm.LAB_MODE_PRESETS[m];
      assert.ok(!!p.label && !!p.blurb, JSON.stringify(p));
    });
  }

  it('showroom: studio look, no explainer, couplings off, twin folded, post held', () => {
    const s = lm.LAB_MODE_PRESETS.showroom;
    assert.ok(s.look === 'studio' && !s.explainer && s.couplingOff && s.twinPanelCollapsed && s.postFloor === 'high'
      && !s.couplingControls && s.classroomOff && s.muteAudio, JSON.stringify(s));
  });
  it('lab: lab look, explainer + coupling controls visible, couplings not forced off', () => {
    const l = lm.LAB_MODE_PRESETS.lab;
    assert.ok(l.look === 'lab' && l.explainer && l.couplingControls && !l.couplingOff && !l.muteAudio, JSON.stringify(l));
  });
  it('twin: panel open, residual gauges on, coast on leave, hardware not auto-forced', () => {
    const t = lm.LAB_MODE_PRESETS.twin;
    assert.ok(!t.twinPanelCollapsed && t.residualGauges && t.coastOnLeave && t.look === null, JSON.stringify(t));
  });
  it('only twin opens the residual gauges / coasts on leave', () => {
    const { showroom: s, lab: l } = lm.LAB_MODE_PRESETS;
    assert.ok(!s.residualGauges && !l.residualGauges && !s.coastOnLeave && !l.coastOnLeave, 'leaks into showroom/lab');
  });
  it('only showroom holds the post stack', () => {
    const { lab: l, twin: t } = lm.LAB_MODE_PRESETS;
    assert.ok(l.postFloor === null && t.postFloor === null, 'floor leaks');
  });
});

describe('precedence', () => {
  let plain;
  before(() => { plain = lm.planLabMode('showroom', {}); });

  it('showroom plan with no overrides applies the whole bundle', () => {
    assert.ok(plain.look === 'studio' && plain.muteAudio && plain.forceOff.fieldCoupling && plain.forceOff.chargeCoupling
      && plain.forceOff.energyCoupling && !plain.showExplainer && !plain.showCouplingControls && plain.classroomOff,
    JSON.stringify(plain));
  });

  it('?look=drama beats the showroom look', () => {
    const drama = lm.planLabMode('showroom', { look: 'drama' });
    assert.ok(drama.look === null, String(drama.look));
  });
  it('an invalid ?look= does not suppress the preset look', () => {
    // Overrides are parsed LabConfig values: an unknown look never becomes one.
    assert.ok(lm.planLabMode('showroom', lm.readLabModeOverrides('?look=neon')).look === 'studio', 'invalid look swallowed the preset');
  });

  it('?audio=1 keeps showroom from muting', () => {
    assert.ok(lm.planLabMode('showroom', { audio: true }).muteAudio === false, 'muted anyway');
  });
  it('showroom without ?audio mutes (it never starts audio)', () => {
    assert.ok(plain.muteAudio === true, 'not muted');
  });

  it('?fieldCoupling=1 is not forced off by showroom, the other buses still are', () => {
    const fieldOn = lm.planLabMode('showroom', { fieldCoupling: true });
    assert.ok(!fieldOn.forceOff.fieldCoupling && fieldOn.forceOff.chargeCoupling && fieldOn.forceOff.energyCoupling,
      JSON.stringify(fieldOn.forceOff));
  });
  it('an explicit-on bus keeps its controls on screen in showroom', () => {
    const fieldOn = lm.planLabMode('showroom', { fieldCoupling: true });
    assert.ok(fieldOn.showCouplingControls === true, 'live bus with hidden switch');
  });
  it('an explicit-off bus is left alone and does not reveal the controls', () => {
    const fieldOff = lm.planLabMode('showroom', { fieldCoupling: false });
    assert.ok(!fieldOff.forceOff.fieldCoupling && fieldOff.showCouplingControls === false, JSON.stringify(fieldOff));
  });

  it('?class=1 keeps classroom on and the explainer visible in showroom', () => {
    const cls = lm.planLabMode('showroom', { classroom: true });
    assert.ok(!cls.classroomOff && cls.showExplainer === true, JSON.stringify(cls));
  });
  it('?class=0 does not reveal the explainer', () => {
    assert.ok(lm.planLabMode('showroom', { classroom: false }).showExplainer === false, 'revealed');
  });

  for (const m of ['lab', 'twin']) {
    it(`${m} forces nothing off and mutes nothing`, () => {
      const p = lm.planLabMode(m, {});
      assert.ok(!p.forceOff.fieldCoupling && !p.forceOff.chargeCoupling && !p.forceOff.energyCoupling && !p.muteAudio && !p.classroomOff,
        JSON.stringify(p));
    });
    it(`${m} shows explainer and coupling controls`, () => {
      const p = lm.planLabMode(m, {});
      assert.ok(p.showExplainer && p.showCouplingControls, JSON.stringify(p));
    });
  }
  it('twin leaves the look alone', () => {
    assert.ok(lm.planLabMode('twin', {}).look === null, 'twin set a look');
  });
});

describe('resolution', () => {
  it('?labMode= wins over the remembered mode', () => {
    assert.ok(lm.resolveBootLabMode('?labMode=twin', 'lab') === 'twin', 'url lost');
  });
  it('remembered mode applies with no param', () => {
    assert.ok(lm.resolveBootLabMode('', 'showroom') === 'showroom', 'stored lost');
  });
  it('no param and nothing stored → no mode', () => {
    assert.ok(lm.resolveBootLabMode('?renderer=webgl2', null) === null, 'invented a mode');
  });
  it('junk ?labMode= falls back to the remembered mode', () => {
    assert.ok(lm.resolveBootLabMode('?labMode=disco', 'lab') === 'lab', 'junk accepted');
  });
  it('junk everywhere → no mode', () => {
    assert.ok(lm.resolveBootLabMode('?labMode=disco', 'disco') === null, 'junk accepted');
  });
  // One tolerant LabConfig parser: enum values match case-insensitively.
  it('mode names match case-insensitively', () => {
    assert.ok(lm.resolveBootLabMode('?labMode=Lab', null) === 'lab', 'Lab rejected');
  });
  it('a remembered mode is parsed the same way', () => {
    assert.ok(lm.resolveBootLabMode('', 'TWIN') === 'twin', 'stored TWIN rejected');
  });

  it('overrides read look/audio/class/buses and nothing else', () => {
    const o = lm.readLabModeOverrides('?look=drama&audio=1&class=1&fieldCoupling=0&chargeCoupling=1&renderer=webgl2');
    assert.ok(o.look === 'drama' && o.audio === true && o.classroom === true && o.fieldCoupling === false
      && o.chargeCoupling === true && o.energyCoupling === undefined && !('renderer' in o), JSON.stringify(o));
  });
  it('an unparsable flag is not an override', () => {
    assert.ok(!('audio' in lm.readLabModeOverrides('?audio=maybe')), 'audio=maybe counted');
  });
  it('booleans take on/off/yes/no', () => {
    assert.ok(lm.readLabModeOverrides('?fieldCoupling=on&chargeCoupling=no').chargeCoupling === false
      && lm.readLabModeOverrides('?fieldCoupling=on').fieldCoupling === true, 'tolerant booleans lost');
  });
  it('?lighting= is the same override as ?look=', () => {
    assert.ok(lm.readLabModeOverrides('?lighting=lab').look === 'lab', 'alias lost');
  });
  it('a #lab= share link with class=1 is an explicit classroom', async () => {
    assert.ok(lm.readLabModeOverrides('', await hashFields('#lab=v1;mode=seg;class=1;tour=1')).classroom === true, 'hash class lost');
  });
  it('the URL outranks the share link', async () => {
    assert.ok(lm.readLabModeOverrides('?class=0', await hashFields('#lab=v1;class=1')).classroom === false, 'hash beat URL');
  });
  it('a #lab= link without class=1 is not', async () => {
    assert.ok(lm.readLabModeOverrides('', await hashFields('#lab=v1;mode=seg')).classroom === undefined, 'hash class invented');
  });
  it('storage key is seg-lab-mode', () => {
    assert.ok(lm.LAB_MODE_STORAGE_KEY === 'seg-lab-mode', lm.LAB_MODE_STORAGE_KEY);
  });
});

describe('setpoints (catalog)', () => {
  const cat = JSON.parse(read('physics/devices.json'));
  const consts = JSON.parse(read('physics/constants.json'));
  const rows = [];
  for (const d of cat.devices) for (const s of d.setpoints || []) rows.push({ ...s, deviceId: d.id });
  const ids = rows.map((r) => r.id);

  let sp, lor, hal, win, calls, phys;
  before(async () => {
    sp = await bundleTs('src/setpoint-sliders.ts');
    lor = sp.setpointById('lorentzField');
    hal = sp.setpointById('halbachSegments');
    // Write semantics against a fake window.
    calls = [];
    phys = { lorentzFieldLocalT: 0.8, halbachSegmentSetpoint: null, halbachSegmentCount: 9, pulseCoilChargeSetpointV: null, pulseCoilVCap: 5 };
    win = {
      multiVisualizer: { devices: { 'lorentz-sled': { physicsState: phys }, 'halbach-viz': { physicsState: phys }, 'pulse-coil': { physics: phys } } },
      setLorentzFieldT: (v) => calls.push(v)
    };
  });

  it('catalog declares the Lorentz, Halbach, pulse-coil and drop-tube setpoints', () => {
    assert.ok(['lorentzField', 'halbachSegments', 'pulseCoilCharge', 'dropTubeSigma'].every((i) => ids.includes(i)), ids.join());
  });
  it('setpoint ids are unique', () => {
    assert.ok(new Set(ids).size === ids.length, ids.join());
  });
  it('generated DEVICE_SETPOINTS matches the catalog row for row', () => {
    assert.ok(sp.setpointsForDevice('lorentz-sled').length === 1 && sp.setpointById('halbachSegments')?.deviceId === 'halbach-viz'
      && sp.setpointById('pulseCoilCharge')?.max === 48, 'codegen stale?');
  });
  for (const r of rows) {
    it(`${r.id}: min < max, 0 < step <= span`, () => {
      assert.ok(r.min < r.max && r.step > 0 && r.step <= r.max - r.min, JSON.stringify(r));
    });
  }

  // The slider range stands in for the plant's own clamp — it must not drift.
  it('Lorentz slider max == plant fieldTMax', () => {
    assert.ok(lor.max === consts.lorentzSled?.fieldTMax || lor.max === findKey(consts, 'fieldTMax'),
      `${lor.max} vs ${findKey(consts, 'fieldTMax')}`);
  });
  it('Halbach slider range == plant segmentMin..segmentMax', () => {
    assert.ok(hal.min === findKey(consts, 'segmentMin') && hal.max === findKey(consts, 'segmentMax'),
      `${hal.min}..${hal.max} vs ${findKey(consts, 'segmentMin')}..${findKey(consts, 'segmentMax')}`);
  });
  it('pulse-coil slider max == vChargeMax', () => {
    const pc = sp.setpointById('pulseCoilCharge');
    assert.ok(pc.max === findKey(consts, 'vChargeMax'), `${pc.max} vs ${findKey(consts, 'vChargeMax')}`);
  });
  it('drop-tube σ slider spans 0..sigmaMaxMSm and reaches the catalog tube', () => {
    const tube = sp.setpointById('dropTubeSigma');
    assert.ok(tube?.min === 0 && tube?.max === consts.dropTube.sigmaMaxMSm && consts.dropTube.tubeSigmaMSm <= tube?.max,
      `${tube?.min}..${tube?.max} vs 0..${consts.dropTube.sigmaMaxMSm}`);
  });

  // Sequential: the writes below share `calls` and `phys`.
  it('api setpoint calls the window API, not the state key', () => {
    assert.ok(sp.applySetpoint(lor, 0.5, win) && calls.join() === '0.5' && phys.lorentzFieldLocalT === 0.8, `${calls} ${phys.lorentzFieldLocalT}`);
  });
  it('api write is clamped to the catalog range', () => {
    sp.applySetpoint(lor, 99, win);
    assert.ok(calls[1] === lor.max, String(calls[1]));
  });
  it('NaN clamps to min rather than reaching the plant', () => {
    sp.applySetpoint(lor, Number.NaN, win);
    assert.ok(calls[2] === lor.min, String(calls[2]));
  });
  it('stateKey setpoint writes physicsState', () => {
    assert.ok(sp.applySetpoint(hal, 13, win) && phys.halbachSegmentSetpoint === 13, String(phys.halbachSegmentSetpoint));
  });
  it('reads back the pinned value', () => {
    assert.ok(sp.readSetpoint(hal, win) === 13, String(sp.readSetpoint(hal, win)));
  });
  it('stateKey write clamps', () => {
    assert.ok((sp.applySetpoint(hal, 500, win), phys.halbachSegmentSetpoint === hal.max), String(phys.halbachSegmentSetpoint));
  });
  it('releasing hands control back (null)', () => {
    assert.ok(sp.applySetpoint(hal, null, win) && phys.halbachSegmentSetpoint === null, String(phys.halbachSegmentSetpoint));
  });
  it('unset setpoint displays the live plant value', () => {
    assert.ok(sp.displaySetpoint(hal, win) === 9, String(sp.displaySetpoint(hal, win)));
  });
  it('a non-releasable setpoint refuses to be released', () => {
    assert.ok(sp.applySetpoint(lor, null, win) === false, 'released Lorentz');
  });
  it('writing before the bench exists is a no-op, not a throw', () => {
    assert.ok(sp.applySetpoint(hal, 8, { multiVisualizer: { devices: {} } }) === false, 'wrote');
  });
  it('writing with no visualizer is a no-op', () => {
    assert.ok(sp.applySetpoint(hal, 8, {}) === false, 'wrote');
  });
});

describe('plants honour the setpoints', () => {
  let hv, pcm, dtm, stepHalbach, sweptN;
  before(async () => {
    hv = await bundleTs('src/devices/quanta/halbach-viz.ts');
    pcm = await bundleTs('src/devices/quanta/pulse-coil.ts');
    dtm = await bundleTs('src/devices/quanta/drop-tube.ts');
    stepHalbach = hv.stepHalbachVizPhysics;
  });

  describe('Halbach', () => {
    it('Halbach unset: drive sweeps N (4 + round(0.5×20) = 14)', () => {
      const free = {};
      stepHalbach(free, 0.016, 0.5);
      sweptN = free.halbachSegmentCount;
      assert.ok(sweptN === 14, String(sweptN));
    });
    it('Halbach pinned: N follows the setpoint, the angle still follows the drive', () => {
      const pinned = { halbachSegmentSetpoint: 6 };
      stepHalbach(pinned, 0.016, 0.5);
      assert.ok(pinned.halbachSegmentCount === 6, `Halbach pinned: N follows the setpoint, not the drive: ${pinned.halbachSegmentCount}`);
      assert.ok(Math.abs(pinned.halbachMagAngleDeg - (360 / 6) * (hv.HALBACH_VIZ.magAngleBase + 0.5 * hv.HALBACH_VIZ.magAngleSpan)) < 1e-9,
        `Halbach pinned: the magnetisation angle still follows the drive: ${pinned.halbachMagAngleDeg}`);
    });
    it('Halbach slider pin survives drive changes', () => {
      const sliderPinned = { halbachSegmentSetpoint: 6 };
      stepHalbach(sliderPinned, 0.016, 0.8);
      assert.ok(sliderPinned.halbachSegmentCount === 6, String(sliderPinned.halbachSegmentCount));
    });
    it('Halbach pinned: out-of-range clamps to segmentMax', () => {
      const wild = { halbachSegmentSetpoint: 1e9 };
      stepHalbach(wild, 0.016, 0);
      assert.ok(wild.halbachSegmentCount === hv.HALBACH_VIZ.segmentMax, String(wild.halbachSegmentCount));
    });
    it('Halbach NaN setpoint falls back to the drive sweep', () => {
      const nan = { halbachSegmentSetpoint: Number.NaN };
      stepHalbach(nan, 0.016, 0.5);
      assert.ok(nan.halbachSegmentCount === sweptN, String(nan.halbachSegmentCount));
    });
    it('Halbach null setpoint (released) falls back to the drive sweep', () => {
      const nul = { halbachSegmentSetpoint: null };
      stepHalbach(nul, 0.016, 0.5);
      assert.ok(nul.halbachSegmentCount === sweptN, String(nul.halbachSegmentCount));
    });
  });

  describe('pulse coil', () => {
    let vmax, settle, noSet;
    before(() => {
      vmax = pcm.PULSE_COIL.vChargeMax;
      settle = (state, drive, steps = 3000) => {
        for (let i = 0; i < steps; i++) pcm.stepPulseCoilPhysics(state, 0.001, drive);
        return state;
      };
      // Idle charging only: drive below the auto-fire threshold so the bank never discharges.
      noSet = settle({ pulseCoilVCap: 0 }, 0.05);
    });
    it('pulse-coil unset: bank charges toward drive × V_max', () => {
      assert.ok(Math.abs(noSet.pulseCoilVCap - 0.05 * vmax) < 0.15 * vmax * 0.05 + 0.3, `${noSet.pulseCoilVCap} vs ${0.05 * vmax}`);
    });
    it('pulse-coil pinned: bank charges toward the setpoint, not drive × V_max', () => {
      const set24 = settle({ pulseCoilVCap: 0, pulseCoilChargeSetpointV: 24 }, 0.05);
      assert.ok(set24.pulseCoilVCap > 0.05 * vmax + 5 && set24.pulseCoilVCap <= 24 + 1e-6, `${set24.pulseCoilVCap}`);
    });
    it('pulse-coil pinned: target is clamped to vChargeMax', () => {
      const over = settle({ pulseCoilVCap: 0, pulseCoilChargeSetpointV: 1e6 }, 0.05);
      assert.ok(over.pulseCoilVCap <= vmax + 1e-6, `${over.pulseCoilVCap}`);
    });
    it('pulse-coil pinned at 0 V drains the bank to 0 rather than falling back to drive', () => {
      const zero = settle({ pulseCoilVCap: 30, pulseCoilChargeSetpointV: 0 }, 0.05);
      assert.ok(zero.pulseCoilVCap < 1, `${zero.pulseCoilVCap}`);
    });
    it('pulse-coil NaN setpoint falls back to drive × V_max', () => {
      const nanPc = settle({ pulseCoilVCap: 0, pulseCoilChargeSetpointV: Number.NaN }, 0.05);
      assert.ok(Math.abs(nanPc.pulseCoilVCap - noSet.pulseCoilVCap) < 1e-9, `${nanPc.pulseCoilVCap}`);
    });
  });

  // Drop tube: a pinned σ sets the terminal velocity; unset / NaN is the catalog copper.
  describe('drop tube', () => {
    let midTube, cu;
    before(() => {
      midTube = (extra) => {
        const st = { ...dtm.createDropTubePhysicsState(), ...extra };
        for (let i = 0; i < 6000 && !(st.dropTubeDepthM > dtm.TUBE.tubeLengthM / 2); i++) dtm.stepDropTubePhysics(st, 1 / 60, 0.5);
        return st;
      };
      cu = midTube({});
    });
    it('drop-tube unset: falls at the catalog tube\'s v_t', () => {
      assert.ok(Math.abs(cu.dropTubeVMps - dtm.dropTubeTerminalVelocity(dtm.TUBE.tubeSigmaMSm)) < 1e-3 * cu.dropTubeVMps,
        `${cu.dropTubeVMps}`);
    });
    it('drop-tube pinned at half σ: twice the terminal velocity', () => {
      const half = midTube({ dropTubeSigmaSetpointMSm: dtm.TUBE.tubeSigmaMSm / 2 });
      assert.ok(Math.abs(half.dropTubeVMps / cu.dropTubeVMps - 2) < 2e-3, `${half.dropTubeVMps / cu.dropTubeVMps}`);
    });
    it('drop-tube NaN σ falls back to the catalog tube', () => {
      const nanTube = midTube({ dropTubeSigmaSetpointMSm: Number.NaN });
      assert.ok(nanTube.dropTubeSigmaMSm === dtm.TUBE.tubeSigmaMSm, String(nanTube.dropTubeSigmaMSm));
    });
  });
});

describe('live region', () => {
  let lr;
  const snapPulse = { view: 'pulse-coil', seg: null, devices: { 'pulse-coil': { id: 'pulse-coil', pulseCoilCurrentA: 12.4 } } };
  const nanSnap = { view: 'pulse-coil', seg: null, devices: { 'pulse-coil': { id: 'pulse-coil', pulseCoilCurrentA: Number.NaN } } };
  before(async () => { lr = await bundleTs('src/focus-live-region.ts'); });

  it('announces lab mode + bench + one catalog number', () => {
    const a = lr.announcementFor(snapPulse, 'lab');
    assert.ok(/^Lab mode\. Pulse Coil.*, I 12\.40 A$/.test(a), a);
  });
  it('no lab mode → no mode prefix', () => {
    assert.ok(!/mode/.test(lr.announcementFor(snapPulse, null)), lr.announcementFor(snapPulse, null));
  });
  it('an unknown mode string is not announced', () => {
    assert.ok(!/mode/.test(lr.announcementFor(snapPulse, 'disco')), lr.announcementFor(snapPulse, 'disco'));
  });
  it('a NaN reading is "—", never "NaN"', () => {
    assert.ok(!/NaN/.test(lr.announcementFor(nanSnap, 'twin')) && /—/.test(lr.announcementFor(nanSnap, 'twin')),
      lr.announcementFor(nanSnap, 'twin'));
  });
  it('overview announces just "Overview"', () => {
    assert.ok(lr.headlineFor({ view: 'overview', seg: null, devices: {} }) === 'Overview', 'overview');
  });
  it('SEG announces inner-ring RPM', () => {
    assert.ok(lr.headlineFor({ view: 'seg', seg: { rpmDisplay: 1234.6 }, devices: {} }) === 'SEG, inner ring 1235 RPM',
      lr.headlineFor({ view: 'seg', seg: { rpmDisplay: 1234.6 }, devices: {} }));
  });
  it('SEG with no plant yet still announces a name', () => {
    assert.ok(lr.headlineFor({ view: 'seg', seg: null, devices: {} }) === 'SEG', 'seg null');
  });
  it('a bench with no snapshot yet still announces its name', () => {
    assert.ok(lr.headlineFor({ view: 'pulse-coil', seg: null, devices: {} }) === 'Pulse Coil (R–L)',
      lr.headlineFor({ view: 'pulse-coil', seg: null, devices: {} }));
  });
});

describe('tours: every glossary term a step names exists', () => {
  let tp, ts, gl;
  before(async () => {
    tp = await bundleTs('src/seg-explainer/seg-tour-player.ts');
    ts = await bundleTs('src/seg-explainer/tour-scripts.ts');
    gl = await bundleTs('src/seg-explainer/seg-glossary.ts');
  });

  it('every LAB_TOURS row has a script (tour-scripts.ts)', () => {
    assert.ok(tp.LAB_TOURS.every((d) => ts.TOUR_SCRIPTS[d.key]?.steps?.length),
      tp.LAB_TOURS.filter((d) => !ts.TOUR_SCRIPTS[d.key]).map((d) => d.key).join(', '));
  });
  it('every tour step\'s glossaryTerm resolves (a missing one silently shows nothing)', () => {
    const missing = [];
    for (const def of tp.LAB_TOURS) {
      for (const step of ts.TOUR_SCRIPTS[def.key]?.steps || []) {
        if (step.glossaryTerm && !gl.SEG_GLOSSARY[step.glossaryTerm]) missing.push(`${def.key}:${step.id}→${step.glossaryTerm}`);
      }
    }
    assert.ok(missing.length === 0, missing.join(', '));
  });
  it('drop-tube tour closes on what the model is not', () => {
    const tube = tp.LAB_TOURS.find((t) => t.mode === 'drop-tube');
    const last = tube && ts.TOUR_SCRIPTS[tube.key].steps.at(-1);
    assert.ok(/not/i.test(last?.title ?? '') && /thermal/i.test(last?.body ?? '')
      && /not a brake-design tool/i.test(last?.body ?? ''), last?.title ?? 'no drop-tube tour');
  });
});

describe('structure', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys(pkg.dependencies || {});
  it('no UI framework in runtime dependencies', () => {
    assert.ok(!deps.some((d) => /^(react|vue|lit|svelte|preact|solid-js)/.test(d)), deps.join());
  });
  it('no i18n package in runtime dependencies', () => {
    assert.ok(!deps.some((d) => /i18n|intl/.test(d)), deps.join());
  });
  it('index.html carries only the header host + setpoint host, no per-device slider markup', () => {
    const idx = read('src/index.html');
    assert.ok(idx.includes('id="lab-mode-switch"') && idx.includes('id="device-setpoints"') && !idx.includes('id="lorentzFieldSlider"')
      && !idx.includes('id="halbachSegmentsSlider"') && !idx.includes('id="pulseCoilChargeSlider"')
      && !idx.includes('id="dropTubeSigmaSlider"'), 'hand-wired slider crept back');
  });
});
