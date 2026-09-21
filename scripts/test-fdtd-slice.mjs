#!/usr/bin/env node
/**
 * test-fdtd-slice.mjs — contracts and numerics for the 2D TM_z wave slice (ADR-0010).
 *
 * naga validates each WGSL module on its own; it cannot see that the CPU packs
 * the uniform the shader reads, or that the sponge still absorbs. This does:
 *
 *   1. FdtdParams / FdtdSliceParams byte sizes and source capacity agree
 *      between src/physics/fdtd-tmz.ts and the WGSL.
 *   2. Workgroup size and the cubic loss profile match the CPU kernel.
 *   3. packFdtdParams writes the documented layout (and is NaN-safe).
 *   4. The gate stays shut outside pulse-coil focus at `high`.
 *   5. The CPU reference stays finite and bounded under a coil-style drive.
 *   6. A pulse leaving the grid comes back from the sponge at < 1 % amplitude.
 *   7. The pulse-coil winding set fits the uniform's source array.
 *
 * Materials (ADR-0012):
 *   8. buildFdtdMaterialMap stamps rects/disks, leaves vacuum exactly (1, 0),
 *      lets later regions win, and clamps nonsense inputs.
 *   9. The material flag round-trips through packFdtdParams without changing
 *      the uniform's size, and the WGSL declares the same flag bit.
 *  10. A material grid stays finite and bounded under the same hard drive as
 *      the vacuum one, and μ_r actually **slows** the front rather than just
 *      tinting it (the claim the picture makes).
 *  11. σ cells exclude the field: energy inside a conductor is far below the
 *      energy just outside it.
 *  12. With a vacuum map installed, `step()` matches the vacuum kernel bit for
 *      bit — materials cannot silently change the ADR-0010 result.
 *  13. The WebGL2 micro-grid runs the same kernel at a sane cost and its
 *      colour mapping brackets correctly.
 *  14. Drive sources: coil current and transformer flux are both NaN-safe and
 *      clamped, and the parser defaults to the coil.
 *
 * Usage: node scripts/test-fdtd-slice.mjs   (exit 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

async function importTs(rel) {
  const { code } = await esbuild.transform(read(rel), { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

/**
 * Stub Vite's `?raw` imports (shader text) and bare `.wgsl` so a module graph
 * reaching into app code still bundles under plain esbuild. Nothing under test
 * reads shader text at import time — the WGSL is checked as *text* above.
 */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

