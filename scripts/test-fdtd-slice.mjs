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

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[fdtd-slice] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[fdtd-slice] ${ok.length} checks passed`);
