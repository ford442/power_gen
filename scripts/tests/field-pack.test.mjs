/**
 * Field-volume pass policy, uniform layouts, particles and probe keys
 * (ADR-0017, #255). The kernels and the WGSL golden live in
 * field-volume.test.mjs; this file covers what the WebGPU pass packs and
 * what the experiment layer reads.
 *
 *   1. every packed uniform matches its WGSL struct (size and field order)
 *   2. gate: low / critical tier, overview and benches without a field row
 *      never open; sweep plan time-slices 128³ only
 *   3. particle plan: protons resolve their gyration, electrons fall back to
 *      guiding-centre steps; Boris keeps |v| and gives the E×B drift
 *   4. probe record keys / knobs: headless, from plant state, linear in drive
 *   5. slice-plane ray hit for the probe click
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let m;
before(async () => {
  m = await bundleTs({
    contents: `
      export * from './src/physics/field-pack.ts';
      export * from './src/physics/field-particles.ts';
      export * from './src/physics/field-probe.ts';
      export { FIELD_SOURCE_CATALOG } from './src/physics/field-bench.ts';
      export { FIELD_VOLUME_PARAMS_BYTES } from './src/physics/field-volume.ts';
      export { isRecordKey, recordKeyDevice, readRecordKey } from './src/experiments/readers.ts';
      export { knobSpec } from './src/experiments/knobs.ts';
    `,
    sourcefile: 'field-pack-entry.ts'
  });
});

/** Fields of a WGSL struct as [name, type]. */
function structFields(file, name) {
  const body = read(file).match(new RegExp(`struct ${name} \\{([^}]*)\\}`))?.[1];
  assert.ok(body, `${file}: struct ${name}`);
  return [...body.matchAll(/(\w+)\s*:\s*([\w<>]+)/g)].map((x) => [x[1], x[2]]);
}

const SIZES = { vec4f: 16, f32: 4 };
const bytes = (fields) => fields.reduce((s, [, t]) => s + SIZES[t], 0);

describe('1. uniform layouts match their WGSL structs', () => {
  const cases = [
    ['src/shaders/passes/field-streamlines.wgsl', 'StreamParams', 'FIELD_STREAM_PARAMS_BYTES'],
    ['src/shaders/passes/field-lines-vert.wgsl', 'FieldLineParams', 'FIELD_LINE_STYLE_BYTES'],
    ['src/shaders/passes/field-slice.wgsl', 'SliceParams', 'FIELD_SLICE_PARAMS_BYTES'],
    ['src/shaders/passes/field-iso.wgsl', 'IsoParams', 'FIELD_ISO_PARAMS_BYTES'],
    ['src/shaders/passes/field-particles.wgsl', 'ParticleParams', 'FIELD_PARTICLE_PARAMS_BYTES'],
    ['src/shaders/passes/field-probe.wgsl', 'FieldProbeParams', 'FIELD_PROBE_INFO_BYTES'],
    ['src/shaders/passes/field-particles.wgsl', 'Particle', 'FIELD_PARTICLE_BYTES'],
    ['src/shaders/common/field-line-segment.wgsl', 'FieldLineSegment', 'FIELD_LINE_SEGMENT_BYTES']
  ];
  for (const [file, struct, constant] of cases) {
    it(`${struct} = ${constant}`, () => {
      assert.equal(bytes(structFields(file, struct)), m[constant]);
    });
  }

  const bounds = [[-1, -2, -3], [1, 2, 3]];
  it('packers fill exactly their struct', () => {
    assert.equal(m.packStreamParams(bounds, 10, 5, 1).length * 4, m.FIELD_STREAM_PARAMS_BYTES);
    assert.equal(m.packLineStyle(5, false).length * 4, m.FIELD_LINE_STYLE_BYTES);
    assert.equal(m.packSliceParams(bounds, 'y', 0.5, 'lic', [0, 0, 0], 5, 1).length * 4, m.FIELD_SLICE_PARAMS_BYTES);
    assert.equal(m.packIsoParams(bounds, [1, 2], [0, 0, 0], 96).length * 4, m.FIELD_ISO_PARAMS_BYTES);
    const plan = m.fieldParticlePlan('proton', 0.1, 1);
    assert.equal(m.packParticleParams(bounds, 0.1, plan, [0, 0, 0], [0, 0, 0], 256, 12, 0, 1000).length * 4, m.FIELD_PARTICLE_PARAMS_BYTES);
  });
  it('slice / iso carry the axis, mode and sorted levels where the shader reads them', () => {
    const s = m.packSliceParams(bounds, 'z', 1.7, 'lic', [4, 5, 6], 10, 2);
    assert.equal(s[3], 2); // boundsMin.w = axis
    assert.equal(s[7], 1); // offset clamped
    assert.deepEqual([...s.slice(8, 12)], [4, 5, 6, 2]); // devicePos, mode
    assert.ok(s[12] < 10 && s[13] > 10); // ramp brackets the reference
    const iso = m.packIsoParams(bounds, [8, 0, 2, 4, 1, 16], [0, 0, 0], 96);
    assert.equal(iso[3], 4);
    assert.deepEqual([...iso.slice(12)], [1, 2, 4, 8]);
  });
  it('slice mode order matches field-slice.wgsl (0 heat, 1 arrows, 2 LIC)', () => {
    assert.deepEqual([...m.FIELD_SLICE_MODES], ['heat', 'arrows', 'lic']);
    assert.match(read('src/shaders/passes/field-slice.wgsl'), /mode \(0 heat, 1 arrows, 2 LIC\)/);
  });
});