/** Bundle (rather than transform) so a module's relative imports resolve. */
async function importTsBundle(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    plugins: [viteRawStub]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const m = await importTs('src/physics/fdtd-tmz.ts');
const paramsWgsl = read('src/shaders/common/fdtd-params.wgsl');
const computeWgsl = read('src/shaders/passes/fdtd-tmz-compute.wgsl');
const sliceWgsl = read('src/shaders/passes/fdtd-slice.wgsl');

/** Byte size of a WGSL struct made of u32/f32/vec3f scalars plus an optional trailing array<vec4f, N>. */
function structBytes(src, name) {
  const body = src.match(new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (!body) return { bytes: -1, arrayLen: -1 };
  let bytes = 0;
  let arrayLen = 0;
  for (const [, type] of body.matchAll(/^[ \t]*\w+[ \t]*:[ \t]*(.+?),[ \t]*$/gm)) {
    const t = type.trim();
    if (t === 'u32' || t === 'f32') bytes += 4;
    else if (t === 'vec3f') bytes += 12;
    else if (/^array<vec4f,\s*(\d+)>$/.test(t)) {
      arrayLen = Number(t.match(/,\s*(\d+)>$/)[1]);
      bytes = Math.ceil(bytes / 16) * 16 + arrayLen * 16;
    } else return { bytes: -1, arrayLen: -1, unknown: t };
  }
  return { bytes: Math.ceil(bytes / 16) * 16, arrayLen };
}

// ── 1. Uniform layouts ─────────────────────────────────────────────────────
{
  const p = structBytes(paramsWgsl, 'FdtdParams');
  check(`FdtdParams ${p.bytes} B`, p.bytes === m.FDTD_PARAMS_BYTES,
    `WGSL struct is ${p.bytes} B, FDTD_PARAMS_BYTES = ${m.FDTD_PARAMS_BYTES}`);
  check(`FdtdParams sources[${p.arrayLen}]`, p.arrayLen === m.FDTD_MAX_SOURCES,
    `WGSL array holds ${p.arrayLen}, FDTD_MAX_SOURCES = ${m.FDTD_MAX_SOURCES}`);
  const constLen = Number(paramsWgsl.match(/const FDTD_MAX_SOURCES: u32 = (\d+)u;/)?.[1]);
  check('WGSL FDTD_MAX_SOURCES const', constLen === m.FDTD_MAX_SOURCES,
    `WGSL const is ${constLen}, TS is ${m.FDTD_MAX_SOURCES}`);

  const s = structBytes(sliceWgsl, 'FdtdSliceParams');
  check(`FdtdSliceParams ${s.bytes} B`, s.bytes === m.FDTD_SLICE_PARAMS_BYTES,
    `WGSL struct is ${s.bytes} B, FDTD_SLICE_PARAMS_BYTES = ${m.FDTD_SLICE_PARAMS_BYTES}`);
}

// ── 2. Workgroup + loss profile ────────────────────────────────────────────
{
  const sizes = [...computeWgsl.matchAll(/@workgroup_size\((\d+),\s*(\d+)\)/g)];
  check(`compute entry points @workgroup_size(${m.FDTD_WORKGROUP}, ${m.FDTD_WORKGROUP})`,
    sizes.length === 2 && sizes.every((w) => Number(w[1]) === m.FDTD_WORKGROUP && Number(w[2]) === m.FDTD_WORKGROUP),
    `found ${sizes.map((w) => `(${w[1]},${w[2]})`).join(' ') || 'none'}`);
  check('WGSL loss profile is cubic (matches fdtdLossAt)',
    /params\.lossMax \* t \* t \* t/.test(computeWgsl),
    'lossAt in fdtd-tmz-compute.wgsl no longer reads `params.lossMax * t * t * t`');
  check('Courant number below the 2D stability limit',
    m.FDTD_COURANT > 0 && m.FDTD_COURANT < Math.SQRT1_2, `S = ${m.FDTD_COURANT}`);
}

// ── 3. packFdtdParams ──────────────────────────────────────────────────────
{
  const data = m.packFdtdParams([
    { x: 10.5, y: 20.25, amp: 0.75 },
    { x: 1, y: 2, amp: Number.NaN, polarity: -1 }
  ]);
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length);
  check('packFdtdParams length', data.byteLength === m.FDTD_PARAMS_BYTES, `${data.byteLength} B`);
  check('packFdtdParams header', u32[0] === m.FDTD_GRID_N && u32[1] === m.FDTD_PML_CELLS
    && Math.abs(data[2] - m.FDTD_COURANT) < 1e-6 && Math.abs(data[3] - m.FDTD_LOSS_MAX) < 1e-6
    && u32[4] === 2 && Math.abs(data[5] - m.FDTD_SOURCE_RADIUS) < 1e-6,
  `header = ${[u32[0], u32[1], data[2], data[3], u32[4], data[5]].join(', ')}`);
  check('packFdtdParams source 0', data[8] === 10.5 && data[9] === 20.25 && data[10] === 0.75 && data[11] === 1,
    `got ${Array.from(data.slice(8, 12)).join(', ')}`);
  check('packFdtdParams NaN amp → 0, explicit polarity kept', data[14] === 0 && data[15] === -1,
    `got amp ${data[14]}, polarity ${data[15]}`);
  const many = Array.from({ length: 40 }, (_, i) => ({ x: i, y: i, amp: 1 }));
  check('packFdtdParams clamps source count', new Uint32Array(m.packFdtdParams(many).buffer)[4] === m.FDTD_MAX_SOURCES,
    'count exceeded FDTD_MAX_SOURCES');
}

// ── 4. Gate ────────────────────────────────────────────────────────────────
{
  const base = { enabled: true, ready: true, currentView: 'pulse-coil', qualityTier: 'high' };
  const cases = [
    [base, true],
    [{ ...base, qualityTier: 'ultra' }, true],
    [{ ...base, qualityTier: 'medium' }, false],
    [{ ...base, qualityTier: 'low' }, false],
    [{ ...base, currentView: 'overview' }, false],
    [{ ...base, currentView: 'seg' }, false],
    [{ ...base, enabled: false }, false],
    [{ ...base, ready: false }, false]
  ];
  for (const [input, expected] of cases) {
    check(`gate ${JSON.stringify(input)} → ${expected}`, m.fdtdSliceGateOpen(input) === expected,
      `returned ${!expected}`);
  }
}

// ── 5. Stability under a coil-style drive ──────────────────────────────────
{
  const g = new m.FdtdTmzGrid();
  const n = m.FDTD_GRID_N;
  const sources = [];
  for (let k = 0; k < 6; k++) {
    const y = 80 + k * 20;
    sources.push({ x: 72, y, amp: 1 }, { x: 183, y, amp: -1 });
  }
  let drive = 0;
  let maxAbs = 0;
  let finite = true;
  const scan = () => {
    for (let i = 0; i < n * n; i++) {
      const v = Math.max(Math.abs(g.ez[i]), Math.abs(g.hx[i]), Math.abs(g.hy[i]));
      if (!Number.isFinite(v)) { finite = false; return; }
      maxAbs = Math.max(maxAbs, v);
    }
  };
  // Full-scale hold, hard reversal, release — scanned at each transition.
  for (let frame = 0; frame < 250; frame++) {
    const target = frame < 120 ? 1.5 : (frame < 160 ? -1.5 : 0);
    drive += (target - drive) * (1 - Math.exp(-1 / 4));
    g.setSources(sources.map((s) => ({ ...s, amp: s.amp * drive })));
    for (let k = 0; k < m.FDTD_STEPS_PER_FRAME; k++) g.step();
    if (frame === 119 || frame === 130 || frame === 159 || frame === 249) scan();
  }
  check('CPU kernel finite after 1500 driven steps', finite, 'NaN/Inf in a field');
  check(`CPU kernel bounded (max |field| ${maxAbs.toFixed(3)})`, maxAbs < 5, `max |field| = ${maxAbs}`);
}

// ── 6. Sponge reflection ───────────────────────────────────────────────────
{
  const g = new m.FdtdTmzGrid();
  const n = m.FDTD_GRID_N;
  const c = n / 2 - 0.5;
  const probe = (n / 2 - 1) + (n / 2 - 1 + 60) * n;
  let direct = 0;
  let late = 0;
  // Front reaches the probe ~t=120 and the sponge's outer wall ~t=250; any
  // reflection is back at the probe after ~t=380. The 2D wake alone is
  // ~2e-4 of the direct peak by then (checked on a 1024² grid).
  for (let t = 0; t < 800; t++) {
    const tt = (t - 30) / 8;
    g.setSources([{ x: c, y: c, amp: t < 60 ? -tt * Math.exp(-tt * tt / 2) : 0 }]);
    g.step();
    const v = Math.abs(g.ez[probe]);
    if (t < 300) direct = Math.max(direct, v);
    else if (t > 450) late = Math.max(late, v);
  }
  const ratio = late / direct;
  check(`sponge reflection ${(ratio * 100).toFixed(2)} % of direct`, direct > 0 && ratio < 0.01,
    `late/direct = ${ratio}`);
}

// ── 7. Pulse-coil winding count ────────────────────────────────────────────
{
  const src = read('src/devices/quanta/pulse-coil.ts');
  const ys = src.match(/windingY:\s*\[([^\]]*)\]/)?.[1]?.split(',').filter((v) => v.trim() !== '') ?? [];
  check(`pulse-coil windings ${ys.length} × 2 ≤ ${m.FDTD_MAX_SOURCES}`,
    ys.length > 0 && ys.length * 2 <= m.FDTD_MAX_SOURCES, `${ys.length} turns`);
}

