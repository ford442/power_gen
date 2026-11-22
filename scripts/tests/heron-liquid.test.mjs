/**
 * Heron's fountain as a liquid scene (ADR-0022, docs/FLUIDS.md → Heron),
 * without a GPU: how the box, the grid and the step are sized per layout
 * preset and tier, which tier a `fluid` choice gets, and the focus camera
 * that has to hold the jet. The scene itself runs on a real GPU in
 * scripts/tests/gpu/golden-heron-liquid.test.mjs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bundleTs } from '../test-harness.mjs';

const M = await bundleTs({
  contents: `
    export * from './src/fluids/heron-liquid.ts';
    export * as mpm from './src/fluids/mpm-params.ts';
    export { mpmSolidsDistance } from './src/fluids/mpm-boundary.ts';
    export { getHeronLayout, computeHeronHydraulics, heronFocusCamera, HERON_LAYOUT_PRESETS } from './src/heron-layout.ts';
    export { liquidTierFor, liquidCeilingAfter, heronLiquidGateOpen, heronLiquidLifetime, HERON_LIQUID_OWNER } from './src/visualizer/heron-liquid-pass.ts';
    export { LAB_MODE_PRESETS, planLabMode, readLabModeOverrides } from './src/lab-mode.ts';
    export { PHYSICAL_CONSTANTS, HERON_CONSTANTS } from './generated/physics-constants.ts';
    export { LAB_CONFIG_FIELDS } from './generated/lab-config.ts';
    export { heronLiquidNoteText, HeronLiquidNote } from './src/heron-liquid-note.ts';
    export { stepParticles, heronDropletApex } from './src/renderers/shared/particle-physics.ts';
  `,
  sourcefile: 'heron-liquid-entry.ts'
});

const PRESETS = Object.values(M.HERON_LAYOUT_PRESETS);
const TIERS = ['low', 'default', 'high'];
const sceneFor = (id, tier) => {
  const layout = M.getHeronLayout(id);
  return { layout, scene: M.heronLiquidScene({ ...layout, riserM: M.heronRiserM(layout) }, tier) };
};

describe('heron-liquid: the scene', () => {
  for (const id of PRESETS) {
    for (const tier of TIERS) {
      it(`${id} / ${tier}: fits the tier's budgets and the step is one the solver can carry`, () => {
        const { layout, scene } = sceneFor(id, tier);
        const c = scene.config;
        const d = M.mpm.mpmDerived(c);
        const budget = M.mpm.MPM_TIERS[tier];
        assert.deepEqual(M.mpm.validateMpmConfig(c), []);
        assert.equal(c.maxParticles, budget.particles);
        assert.ok(d.nodes <= 1.1 * budget.gridN ** 3, `${c.gridN.join('×')} = ${d.nodes} nodes on a budget of ${budget.gridN}³`);
        // The liquid's sound speed stays well above the fastest jet the preset can make.
        assert.ok(d.soundSpeed >= 2.7 * scene.jetMaxMS, `sound ${d.soundSpeed} m/s, fastest jet ${scene.jetMaxMS} m/s`);
        assert.ok(c.maxSpeedMS >= 1.2 * scene.jetMaxMS, 'the speed clamp sits above the jet');
        assert.ok(scene.substepsPerFrame >= 1 && scene.substepsPerFrame <= 8);
        assert.ok(Math.abs(scene.substepsPerFrame * c.dt * 60 - scene.timeScale) < 1e-9, 'substeps × dt is one displayed frame at the time scale');
        // The nozzle is on the axis of the box, the riser's height above the tray, and the tallest jet fits under the lid.
        const b = M.mpm.mpmBounds(c);
        assert.ok(Math.abs(scene.nozzle[0] - (c.gridN[0] * c.cellM) / 2) < 1e-12);
        assert.ok(Math.abs(scene.nozzle[1] - scene.trayFloorM - M.heronRiserM(layout)) < 1e-9);
        assert.ok(scene.nozzle[1] + 1.15 * scene.jetMaxHeightM < b.max[1], 'the jet at full head stays inside the box');
        assert.ok(b.max[0] - b.min[0] >= 2 * M.HERON_TRAY.halfWidthM - 1e-9, 'the tray is as wide as it says');
        // The jet at full head, in flight, leaves at least half the particle budget free.
        const flow = Math.PI * scene.nozzleRadiusM ** 2 * scene.jetMaxMS;
        const inFlight = (flow * (2 * scene.jetMaxMS) / M.PHYSICAL_CONSTANTS.G) / d.particleVolume;
        assert.ok(inFlight < 0.5 * budget.particles, `${Math.round(inFlight)} particles in flight on a budget of ${budget.particles}`);
        // The nozzle mouth is in open liquid, not inside the riser under it.
        assert.ok(M.mpmSolidsDistance(scene.solids, ...scene.nozzle) > 0);
        assert.ok(M.mpmSolidsDistance(scene.solids, scene.nozzle[0], scene.nozzle[1] - c.cellM, scene.nozzle[2]) < 0, 'the riser is under the nozzle');
        // The drain is the tray floor: a point just above it is inside the sink, the nozzle is not.
        const inSink = (p) => scene.sinks.some((s) => p.every((x, a) => x >= s.min[a] && x <= s.max[a]));
        assert.ok(inSink([scene.nozzle[0] + 0.2, scene.trayFloorM + 0.2 * c.cellM, scene.nozzle[2]]));
        assert.ok(!inSink(scene.nozzle));
      });
    }
  }

  it('a finer tier means a finer cell, and the default tier resolves the nozzle', () => {
    for (const id of PRESETS) {
      const cells = TIERS.map((t) => sceneFor(id, t).scene.config.cellM);
      assert.ok(cells[0] > cells[1] && cells[1] > cells[2], `${id}: cells ${cells.map((x) => (x * 1000).toFixed(1))} mm`);
      const { scene } = sceneFor(id, 'default');
      assert.ok((2 * scene.nozzleRadiusM) / scene.config.cellM > 1.5, `${id}: ${((2 * scene.nozzleRadiusM) / scene.config.cellM).toFixed(2)} cells across the nozzle`);
    }
  });

  it('the riser is the drawn one: from the top of the highest vessel to the nozzle mouth', () => {
    const want = { classic: 6.1 - (4.8 + 1.25), compact: 4.2 - (2.8 + 1.25), tower: 8.8 - (6.2 + 1.25), wide: 5.8 - (4.2 + 1.25), spiral: 7.4 - (4.6 + 1.25) };
    for (const [id, scene] of Object.entries(want)) {
      const r = M.heronRiserM(M.getHeronLayout(id));
      assert.ok(Math.abs(r - Math.max(M.HERON_MIN_RISER_M, scene * M.HERON_METRES_PER_SCENE_UNIT)) < 1e-9, `${id}: riser ${r} m`);
    }
    assert.equal(M.heronRiserM({ vessels: [], flow: { apexY: 3 } }), M.HERON_MIN_RISER_M);
  });

  it('the emitter is the plant\'s jet: its speed, its nozzle, none below a dribble', () => {
    const { layout, scene } = sceneFor('classic', 'default');
    const v = M.computeHeronHydraulics(layout.headMaxM, layout).vExit;
    const [e] = M.heronEmitters(scene, v);
    assert.equal(e.speedMS, v);
    assert.equal(e.radiusM, layout.nozzleDiameterM / 2);
    assert.deepEqual(e.direction, [0, 1, 0]);
    assert.deepEqual(e.centre, scene.nozzle);
    // Plug flow through the emitter is the plant's own flow.
    assert.ok(Math.abs(M.mpm.mpmEmitterFlow(e) / M.computeHeronHydraulics(layout.headMaxM, layout).flowM3s - 1) < 1e-12);
    assert.deepEqual(M.heronEmitters(scene, 0), []);
    assert.deepEqual(M.heronEmitters(scene, M.HERON_MIN_JET_MS * 0.99), []);
    assert.deepEqual(M.heronEmitters(scene, NaN), []);
    assert.ok(Math.abs(M.heronIdealJetHeight(3) - 9 / (2 * M.PHYSICAL_CONSTANTS.G)) < 1e-15);
    assert.ok(scene.jetMaxMS >= v, 'the frictionless ceiling bounds the plant');
  });

  it('placement: the nozzle lands on its drawn position, at the bench scale', () => {
    const { scene } = sceneFor('tower', 'low');
    const drawn = [0, 8.8, 0];
    const p = M.heronLiquidPlacement(scene, drawn);
    assert.equal(p.scale, 1 / M.HERON_CONSTANTS.METRES_PER_SCENE_UNIT);
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(p.origin[a] + scene.nozzle[a] * p.scale - drawn[a]) < 1e-12);
    // A metre of jet is 1/0.64 scene units.
    assert.ok(Math.abs(p.scale - 1.5625) < 1e-12);
  });
});

describe('heron-liquid: which tier, and when', () => {
  it('fluid=auto follows the quality tier and never takes the 96³ tier', () => {
    assert.equal(M.liquidTierFor('auto', 'high'), 'default');
    assert.equal(M.liquidTierFor('auto', 'ultra'), 'default');
    assert.equal(M.liquidTierFor('auto', 'medium'), 'low');
    assert.equal(M.liquidTierFor('auto', 'low'), 'low');
    assert.equal(M.liquidTierFor('auto', 'critical'), null);
    for (const q of ['critical', 'low', 'medium', 'high']) {
      assert.equal(M.liquidTierFor('off', q), null);
      assert.equal(M.liquidTierFor('low', q), 'low');
      assert.equal(M.liquidTierFor('high', q), 'high');
    }
  });

  it('a lab mode can ask for the most or for none, while fluid is left at auto', () => {
    // Showroom: the largest tier the profiler allows; the 96³ tier only while it holds `high`.
    const most = { preset: 'high' };
    assert.equal(M.liquidTierFor('auto', 'high', most), 'high');
    assert.equal(M.liquidTierFor('auto', 'medium', most), 'default');
    assert.equal(M.liquidTierFor('auto', 'low', most), 'low');
    assert.equal(M.liquidTierFor('auto', 'critical', most), null);
    // Twin: none.
    for (const q of ['critical', 'low', 'medium', 'high']) assert.equal(M.liquidTierFor('auto', q, { preset: 'off' }), null);
    // A choice made by hand is not the preset's to change.
    for (const preset of ['high', 'off', null]) {
      assert.equal(M.liquidTierFor('low', 'high', { preset }), 'low');
      assert.equal(M.liquidTierFor('high', 'low', { preset }), 'high');
      assert.equal(M.liquidTierFor('off', 'high', { preset }), null);
    }
    assert.equal(M.LAB_MODE_PRESETS.showroom.fluid, 'high');
    assert.equal(M.LAB_MODE_PRESETS.lab.fluid, null);
    assert.equal(M.LAB_MODE_PRESETS.twin.fluid, 'off');
    assert.equal(M.planLabMode('twin', {}).fluid, 'off');
    assert.equal(M.planLabMode('twin', M.readLabModeOverrides('?fluid=low')).fluid, null, '?fluid= wins over the preset');
    assert.equal(M.planLabMode('showroom', M.readLabModeOverrides('?fluid=auto')).fluid, null, 'also when it says auto');
    assert.equal(M.planLabMode('showroom', M.readLabModeOverrides('?look=drama')).fluid, 'high');
  });

  it('auto steps down when the profiler cannot hold the tier it built, and does not climb back', () => {
    // A phone that booted at `high`: the default tier is built, the frame rate falls.
    let ceiling = 'high';
    let running = M.liquidTierFor('auto', 'high', { ceiling });
    assert.equal(running, 'default');
    ceiling = M.liquidCeilingAfter(running, M.liquidTierFor('auto', 'medium'), ceiling);
    assert.equal(ceiling, 'low');
    running = M.liquidTierFor('auto', 'medium', { ceiling });
    assert.equal(running, 'low');
    // The profiler recovers: the ceiling stays.
    ceiling = M.liquidCeilingAfter(running, M.liquidTierFor('auto', 'high'), ceiling);
    assert.equal(ceiling, 'low');
    assert.equal(M.liquidTierFor('auto', 'high', { ceiling }), 'low');
    // Still too much — `critical` with the low tier running: none, for the rest of the page.
    ceiling = M.liquidCeilingAfter(running, M.liquidTierFor('auto', 'critical'), ceiling);
    assert.equal(ceiling, 'off');
    for (const q of ['low', 'medium', 'high']) assert.equal(M.liquidTierFor('auto', q, { ceiling }), null);
    for (const q of ['low', 'medium', 'high']) assert.equal(M.liquidTierFor('auto', q, { ceiling, preset: 'high' }), null);

    // Showroom on a laptop: 96³ → 64³ → 32³ → none takes three failures, one step each.
    const most = { preset: 'high' };
    let c = 'high';
    c = M.liquidCeilingAfter('high', M.liquidTierFor('auto', 'critical', most), c);
    assert.equal(c, 'default');
    c = M.liquidCeilingAfter('default', M.liquidTierFor('auto', 'critical', most), c);
    assert.equal(c, 'low');
    c = M.liquidCeilingAfter('low', M.liquidTierFor('auto', 'critical', most), c);
    assert.equal(c, 'off');

    // Nothing running, or the profiler allows what is running: no change.
    assert.equal(M.liquidCeilingAfter(null, null, 'high'), 'high');
    assert.equal(M.liquidCeilingAfter('low', 'low', 'high'), 'high');
    assert.equal(M.liquidCeilingAfter('low', 'default', 'default'), 'default');
    // A choice made by hand ignores the ceiling.
    assert.equal(M.liquidTierFor('high', 'low', { ceiling: 'off' }), 'high');
  });

  it('the gate opens in Heron focus only', () => {
    const open = (currentView, choice = 'auto', qualityTier = 'high') => M.heronLiquidGateOpen({ choice, currentView, qualityTier });
    assert.equal(open(M.HERON_LIQUID_OWNER), true);
    for (const view of ['overview', 'seg', 'kelvin', 'peltier', null, undefined]) assert.equal(open(view), false, `view ${view}`);
    assert.equal(open('heron', 'off'), false);
    assert.equal(open('heron', 'auto', 'critical'), false);
    assert.equal(open('heron', 'low', 'critical'), true, 'an explicit choice is honoured at any quality tier');
    assert.equal(M.heronLiquidGateOpen({ choice: 'auto', currentView: 'heron', qualityTier: 'high', preset: 'off' }), false);
    assert.equal(M.heronLiquidGateOpen({ choice: 'auto', currentView: 'heron', qualityTier: 'high', ceiling: 'off' }), false);
  });

  it('a host that never built the pass holds no liquid resources', () => {
    const life = M.heronLiquidLifetime({});
    assert.equal(life.name, 'heron-liquid');
    assert.equal(life.isAllocated(), false);
    life.ensure();
    life.release();
    assert.equal(life.isAllocated(), false);
    assert.equal(M.heronLiquidLifetime({ heronLiquid: null }).isAllocated(), false, 'a failed build is not an allocation');
  });

  it('the `fluid` LabConfig row offers exactly the choices the gate reads', () => {
    const row = M.LAB_CONFIG_FIELDS.find((f) => f.key === 'fluid');
    assert.ok(row, 'config/lab-config.json has no `fluid` row');
    assert.deepEqual([...row.values], ['auto', 'off', 'low', 'high']);
    assert.equal(row.default, 'auto');
  });
});

describe('heron-layout: the focus camera holds the fountain', () => {
  for (const id of PRESETS) {
    it(`${id}: platform to the top of the tallest jet, inside a 45° view`, () => {
      const layout = M.getHeronLayout(id);
      const cam = M.heronFocusCamera(id);
      const cd = layout.dischargeCoeff ?? 0.35;
      const jetTop = layout.flow.apexY + (cd * cd * layout.headMaxM) / M.HERON_CONSTANTS.METRES_PER_SCENE_UNIT;
      let bottom = Infinity;
      for (const inst of [...layout.vessels, ...layout.platform]) bottom = Math.min(bottom, inst[1] - 1.25);
      // Angle of a point on the axis above / below the line of sight.
      const dy = cam.cameraOffset[1] - cam.cameraTarget[1];
      const pitch = Math.atan2(dy, cam.cameraOffset[2]);
      const angleTo = (y) => Math.atan2(y - cam.cameraOffset[1], cam.cameraOffset[2]) + pitch;
      const half = Math.PI / 8;
      assert.ok(Math.abs(angleTo(jetTop)) < half, `jet top at ${(angleTo(jetTop) * 180 / Math.PI).toFixed(1)}° of ±22.5°`);
      assert.ok(Math.abs(angleTo(bottom)) < half, `platform at ${(angleTo(bottom) * 180 / Math.PI).toFixed(1)}° of ±22.5°`);
      assert.ok(cam.cameraTarget[1] > layout.vessels[0][1], 'the camera no longer looks at the floor of the bench');
    });
  }
});

describe('heron: the note says what is drawing the water', () => {
  const running = { choice: 'auto', build: 'ready', allocated: true, active: true, tier: 'default', grid: [61, 61, 61], live: 8421, timeScale: 1 / 6, substeps: 400 };

  it('WebGL2: the liquid solver needs WebGPU', () => {
    const text = M.heronLiquidNoteText({ renderer: 'webgl2' });
    assert.match(text, /needs WebGPU/);
    assert.match(text, /ballistic/);
    assert.match(text, /not a measurement/);
  });

  it('WebGPU: the solver, its grid, its speed — or why it is not running', () => {
    const on = M.heronLiquidNoteText({ renderer: 'webgpu', fluid: running });
    assert.match(on, /MLS-MPM, 61×61×61 grid, 8,421 particles/);
    assert.match(on, /shown at 1\/6 speed/);
    assert.match(on, /not a measurement/);
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, choice: 'off', allocated: false, active: false } }), /fluid=off/);
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, build: 'failed', allocated: false, active: false } }), /unavailable/);
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, build: 'pending', allocated: false, active: false, substeps: 0 } }), /starting/);
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, allocated: true, active: true, substeps: 0 } }), /starting/);
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, allocated: false, active: false } }), /quality tier/);
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, preset: 'off', allocated: false, active: false } }), /off in this lab mode/);
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, ceiling: 'off', allocated: false, active: false } }), /could not keep its frame rate/);
    // A lab mode's "off" is not in the way of a choice made by hand.
    assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: { ...running, choice: 'low', preset: 'off' } }), /MLS-MPM/);
    // Whenever the solver is not the one drawing, the droplets are named as stand-ins.
    for (const f of [{ ...running, choice: 'off', active: false }, { ...running, allocated: false, active: false }]) {
      assert.match(M.heronLiquidNoteText({ renderer: 'webgpu', fluid: f }), /not a liquid/);
    }
  });

  it('shows in Heron focus only, and re-reads the renderer a couple of times a second', () => {
    let listener = null;
    let reads = 0;
    let now = 0;
    const note = new M.HeronLiquidNote({
      subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
      read: () => { reads++; return { renderer: 'webgl2' }; },
      now: () => now
    });
    listener({ view: 'seg' });
    assert.equal(note.active, false);
    assert.equal(reads, 0, 'nothing is read while another bench is in focus');
    listener({ view: 'heron' });
    assert.equal(note.active, true);
    assert.equal(reads, 1);
    assert.match(note.text, /needs WebGPU/);
    for (let i = 0; i < 20; i++) { now += 16; listener({ view: 'heron' }); }
    assert.ok(reads <= 2, `${reads} reads in 320 ms`);
    now += 600;
    listener({ view: 'heron' });
    assert.ok(reads >= 2);
    listener({ view: 'overview' });
    assert.equal(note.active, false);
    note.dispose();
    assert.equal(listener, null);
  });
});

describe('heron: the fallback droplets are SI ballistic', () => {
  const nozzleY = 6.1;
  const G_SCENE = () => M.PHYSICAL_CONSTANTS.G / M.HERON_CONSTANTS.METRES_PER_SCENE_UNIT;
  const inFlight = (p, i) => p[i * 8 + 7] !== 0;

  /** Run the droplets as the app does: no jet, then the plant spinning up to `v`, then steady. */
  function run(n, hz, v, { idleS = 0.5, rampS = 2, steadyS = 6 } = {}) {
    const particles = new Float32Array(n * 8);
    const dt = 1 / hz;
    let step = 0;
    let top = -Infinity;
    const advance = (seconds, speed) => {
      for (let k = 0; k < Math.round(seconds * hz); k++, step++) {
        const vNow = speed(k / Math.round(seconds * hz));
        M.stepParticles(particles, { time: step * dt, mode: 1, particleCount: n, dt, heronVExit: vNow, heronNozzleY: nozzleY, simClock: step * dt });
        for (let i = 0; i < n; i++) if (inFlight(particles, i)) top = Math.max(top, particles[i * 8 + 1]);
      }
    };
    advance(idleS, () => 0);
    const afterIdle = particles.slice();
    advance(rampS, (f) => v * f);
    top = -Infinity; // what the ramp threw is lower; measure the steady jet
    advance(steadyS, () => v);
    return { particles, afterIdle, top };
  }

  it('a droplet launched at the plant\'s exit speed rises v²/2g metres, drawn at the bench scale', () => {
    const v = 3.0;
    const n = 512;
    const { particles, afterIdle, top } = run(n, 600, v);
    const apex = M.heronDropletApex(v);
    assert.ok(Math.abs(apex - (v * v) / (2 * M.PHYSICAL_CONSTANTS.G) / M.HERON_CONSTANTS.METRES_PER_SCENE_UNIT) < 1e-12);
    assert.equal(M.heronDropletApex(0), 0);
    // Before the plant has a jet (overview, before spin-up) nothing is in the air or in the picture.
    for (let i = 0; i < n; i++) {
      assert.equal(inFlight(afterIdle, i), false, 'a droplet left the nozzle with no jet');
      assert.ok(afterIdle[i * 8 + 1] < nozzleY - 1000, 'a waiting droplet is drawn');
    }
    assert.ok(Math.abs((top - nozzleY) / apex - 1) < 0.02, `droplets rose ${(top - nozzleY).toFixed(4)} scene units; v²/2g at the bench scale is ${apex.toFixed(4)}`);
    // They stay on the bench: none below the basin, none above the apex.
    for (let i = 0; i < n; i++) {
      if (!inFlight(particles, i)) continue;
      const y = particles[i * 8 + 1];
      assert.ok(y > nozzleY - 0.36 && y < nozzleY + apex * 1.001, `droplet ${i} at ${y}`);
    }
  });

  for (const hz of [60, 20]) {
    it(`a stream, not a pulse: after a spin-up from rest the droplets are spread along the arc (${hz} fps)`, () => {
      // The case that went wrong in the app: every droplet waiting at the
      // nozzle when the jet starts. Released together they stay together.
      const v = 3.26;
      const n = 2048;
      const { particles } = run(n, hz, v);
      const apex = M.heronDropletApex(v);
      const flightS = (2 * v) / M.PHYSICAL_CONSTANTS.G;
      let flying = 0, rising = 0, aboveNozzle = 0;
      const vUp = v / M.HERON_CONSTANTS.METRES_PER_SCENE_UNIT;
      // Time since launch, from the vertical speed: vy = v − g·t.
      const ages = new Array(8).fill(0);
      const heights = new Set();
      for (let i = 0; i < n; i++) {
        if (!inFlight(particles, i)) continue;
        flying++;
        const vy = particles[i * 8 + 5];
        if (vy > 0) rising++;
        // Past 2v/g it is below the nozzle, on its way down to the basin: not binned.
        const age = (vUp - vy) / G_SCENE();
        if (age < flightS) { ages[Math.max(0, Math.floor((age / flightS) * 8))]++; aboveNozzle++; }
        heights.add(Math.round(particles[i * 8 + 1] * 200));
      }
      // Most are in the air (mean wait is a quarter of a flight)…
      assert.ok(flying > 0.6 * n && flying < 0.95 * n, `${flying} of ${n} in flight`);
      // …as many going up as coming down…
      assert.ok(rising > 0.4 * flying && rising < 0.6 * flying, `${rising} of ${flying} rising`);
      // …evenly along the flight: every eighth of it holds its share…
      for (const [k, count] of ages.entries()) {
        assert.ok(count > 0.7 * (aboveNozzle / 8) && count < 1.3 * (aboveNozzle / 8), `eighth ${k} of the flight holds ${count} of ${aboveNozzle}`);
      }
      // …and not in one band per frame.
      assert.ok(heights.size > 60, `droplets at only ${heights.size} distinct heights (apex ${apex.toFixed(2)})`);
    });
  }

  it('a stopped clock releases nothing, and the same clock gives the same droplets', () => {
    const n = 256;
    const a = run(n, 60, 2.5, { steadyS: 2 }).particles;
    const b = run(n, 60, 2.5, { steadyS: 2 }).particles;
    assert.deepEqual(a, b);
    const frozen = a.slice();
    for (let k = 0; k < 10; k++) M.stepParticles(frozen, { time: 9, mode: 1, particleCount: n, dt: 0, heronVExit: 2.5, heronNozzleY: nozzleY, simClock: 9 });
    assert.deepEqual(frozen, a);
  });
});