describe('2. gate and sweep plan', () => {
  const open = (o) => m.fieldVolumeGateOpen({ enabled: true, ready: true, currentView: 'maglev', qualityTier: 'medium', hasField: true, ...o });
  it('opens in focus at medium and up', () => {
    assert.ok(open({}));
    assert.ok(open({ qualityTier: 'high' }));
    assert.ok(open({ qualityTier: 'ultra' }));
  });
  it('low / critical tier, overview, no field row, kill switch, not ready: closed', () => {
    assert.ok(!open({ qualityTier: 'low' }));
    assert.ok(!open({ qualityTier: 'critical' }));
    assert.ok(!open({ currentView: 'overview' }));
    assert.ok(!open({ hasField: false }));
    assert.ok(!open({ enabled: false }));
    assert.ok(!open({ ready: false }));
  });
  it('low tier spawns no particles; high spawns more than medium', () => {
    assert.equal(m.fieldParticleCount('low'), 0);
    assert.ok(m.fieldParticleCount('high') > m.fieldParticleCount('medium'));
  });
  it('64³ refreshes in one frame; 128³ in four slabs that cover every z-brick once', () => {
    const p64 = m.fieldSweepPlan(64);
    assert.equal(p64.framesPerSweep, 1);
    assert.equal(p64.bricksPerFrame, p64.zBricks);
    const p128 = m.fieldSweepPlan(128);
    assert.equal(p128.framesPerSweep, 4);
    assert.equal(p128.bricksPerFrame * p128.framesPerSweep, p128.zBricks);
    assert.ok(p128.minIntervalS >= p64.minIntervalS);
  });
});