// ── 8. Material map rasterization (ADR-0012) ───────────────────────────────
{
  const cfg = { ...m.FDTD_DEFAULT_CONFIG, n: 32, pmlCells: 4 };
  const C = m.FDTD_MATERIAL_COMPONENTS;
  const at = (map, x, y) => [map[(x + y * cfg.n) * C], map[(x + y * cfg.n) * C + 1]];

  const vacuum = m.buildFdtdMaterialMap([], cfg);
  check('empty region list is exactly vacuum', m.fdtdMaterialMapIsVacuum(vacuum),
    'an empty map was not vacuum');
  check('material map length', vacuum.length === cfg.n * cfg.n * C, `${vacuum.length} floats`);
  check('vacuum cell is (1, 0)', at(vacuum, 5, 5)[0] === 1 && at(vacuum, 5, 5)[1] === 0,
    at(vacuum, 5, 5).join(','));

  const rect = m.buildFdtdMaterialMap([
    { shape: 'rect', x: 16, y: 16, halfW: 3, halfH: 5, muR: 4 }
  ], cfg);
  check('rect centre is permeable', Math.abs(at(rect, 16, 16)[0] - 0.25) < 1e-6,
    String(at(rect, 16, 16)[0]));
  check('rect respects halfW', at(rect, 20, 16)[0] === 1, `x=20 → ${at(rect, 20, 16)[0]}`);
  check('rect respects halfH', at(rect, 16, 22)[0] === 1, `y=22 → ${at(rect, 16, 22)[0]}`);
  check('a μ_r-only region adds no loss', at(rect, 16, 16)[1] === 0, String(at(rect, 16, 16)[1]));
  check('a μ_r region is not vacuum', !m.fdtdMaterialMapIsVacuum(rect), 'reported vacuum');

  const disk = m.buildFdtdMaterialMap([
    { shape: 'disk', x: 10, y: 10, radius: 3, sigma: 2 }
  ], cfg);
  const expectLoss = m.fdtdSigmaToLoss(2, cfg.courant);
  check('disk centre carries σ loss', Math.abs(at(disk, 10, 10)[1] - expectLoss) < 1e-6,
    `${at(disk, 10, 10)[1]} vs ${expectLoss}`);
  // (13,12) is inside the region's bounding box but 3.6 cells from the centre.
  check('disk is round, not square', at(disk, 13, 12)[1] === 0,
    `box corner at (13,12) → ${at(disk, 13, 12)[1]}`);
  check('disk includes a diagonal cell within the radius', at(disk, 12, 12)[1] > 0,
    `(12,12) is 2.83 cells out but reads ${at(disk, 12, 12)[1]}`);
  check('a σ-only region leaves μ_r = 1', at(disk, 10, 10)[0] === 1, String(at(disk, 10, 10)[0]));

  // Later regions win: a copper turn over the iron armature must read as copper.
  const layered = m.buildFdtdMaterialMap([
    { shape: 'rect', x: 16, y: 16, halfW: 8, halfH: 8, muR: 10 },
    { shape: 'disk', x: 16, y: 16, radius: 2, sigma: 3 }
  ], cfg);
  check('a later region overwrites an earlier one',
    layered[(16 + 16 * cfg.n) * C] === 1 && layered[(16 + 16 * cfg.n) * C + 1] > 0,
    at(layered, 16, 16).join(','));
  check('the earlier region survives outside the later one',
    Math.abs(at(layered, 22, 16)[0] - 0.1) < 1e-6, String(at(layered, 22, 16)[0]));

  // Nonsense inputs must not produce NaN or an unstable amplifier.
  check('μ_r < 1 is clamped to 1', m.fdtdMuToInv(0.2) === 1, String(m.fdtdMuToInv(0.2)));
  check('NaN μ_r → vacuum', m.fdtdMuToInv(Number.NaN) === 1, String(m.fdtdMuToInv(Number.NaN)));
  check('negative σ → no loss', m.fdtdSigmaToLoss(-5) === 0, String(m.fdtdSigmaToLoss(-5)));
  check('NaN σ → no loss', m.fdtdSigmaToLoss(Number.NaN) === 0, String(m.fdtdSigmaToLoss(Number.NaN)));
  const offGrid = m.buildFdtdMaterialMap([
    { shape: 'rect', x: -20, y: -20, halfW: 4, halfH: 4, muR: 9 }
  ], cfg);
  check('a fully off-grid region writes nothing', m.fdtdMaterialMapIsVacuum(offGrid),
    'an off-grid region leaked into the map');

  // The real pulse-coil map, at the real grid size.
  const coilRegions = (await importTsBundle('src/devices/quanta/pulse-coil.ts')).pulseCoilFdtdMaterials();
  check(`pulse-coil regions (${coilRegions.length})`,
    coilRegions.length === 1 + m.FDTD_MAX_SOURCES - 4,
    `${coilRegions.length} regions — expected 1 armature + 12 turns`);
  check('pulse-coil map is not vacuum',
    !m.fdtdMaterialMapIsVacuum(m.buildFdtdMaterialMap(coilRegions)),
    'the pulse-coil material map came out empty');
  check('pulse-coil armature is permeable, turns are conductive',
    coilRegions[0].muR > 1 && coilRegions[0].sigma === undefined
      && coilRegions[1].sigma > 0 && coilRegions[1].muR === undefined,
    JSON.stringify([coilRegions[0], coilRegions[1]]));
  const coilMap = m.buildFdtdMaterialMap(coilRegions);
  let permeableCells = 0;
  let lossyCells = 0;
  for (let i = 0; i < coilMap.length; i += C) {
    if (coilMap[i] < 1) permeableCells += 1;
    if (coilMap[i + 1] > 0) lossyCells += 1;
  }
  check(`pulse-coil map covers cells (μ_r ${permeableCells}, σ ${lossyCells})`,
    permeableCells > 100 && lossyCells > 20,
    `μ_r cells ${permeableCells}, σ cells ${lossyCells} — regions missed the grid`);
}

