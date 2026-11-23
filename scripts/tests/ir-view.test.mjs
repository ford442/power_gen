/**
 * The IR view (`?thermal=1`, docs/FLUIDS.md → IR view): the ramp and its
 * three copies, the scale, the two lumped bodies and where each bench's
 * temperature comes from, the legend's words, and that every mesh shader
 * carries the switch.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

const M = await bundleTs({
  contents: `
    export * from './src/thermal/ir-view.ts';
    export { irLegendText, irLegendGradient } from './src/thermal/ir-legend.ts';
    export { buildPeltierMesh, peltierMeshTemps } from './src/devices/core/peltier-mesh.ts';
    export { PULSE_COIL_CORE, DROP_TUBE, PELTIER } from './generated/physics-constants.ts';
    export { LAB_CONFIG_FIELDS } from './generated/lab-config.ts';
  `,
  sourcefile: 'ir-view-entry.ts'
});
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const triples = (text) => [...text.matchAll(/vec3f?\(([-\d.]+), ([-\d.]+), ([-\d.]+)\)/g)].map((m) => m.slice(1, 4).map(Number));

describe('ir view: one ramp, three copies', () => {
  it('WGSL and both GLSL shaders carry the TS ramp, point for point', () => {
    const wgsl = /const IR_RAMP = array<vec3f, 6>\(([\s\S]*?)\);/.exec(read('src/shaders/common/ir-view.wgsl'))[1];
    assert.deepEqual(triples(wgsl), M.IR_RAMP.map((c) => [...c]));
    const glsl = [...read('src/renderers/webgl2/shaders.js').matchAll(/const vec3 IR_RAMP\[6\] = vec3\[6\]\(([\s\S]*?)\);/g)];
    assert.equal(glsl.length, 2, 'the mesh and the roller fragment shaders');
    for (const g of glsl) assert.deepEqual(triples(g[1]), M.IR_RAMP.map((c) => [...c]));
  });

  it('runs cold to hot, brighter all the way, through its control points', () => {
    assert.deepEqual(M.irRamp(0), [...M.IR_RAMP[0]]);
    assert.deepEqual(M.irRamp(1), [...M.IR_RAMP[5]]);
    assert.deepEqual(M.irRamp(0.4), [...M.IR_RAMP[2]]);
    const mid = M.irRamp(0.5);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(mid[k] - 0.5 * (M.IR_RAMP[2][k] + M.IR_RAMP[3][k])) < 1e-12);
    let last = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const [r, g, b] = M.irRamp(t);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      assert.ok(luma > last, `luminance falls at t = ${t}`);
      last = luma;
    }
    assert.deepEqual(M.irRamp(-3), M.irRamp(0));
    assert.deepEqual(M.irRamp(Number.NaN), M.irRamp(0));
    assert.deepEqual(M.irRamp(7), M.irRamp(1));
  });

  it('the scale is fixed, −40 … +80 °C, with the room near the middle', () => {
    assert.equal(M.irNormalise(M.IR_SCALE.minK), 0);
    assert.equal(M.irNormalise(M.IR_SCALE.maxK), 1);
    assert.equal(M.irNormalise(100), 0);
    assert.equal(M.irNormalise(900), 1);
    assert.ok(Math.abs(M.irNormalise(M.IR_AMBIENT_K) - 0.5) < 0.01);
    assert.equal(M.irNormalise(Number.NaN), M.irNormalise(M.IR_AMBIENT_K));
    assert.equal(M.IR_AMBIENT_K, M.PELTIER.ambientK);
  });

  it('the code a renderer is told: off, a temperature, or "the instances carry it"', () => {
    assert.equal(M.IR_CODE_OFF, 0);
    assert.equal(M.irCode(M.IR_SCALE.minK), 1);
    assert.equal(M.irCode(M.IR_SCALE.maxK), 2);
    assert.ok(M.IR_CODE_INSTANCE > 2.5, 'the shaders split at 2.5');
  });
});

describe('ir view: the lumped bodies come from the catalog, not from taste', () => {
  it('pulse coil: 13.6 m of wire whose cross-section gives 0.18 Ω — 0.15 kg of copper', () => {
    const w = M.pulseCoilWinding();
    assert.ok(Math.abs(w.wireM - 48 * 2 * Math.PI * 0.045) < 1e-9);
    assert.ok(w.massKg > 0.14 && w.massKg < 0.17, `${w.massKg} kg`);
    assert.ok(Math.abs(w.capacityJK - w.massKg * 385) < 1e-9);
    assert.ok(Math.abs(w.lossWK - 10 * 2 * Math.PI * 0.045 * 0.09) < 1e-9);
    // Minutes to settle.
    assert.ok(w.capacityJK / w.lossWK > 120 && w.capacityJK / w.lossWK < 600);
  });

  it('drop tube: a third of a kilogram of copper; a whole drop warms it by tenths of a millikelvin', () => {
    const t = M.dropTubeWall();
    assert.ok(t.massKg > 0.3 && t.massKg < 0.37, `${t.massKg} kg`);
    const magnetKg = M.DROP_TUBE.magnetDensityKgM3 * Math.PI * M.DROP_TUBE.magnetRadiusM ** 2 * M.DROP_TUBE.magnetLengthM;
    const dropJ = magnetKg * 9.80665 * M.DROP_TUBE.tubeLengthM;
    const riseK = dropJ / t.capacityJK;
    assert.ok(dropJ > 0.03 && dropJ < 0.07, `${dropJ} J a drop`);
    assert.ok(riseK > 1e-4 && riseK < 1e-3, `${riseK} K a drop`);
  });

  it('the step is exact: any step size, and it settles at the room plus P/h', () => {
    const body = { capacityJK: 60, lossWK: 0.25 };
    const settled = M.IR_AMBIENT_K + 5 / 0.25;
    assert.ok(Math.abs(M.stepLumped(M.IR_AMBIENT_K, 5, 1e9, body) - settled) < 1e-9);
    const whole = M.stepLumped(300, 5, 30, body);
    const halves = M.stepLumped(M.stepLumped(300, 5, 15, body), 5, 15, body);
    assert.ok(Math.abs(whole - halves) < 1e-10);
    assert.ok(Math.abs(whole - (settled + (300 - settled) * Math.exp(-0.25 * 30 / 60))) < 1e-10);
    assert.equal(M.stepLumped(300, 5, 0, body), 300);
    assert.equal(M.stepLumped(300, 5, -4, body), 300);
    // No power: back to the room. Bad inputs: the room, no heat.
    assert.ok(Math.abs(M.stepLumped(350, 0, 1e9, body) - M.IR_AMBIENT_K) < 1e-9);
    assert.ok(Math.abs(M.stepLumped(Number.NaN, Number.NaN, 1, body) - M.IR_AMBIENT_K) < 1e-12);
    assert.equal(M.stepLumped(300, -9, 10, body), M.stepLumped(300, 0, 10, body));
  });
});

describe('ir view: where each bench\'s temperature comes from', () => {
  it('pulse coil: I²R into the winding', () => {
    const s = { pulseCoilCurrentA: 10 };
    assert.ok(Math.abs(M.irHeatingW('pulse-coil', s) - 100 * M.PULSE_COIL_CORE.rOhm) < 1e-12);
    M.stepIrView('pulse-coil', s, 60);
    assert.ok(s._irBodyK > M.IR_AMBIENT_K + 5 && s._irBodyK < M.IR_AMBIENT_K + 25, `${s._irBodyK} K after a minute at 10 A`);
    assert.equal(M.irDeviceTemperatureK('pulse-coil', s), s._irBodyK);
    assert.ok(M.irDeviceCode('pulse-coil', s) > M.irCode(M.IR_AMBIENT_K));
    const cold = {};
    M.stepIrView('pulse-coil', cold, 5);
    assert.equal(cold._irBodyK, M.IR_AMBIENT_K);
  });

  it('drop tube: F·v into the wall, and it comes to nothing you could see', () => {
    const s = { dropTubeDragN: 0.083, dropTubeVMps: 0.5 };
    assert.ok(Math.abs(M.irHeatingW('drop-tube', s) - 0.0415) < 1e-12);
    for (let i = 0; i < 60; i++) M.stepIrView('drop-tube', s, 1 / 60);
    const riseK = s._irBodyK - M.IR_AMBIENT_K;
    assert.ok(riseK > 0 && riseK < 1e-3, `${riseK} K after a second of braking`);
    assert.ok(Math.abs(M.irDeviceCode('drop-tube', s) - M.irCode(M.IR_AMBIENT_K)) < 1e-5);
    assert.equal(M.irHeatingW('drop-tube', { dropTubeDragN: -0.1, dropTubeVMps: 0.5 }), 0.05, 'dissipation has no sign');
  });

  it('Peltier: the plant\'s own nodes, body by body', () => {
    assert.equal(M.irDeviceCode('peltier', {}), M.IR_CODE_INSTANCE);
    const temps = { sinkK: 318, moduleK: 290, blockK: 262 };
    const ir = M.buildPeltierMesh(temps, { ir: true }).cylinders();
    const plain = M.buildPeltierMesh(temps).cylinders();
    [temps.sinkK, temps.moduleK, temps.blockK].forEach((k, i) => {
      const want = M.irColour(k);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(ir[i][8 + c] - want[c]) < 1e-12);
      assert.equal(ir[i][11], 0, 'no glow in the IR view');
      // Same bodies, same places, same materials.
      assert.deepEqual(ir[i].slice(0, 8), plain[i].slice(0, 8));
    });
    assert.notDeepEqual(ir[0].slice(8, 11), plain[0].slice(8, 11));
    assert.equal(M.irDeviceTemperatureK('peltier', { peltierHotK: 320, peltierColdK: 260 }), 290);
  });

  it('every other bench is the room: the view does not invent a model', () => {
    for (const id of ['seg', 'heron', 'kelvin', 'solar', 'mhd', 'maglev', 'transformer', 'hall']) {
      const s = { mhdCurrent: 300, pulseCoilCurrentA: 99 };
      assert.equal(M.irHeatingW(id, s), null);
      M.stepIrView(id, s, 100);
      assert.equal(s._irBodyK, undefined);
      assert.equal(M.irDeviceTemperatureK(id, s), M.IR_AMBIENT_K);
      assert.equal(M.irHasModel(id), false);
    }
    for (const id of ['peltier', 'pulse-coil', 'drop-tube']) assert.equal(M.irHasModel(id), true);
    M.stepIrView('pulse-coil', null, 1);
  });
});

describe('ir view: the legend and the switch', () => {
  it('says where the focused bench\'s temperature comes from, in units that read', () => {
    assert.match(M.irLegendText('overview', null), /every other bench is at the room's \+20 °C/);
    assert.match(M.irLegendText('peltier', { peltierNodesK: [262, 270, 318] }), /cold block −11 °C, heat sink \+45 °C/);
    assert.match(M.irLegendText('pulse-coil', { _irBodyK: M.IR_AMBIENT_K + 3.214 }), /3\.21 K above the room/);
    assert.match(M.irLegendText('drop-tube', { _irBodyK: M.IR_AMBIENT_K + 0.0004 }), /0\.4 mK above the room/);
    assert.match(M.irLegendText('drop-tube', {}), /below what a camera resolves/);
    assert.match(M.irLegendText('kelvin', {}), /no thermal model/);
    for (const v of ['overview', 'peltier', 'pulse-coil', 'drop-tube', 'seg']) assert.match(M.irLegendText(v, {}), /simulated, not thermography$/);
    assert.match(M.irLegendGradient(), /^linear-gradient\(to right, rgb\(0, 0, \d+\) 0%, .* 100%\)$/);
  });

  it('`thermal` is a LabConfig row, off by default', () => {
    const row = M.LAB_CONFIG_FIELDS.find((f) => f.key === 'thermal');
    assert.ok(row);
    assert.equal(row.type, 'bool');
    assert.equal(row.default, false);
  });

  it('every mesh shader\'s material block ends in the IR view\'s vec4, and reads it', () => {
    for (const file of ['roller-frag', 'seg-enhanced-frag', 'coil-frag', 'core-frag', 'particle-frag']) {
      const src = read(`src/shaders/passes/${file}.wgsl`);
      const block = /struct \w*MaterialUniforms \{([\s\S]*?)\n\s*\}/.exec(src)[1];
      const fields = [...block.matchAll(/^\s*(\w+): (\w+)/gm)].map((m) => `${m[1]}:${m[2]}`);
      assert.equal(fields.at(-1), 'thermal:vec4f', `${file}: ${fields.join(', ')}`);
      // Two vec3 + f32 pairs before it: the code sits at byte 32 of a 48-byte block.
      assert.equal(fields.length, 5, file);
      assert.match(src, /material\.thermal\.x/, `${file} never reads the code`);
    }
    const host = read('src/device-uniforms.ts');
    assert.match(host, /MATERIAL_THERMAL_OFFSET = 32/);
    assert.match(host, /MATERIAL_BLOCK_BYTES = 48/);
  });
});