describe('3. particles', () => {
  it('protons and α at bench fields resolve their gyration', () => {
    for (const s of ['proton', 'alpha']) {
      const p = m.fieldParticlePlan(s, 0.1, 3);
      assert.ok(p.resolved, s);
      assert.ok(p.omegaDt <= (2 * Math.PI) / m.FIELD_PUSHES_PER_GYRATION + 1e-12, `${s} ω·dt ${p.omegaDt}`);
      assert.ok(p.pushesPerFrame <= m.FIELD_MAX_PUSHES);
      assert.ok(!p.relativisticCap);
    }
  });
  it('electrons hit the 5 % c cap and step their guiding centre (gyration aliased, said so)', () => {
    const e = m.fieldParticlePlan('electron', 0.1, 3);
    assert.ok(e.relativisticCap);
    assert.ok(!e.resolved);
    assert.ok(e.v0 <= 0.05 * m.FIELD_SPEED_OF_LIGHT + 1e-6);
    assert.ok(e.gyroRadiusM < 1e-3, `r_g ${e.gyroRadiusM}`);
    assert.equal(e.pushesPerFrame, m.FIELD_GUIDING_PUSHES);
  });
  it('each frame moves a particle about FIELD_STEP_FRACTION of the bench', () => {
    for (const s of ['electron', 'proton', 'alpha']) {
      const p = m.fieldParticlePlan(s, 0.05, 2);
      const step = p.v0 * p.dt * p.pushesPerFrame;
      assert.ok(Math.abs(step - m.FIELD_STEP_FRACTION * 2) < 1e-9, `${s} ${step}`);
    }
  });
  it('a dead bench (B ≈ 0) still gets a finite plan', () => {
    const p = m.fieldParticlePlan('proton', 0, 1);
    assert.ok(Number.isFinite(p.dt) && p.dt > 0 && Number.isFinite(p.v0));
  });
  it('Boris keeps |v| in pure B for any ω·dt and closes a resolved orbit', () => {
    const B = [0, 0, 0.1];
    for (const omegaDt of [0.05, 3]) {
      const dt = omegaDt / (m.FIELD_SPECIES.proton.qOverM * 0.1);
      let v = [1e5, 0, 0];
      for (let i = 0; i < 1000; i++) v = m.borisPush(v, B, [0, 0, 0], m.FIELD_SPECIES.proton.qOverM, dt);
      assert.ok(Math.abs(Math.hypot(...v) - 1e5) < 1e-6 * 1e5, `ω·dt ${omegaDt}`);
    }
  });
  it('E × B drift = E/B, also for an aliased (ω·dt ≫ 1) electron step', () => {
    const B = [0, 0, 0.05], E = [200, 0, 0]; // drift along E × B = −y, |E|/|B| = 4000 m/s
    for (const [s, omegaDt] of [['proton', 0.05], ['electron', 4]]) {
      const qm = m.FIELD_SPECIES[s].qOverM;
      const dt = omegaDt / Math.abs(qm * 0.05);
      let v = [0, 0, 0], y = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        v = m.borisPush(v, B, E, qm, dt);
        y += v[1] * dt;
      }
      const drift = y / (n * dt);
      assert.ok(Math.abs(drift + 4000) < 0.02 * 4000, `${s}: drift ${drift}`);
    }
  });
});