// ── 9. Material flag in the uniform + WGSL ─────────────────────────────────
{
  const off = m.packFdtdParams([{ x: 1, y: 1, amp: 1 }]);
  const on = m.packFdtdParams([{ x: 1, y: 1, amp: 1 }], m.FDTD_DEFAULT_CONFIG, undefined, { materials: true });
  const flagOf = (d) => new Uint32Array(d.buffer, d.byteOffset, d.length)[6];
  check('materials default to off in the uniform', flagOf(off) === 0, String(flagOf(off)));
  check('material flag sets bit 0', flagOf(on) === m.FDTD_FLAG_MATERIALS, String(flagOf(on)));
  check('the flag did not change the uniform size',
    off.byteLength === m.FDTD_PARAMS_BYTES && on.byteLength === m.FDTD_PARAMS_BYTES,
    `${off.byteLength} / ${on.byteLength} B`);
  const wgslFlag = Number(paramsWgsl.match(/const FDTD_FLAG_MATERIALS: u32 = (\d+)u;/)?.[1]);
  check('WGSL FDTD_FLAG_MATERIALS matches TS', wgslFlag === m.FDTD_FLAG_MATERIALS,
    `WGSL ${wgslFlag}, TS ${m.FDTD_FLAG_MATERIALS}`);
  check('FdtdParams declares materialFlags (not a pad)',
    /materialFlags:\s*u32,/.test(paramsWgsl), 'fdtd-params.wgsl still has _pad0 in slot 6');
  check('both shaders gate the map on the flag',
    /params\.materialFlags & FDTD_FLAG_MATERIALS/.test(computeWgsl)
      && /params\.materialFlags & FDTD_FLAG_MATERIALS/.test(sliceWgsl),
    'a shader reads `materials` without checking the flag');
  check('the compute shader averages 1/μ_r across the H stagger',
    /0\.5 \* \(invMuHere \+ materialAt\(i \+ n\)\.x\)/.test(computeWgsl),
    'updateH no longer averages 1/μ_r between the two Ez nodes');
  check('the E update adds the cell σ loss to the sponge loss',
    /lossAt\(x, y\) \+ materialAt\(i\)\.y/.test(computeWgsl),
    'updateE no longer adds the material loss');
}

// ── 10. Materials: stability + the μ_r claim ───────────────────────────────
{
  const n = 96;
  const cfg = { ...m.FDTD_DEFAULT_CONFIG, n, pmlCells: 12 };
  // A permeable slab covering the right half, so a pulse on the axis crosses
  // into it on one side and stays in vacuum on the other. Nudged half a cell
  // right of centre so the slab starts at x = 49: the source sits at x = 48 and
  // must be in *vacuum*, or "the vacuum side is unchanged" proves nothing.
  const slab = [{
    shape: 'rect', x: n * 0.75 + 0.5, y: n / 2, halfW: n * 0.25 - 0.5, halfH: n / 2, muR: 9
  }];

  const run = (materials) => {
    const g = new m.FdtdTmzGrid(cfg);
    g.setMaterials(materials);
    const c = Math.floor(n / 2);
    let finite = true;
    let maxAbs = 0;
    // Probes the same distance either side of the centre: one in vacuum, one
    // inside the slab.
    const d = 20;
    const probeVac = (c - d) + c * n;
    const probeMat = (c + d) + c * n;
    let firstVac = -1;
    let firstMat = -1;
    for (let t = 0; t < 400; t++) {
      const tt = (t - 20) / 6;
      g.setSources([{ x: c, y: c, amp: t < 50 ? -tt * Math.exp(-tt * tt / 2) : 0 }]);
      g.step();
      if (firstVac < 0 && Math.abs(g.ez[probeVac]) > 2e-3) firstVac = t;
      if (firstMat < 0 && Math.abs(g.ez[probeMat]) > 2e-3) firstMat = t;
      if (t % 40 === 0 || t === 399) {
        for (let i = 0; i < n * n; i++) {
          const v = Math.max(Math.abs(g.ez[i]), Math.abs(g.hx[i]), Math.abs(g.hy[i]));
          if (!Number.isFinite(v)) { finite = false; break; }
          maxAbs = Math.max(maxAbs, v);
        }
      }
    }
    return { finite, maxAbs, firstVac, firstMat, grid: g };
  };

  const vac = run(null);
  const mat = run(slab);
  check('material grid stays finite', mat.finite, 'NaN/Inf with a μ_r slab');
  check(`material grid stays bounded (max |field| ${mat.maxAbs.toFixed(3)})`,
    mat.maxAbs < 5, `max |field| = ${mat.maxAbs}`);
  check('vacuum grid is symmetric about the source',
    vac.firstVac > 0 && vac.firstVac === vac.firstMat,
    `vacuum arrivals ${vac.firstVac} vs ${vac.firstMat} — the reference is already asymmetric`);
  check(`μ_r = 9 slows the front (vacuum ${mat.firstVac} → slab ${mat.firstMat} steps)`,
    mat.firstVac > 0 && mat.firstMat > mat.firstVac * 1.3,
    `arrivals: vacuum side ${mat.firstVac}, slab side ${mat.firstMat}`);
  check('the vacuum side of a material grid is unchanged',
    mat.firstVac === vac.firstVac,
    `vacuum-side arrival moved from ${vac.firstVac} to ${mat.firstVac}`);
  check('hasMaterials reflects the installed map',
    mat.grid.hasMaterials === true && vac.grid.hasMaterials === false,
    `mat ${mat.grid.hasMaterials}, vac ${vac.grid.hasMaterials}`);
}