describe('4. probe record keys and knobs (headless, plant state only)', () => {
  it('every field bench has probe keys; drive keys name their group', () => {
    for (const id of Object.keys(m.FIELD_SOURCE_CATALOG)) {
      for (const c of ['Bx', 'By', 'Bz', 'B']) {
        const k = `${id}.field.probe.${c}`;
        assert.ok(m.isRecordKey(k), k);
        assert.equal(m.recordKeyDevice(k), id);
      }
      for (const a of ['x', 'y', 'z']) assert.ok(m.knobSpec(`${id}.field.probe.${a}`), `${id} knob ${a}`);
    }
    assert.ok(m.isRecordKey('pulse-coil.field.drive.coil'));
    assert.ok(m.isRecordKey('transformer.field.drive.primary') || [...m.FIELD_RECORD_KEYS.keys()].some((k) => k.startsWith('transformer.field.drive.')));
    assert.ok(!m.isRecordKey('pulse-coil.field.probe.Bq'));
  });
  it('pulse coil: By at the centre = μ0·N·I/√(L² + 4a²), exactly linear in the coil current', () => {
    const view = (I) => ({ devices: { 'pulse-coil': { physicsState: { pulseCoilCurrent: I } } }, operator: { targetDrive: 0 }, segTelemetry: () => null });
    const a = 0.8 * 0.05625, L = 2 * 1.37 * 0.05625;
    const k = (1.25663706212e-6 * 48) / Math.hypot(L, 2 * a);
    for (const I of [-40, -1, 0.5, 12, 80]) {
      const v = view(I);
      const By = m.readRecordKey(v, 'pulse-coil.field.probe.By');
      assert.ok(Math.abs(By - k * I) <= 1e-6 * Math.abs(k * I) + 1e-15, `I ${I}: ${By} vs ${k * I}`);
      assert.equal(m.readRecordKey(v, 'pulse-coil.field.drive.coil'), I);
      assert.ok(Math.abs(m.readRecordKey(v, 'pulse-coil.field.probe.B') - Math.abs(k * I)) < 1e-6 * Math.abs(k * I) + 1e-15);
    }
  });
  it('the probe knobs move the probe (clamped to the bounds) without touching the state fields', () => {
    const state = { pulseCoilCurrent: 10 };
    const t = { devices: { 'pulse-coil': { physicsState: state } }, operator: { targetDrive: 0 }, segTelemetry: () => null };
    const keysBefore = Object.keys(state).join();
    const centre = m.readRecordKey(t, 'pulse-coil.field.probe.By');
    assert.ok(m.knobSpec('pulse-coil.field.probe.y').write(t, 1.535)); // the coil's end face
    assert.equal(m.knobSpec('pulse-coil.field.probe.y').read(t), 1.535);
    const end = m.readRecordKey(t, 'pulse-coil.field.probe.By');
    // End face of a finite solenoid: μ0·N·I / (2√(L² + a²)).
    const a = 0.8 * 0.05625, L = 2 * 1.37 * 0.05625;
    const expectEnd = (1.25663706212e-6 * 48 * 10) / (2 * Math.hypot(L, a));
    assert.ok(Math.abs(end - expectEnd) < 1e-5 * expectEnd, `${end} vs ${expectEnd}`);
    assert.ok(end < centre);
    m.knobSpec('pulse-coil.field.probe.y').write(t, 99);
    assert.equal(m.knobSpec('pulse-coil.field.probe.y').read(t), m.FIELD_SOURCE_CATALOG['pulse-coil'].bounds[1][1]);
    assert.equal(Object.keys(state).join(), keysBefore);
  });
  it('SEG reads NaN headless (no roller layout), not a fake zero', () => {
    const t = { devices: { seg: { physicsState: {} } }, operator: { targetDrive: 0 }, segTelemetry: () => null };
    assert.ok(Number.isNaN(m.readRecordKey(t, 'seg.field.probe.B')));
  });
});

describe('5. probe click: ray × slice plane', () => {
  const bounds = [[-1, -1, -1], [1, 1, 1]];
  it('hits the plane at the offset, device-local', () => {
    const p = m.raySliceHit([20, 0.2, 5.3], [-1, 0, 0], bounds, 'x', 0.75, [10, 0, 5]);
    assert.ok(p);
    assert.ok(Math.abs(p[0] - 0.5) < 1e-12 && Math.abs(p[1] - 0.2) < 1e-12 && Math.abs(p[2] - 0.3) < 1e-12);
  });
  it('misses behind the ray, parallel to the plane, or outside the bounds', () => {
    assert.equal(m.raySliceHit([0, 5, 0], [0, 1, 0], bounds, 'y', 0.5, [0, 0, 0]), null);
    assert.equal(m.raySliceHit([0, 5, 0], [1, 0, 0], bounds, 'y', 0.5, [0, 0, 0]), null);
    assert.equal(m.raySliceHit([3, 5, 0], [0, -1, 0], bounds, 'y', 0.5, [0, 0, 0]), null);
  });
});

describe('6. colour ramp: TS twin of field-colormap.wgsl', () => {
  it('same five stops, same log mapping', async () => {
    const c = await bundleTs({ contents: `export * from './src/physics/field-colormap.ts';`, sourcefile: 'cmap.ts' });
    const wgsl = read('src/shaders/common/field-colormap.wgsl');
    const stops = [...wgsl.matchAll(/let c\d = vec3f\(([^)]*)\)/g)].map((x) => x[1].split(',').map(Number));
    assert.deepEqual(stops, c.FIELD_COLORMAP_STOPS.map((s) => [...s]));
    assert.deepEqual(c.fieldColormap(0), [...c.FIELD_COLORMAP_STOPS[0]]);
    assert.deepEqual(c.fieldColormap(1), [...c.FIELD_COLORMAP_STOPS[4]]);
    assert.ok(Math.abs(c.fieldColorT(10, 1, 100) - 0.5) < 1e-12);
  });
});