// ── 11. σ cells exclude the field ──────────────────────────────────────────
{
  const n = 96;
  const cfg = { ...m.FDTD_DEFAULT_CONFIG, n, pmlCells: 12 };
  const c = Math.floor(n / 2);
  const blockX = c + 22;
  const g = new m.FdtdTmzGrid(cfg);
  g.setMaterials([{ shape: 'rect', x: blockX, y: c, halfW: 6, halfH: 18, sigma: 6 }]);
  for (let t = 0; t < 300; t++) {
    const tt = (t - 20) / 6;
    g.setSources([{ x: c, y: c, amp: t < 50 ? -tt * Math.exp(-tt * tt / 2) : 0 }]);
    g.step();
  }
  // Energy deep inside the conductor vs just in front of its illuminated face.
  const sample = (x) => {
    let e = 0;
    for (let y = c - 10; y <= c + 10; y++) e += g.ez[x + y * n] ** 2;
    return e;
  };
  const front = sample(blockX - 8);
  const inside = sample(blockX);
  check(`σ block excludes the field (inside/front = ${(inside / Math.max(front, 1e-30)).toExponential(1)})`,
    front > 1e-12 && inside < front * 0.1,
    `front ${front.toExponential(2)}, inside ${inside.toExponential(2)}`);
}

// ── 12. A vacuum map changes nothing ──────────────────────────────────────
{
  const n = 48;
  const cfg = { ...m.FDTD_DEFAULT_CONFIG, n, pmlCells: 6 };
  const drive = (t) => {
    const tt = (t - 10) / 4;
    return t < 30 ? -tt * Math.exp(-tt * tt / 2) : 0;
  };
  const plain = new m.FdtdTmzGrid(cfg);
  const mapped = new m.FdtdTmzGrid(cfg);
  // An explicit all-vacuum map, and a map whose only region is vacuum-valued.
  mapped.setMaterials(m.buildFdtdMaterialMap(
    [{ shape: 'rect', x: n / 2, y: n / 2, halfW: 5, halfH: 5, muR: 1, sigma: 0 }], cfg
  ));
  for (let t = 0; t < 120; t++) {
    for (const g of [plain, mapped]) {
      g.setSources([{ x: n / 2, y: n / 2, amp: drive(t) }]);
      g.step();
    }
  }
  let identical = true;
  for (let i = 0; i < n * n; i++) {
    if (plain.ez[i] !== mapped.ez[i] || plain.hx[i] !== mapped.hx[i] || plain.hy[i] !== mapped.hy[i]) {
      identical = false;
      break;
    }
  }
  check('a vacuum-valued map is bit-for-bit the ADR-0010 kernel', identical,
    'a vacuum map perturbed the fields');
  check('a vacuum-valued map is not installed at all', mapped.hasMaterials === false,
    'setMaterials kept a vacuum map, costing the fast path');
}

// ── 13. WebGL2 micro-grid ─────────────────────────────────────────────────
{
  const h = await importTsBundle('src/fdtd-heatmap-overlay.ts');
  check(`micro-grid is small (${h.MICRO_GRID_N}²)`,
    h.MICRO_GRID_N > 0 && h.MICRO_GRID_N <= 96 && h.MICRO_GRID_N < m.FDTD_GRID_N,
    `${h.MICRO_GRID_N} vs the GPU grid's ${m.FDTD_GRID_N}`);
  check('micro-grid sponge scales with the grid',
    h.MICRO_PML_CELLS / h.MICRO_GRID_N > 0.05 && h.MICRO_PML_CELLS / h.MICRO_GRID_N < 0.3,
    `${h.MICRO_PML_CELLS}/${h.MICRO_GRID_N}`);
  check('micro-grid keeps the reference Courant number',
    h.MICRO_GRID_CONFIG.courant === m.FDTD_COURANT, String(h.MICRO_GRID_CONFIG.courant));

  // It must survive the same abuse as the big grid, and cheaply.
  const g = new m.FdtdTmzGrid(h.MICRO_GRID_CONFIG);
  const coil = await importTsBundle('src/devices/quanta/pulse-coil.ts');
  g.setMaterials(m.buildFdtdMaterialMap(coil.pulseCoilFdtdMaterials(h.MICRO_GRID_N), h.MICRO_GRID_CONFIG));
  const sources = coil.pulseCoilFdtdSources(h.MICRO_GRID_N);
  check('micro-grid sources land inside the grid',
    sources.length > 0 && sources.every((s) =>
      s.x >= 0 && s.x <= h.MICRO_GRID_N - 1 && s.y >= 0 && s.y <= h.MICRO_GRID_N - 1),
    JSON.stringify(sources.map((s) => [Math.round(s.x), Math.round(s.y)])));

  const t0 = performance.now();
  let finite = true;
  for (let frame = 0; frame < 240; frame++) {
    const target = frame < 120 ? 1.5 : (frame < 160 ? -1.5 : 0);
    g.setSources(sources.map((s) => ({ ...s, amp: s.amp * target })));
    for (let k = 0; k < h.MICRO_STEPS_PER_FRAME; k++) g.step();
  }
  const msPerFrame = (performance.now() - t0) / 240;
  for (let i = 0; i < h.MICRO_GRID_N ** 2; i++) {
    if (!Number.isFinite(g.ez[i]) || !Number.isFinite(g.hx[i]) || !Number.isFinite(g.hy[i])) {
      finite = false;
      break;
    }
  }
  check('micro-grid stays finite under a hard drive', finite, 'NaN/Inf on the micro grid');
  // Generous bound: this must not be a frame-budget risk even on a slow VM.
  check(`micro-grid costs ${msPerFrame.toFixed(2)} ms/frame`, msPerFrame < 4,
    `${msPerFrame.toFixed(2)} ms/frame is too much for a fallback readout`);

  // Colour mapping brackets: vacuum floor, +Ez warm, −Ez cool, |H| green.
  const dark = h.heatmapPixel(0, 0, 0, 0);
  const hot = h.heatmapPixel(1, 0, 0, 0);
  const cold = h.heatmapPixel(-1, 0, 0, 0);
  const field = h.heatmapPixel(0, 1, 0, 0);
  const iron = h.heatmapPixel(0, 0, 1, 0);
  check('quiet vacuum is near-black', Math.max(...dark) < 30, dark.join(','));
  check('+Ez is warm (r > b)', hot[0] > hot[2], hot.join(','));
  check('−Ez is cool (b > r)', cold[2] > cold[0], cold.join(','));
  check('|H| is green (g dominant)', field[1] > field[0] && field[1] > field[2], field.join(','));
  check('a μ_r cell is tinted, not black', Math.max(...iron) > Math.max(...dark), iron.join(','));
  check('every channel stays in 0..255',
    [dark, hot, cold, field, iron].every((p) => p.every((c) => c >= 0 && c <= 255)),
    'a channel escaped 0..255');
}

// ── 14. Drive sources ─────────────────────────────────────────────────────
{
  const coil = await importTsBundle('src/devices/quanta/pulse-coil.ts');
  const url = await importTsBundle('src/renderers/shared/url-params.ts');
  const maxDrive = coil.PULSE_COIL_FDTD.maxDrive;

  check('coil drive is NaN-safe',
    coil.pulseCoilFdtdDrive({ pulseCoilCurrentA: Number.NaN }) === 0,
    String(coil.pulseCoilFdtdDrive({ pulseCoilCurrentA: Number.NaN })));
  check('coil drive handles a missing state', coil.pulseCoilFdtdDrive(null) === 0,
    String(coil.pulseCoilFdtdDrive(null)));
  check('coil drive is clamped',
    coil.pulseCoilFdtdDrive({ pulseCoilCurrentA: 1e6 }) === maxDrive
      && coil.pulseCoilFdtdDrive({ pulseCoilCurrentA: -1e6 }) === -maxDrive,
    `${coil.pulseCoilFdtdDrive({ pulseCoilCurrentA: 1e6 })} / ${coil.pulseCoilFdtdDrive({ pulseCoilCurrentA: -1e6 })}`);

  check('transformer drive is NaN-safe',
    coil.transformerFdtdDrive({ transformerFluxN: Number.NaN }) === 0,
    String(coil.transformerFdtdDrive({ transformerFluxN: Number.NaN })));
  check('transformer drive handles a missing state', coil.transformerFdtdDrive(undefined) === 0,
    String(coil.transformerFdtdDrive(undefined)));
  check('transformer drive is clamped',
    coil.transformerFdtdDrive({ transformerFluxN: 50 }) === maxDrive
      && coil.transformerFdtdDrive({ transformerFluxN: -50 }) === -maxDrive,
    `${coil.transformerFdtdDrive({ transformerFluxN: 50 })} / ${coil.transformerFdtdDrive({ transformerFluxN: -50 })}`);
  check('transformer drive is signed and monotonic',
    coil.transformerFdtdDrive({ transformerFluxN: 0.5 }) > 0
      && coil.transformerFdtdDrive({ transformerFluxN: -0.5 }) < 0
      && coil.transformerFdtdDrive({ transformerFluxN: 0.8 })
         > coil.transformerFdtdDrive({ transformerFluxN: 0.4 }),
    'transformer flux → drive is not signed/monotonic');

  check('drive source defaults to the coil',
    url.parseFdtdDriveSource(new URLSearchParams('')) === m.FDTD_DRIVE_SOURCES.COIL,
    url.parseFdtdDriveSource(new URLSearchParams('')));
  check('?fdtdDrive=transformer selects the transformer',
    url.parseFdtdDriveSource(new URLSearchParams('fdtdDrive=transformer'))
      === m.FDTD_DRIVE_SOURCES.TRANSFORMER,
    url.parseFdtdDriveSource(new URLSearchParams('fdtdDrive=transformer')));
  check('an unknown ?fdtdDrive falls back to the coil',
    url.parseFdtdDriveSource(new URLSearchParams('fdtdDrive=banana')) === m.FDTD_DRIVE_SOURCES.COIL,
    url.parseFdtdDriveSource(new URLSearchParams('fdtdDrive=banana')));
  check('every drive source names a catalog device',
    Object.values(m.FDTD_DRIVE_SOURCES).every((k) => typeof m.FDTD_DRIVE_DEVICE[k] === 'string'),
    JSON.stringify(m.FDTD_DRIVE_DEVICE));

  check('materials default on', url.parseFdtdMaterialsEnabled(new URLSearchParams('')) === true,
    'materials defaulted off');
  check('?fdtdMaterials=0 turns materials off',
    url.parseFdtdMaterialsEnabled(new URLSearchParams('fdtdMaterials=0')) === false,
    'the kill switch did not take');
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[fdtd-slice] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[fdtd-slice] ${ok.length} checks passed`);
