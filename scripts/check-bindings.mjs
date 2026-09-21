#!/usr/bin/env node
/**
 * check-bindings.mjs — assert `@group(0) @binding(N)` drift between
 * `src/pipeline-layout/layouts/*.ts` (JS `GPUBindGroupLayoutDescriptor`
 * source of truth) and the WGSL pass files that consume each layout.
 *
 * naga (check:wgsl) validates each WGSL file in isolation and can't see the
 * JS side; check-post-contracts.mjs prices attachment bytes but doesn't
 * touch binding numbers. A layout and its WGSL globals can drift silently —
 * both sides stay individually valid WebGPU/WGSL, they just no longer agree
 * on which binding is which resource — until a bind group creation or
 * pipeline validation error at runtime.
 *
 * Scope: the `fdtd` and `post` layout registrars (docs/BINDINGS.md's `fdtd*`
 * and post-process/environment tables) — see LAYOUT_WGSL_FILES below to add
 * more. Every layout name in LAYOUT_WGSL_FILES must also appear in
 * LAYOUT_FILES's `r.bgl(...)` calls, so a rename on either side fails loudly
 * instead of silently skipping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSES_DIR = path.join(ROOT, 'src/shaders/passes');

const LAYOUT_FILES = [
  'src/pipeline-layout/layouts/fdtd.ts',
  'src/pipeline-layout/layouts/post.ts'
];

/** Layout name -> WGSL pass file(s) declaring its `@group(0)` globals. */
const LAYOUT_WGSL_FILES = {
  fdtdCompute: ['fdtd-tmz-compute.wgsl'],
  fdtdSlice: ['fdtd-slice.wgsl'],
  sky: ['sky-vert.wgsl', 'sky-frag.wgsl'],
  empty: ['grid-vert.wgsl', 'grid-frag.wgsl'],
  anomalyWall: ['seg-anomaly-walls.wgsl'],
  bloomExtract: ['bloom-extract.wgsl'],
  bloomBlur: ['bloom-blur.wgsl'],
  bloomComposite: ['bloom-composite.wgsl'],
  ssr: ['ssr-compute.wgsl'],
  iblPrefilter: ['ibl-prefilter-compute.wgsl'],
  taaResolve: ['taa-resolve.wgsl'],
  depthResolve: ['depth-resolve.wgsl']
};

function parseLayoutBindings(tsSource) {
  const layouts = new Map(); // name -> Set<number>
  const bglRe = /r\.bgl\(\s*'([^']+)'\s*,\s*\[([\s\S]*?)]\s*\)/g;
  let m;
  while ((m = bglRe.exec(tsSource))) {
    const [, name, body] = m;
    const bindings = new Set();
    for (const entry of body.matchAll(/\b\w+\(\s*(\d+)/g)) {
      bindings.add(Number(entry[1]));
    }
    layouts.set(name, bindings);
  }
  return layouts;
}

function parseWgslBindings(wgslSource) {
  const bindings = new Set();
  for (const m of wgslSource.matchAll(/@group\(\s*0\s*\)\s*@binding\(\s*(\d+)\s*\)/g)) {
    bindings.add(Number(m[1]));
  }
  return bindings;
}

const sortedList = (set) => [...set].sort((a, b) => a - b).join(', ');

let checked = 0;
let failures = 0;
const foundLayoutNames = new Set();

for (const relFile of LAYOUT_FILES) {
  const src = fs.readFileSync(path.join(ROOT, relFile), 'utf8');
  const layouts = parseLayoutBindings(src);
  for (const [name, jsBindings] of layouts) {
    foundLayoutNames.add(name);
    const wgslFiles = LAYOUT_WGSL_FILES[name];
    if (!wgslFiles) continue; // layout not tracked by this script yet

    const wgslBindings = new Set();
    for (const wf of wgslFiles) {
      const wgslSrc = fs.readFileSync(path.join(PASSES_DIR, wf), 'utf8');
      for (const b of parseWgslBindings(wgslSrc)) wgslBindings.add(b);
    }

    checked += 1;
    const onlyInJs = [...jsBindings].filter((b) => !wgslBindings.has(b));
    const onlyInWgsl = [...wgslBindings].filter((b) => !jsBindings.has(b));
    if (onlyInJs.length || onlyInWgsl.length) {
      failures += 1;
      console.error(`  FAIL: ${name} (${relFile} vs ${wgslFiles.join(', ')})`);
      if (onlyInJs.length) console.error(`    in JS layout but no matching WGSL @binding: ${sortedList(new Set(onlyInJs))}`);
      if (onlyInWgsl.length) console.error(`    in WGSL but not in JS layout: ${sortedList(new Set(onlyInWgsl))}`);
    } else {
      console.log(`  ok: ${name} — {${sortedList(jsBindings)}}`);
    }
  }
}

for (const name of Object.keys(LAYOUT_WGSL_FILES)) {
  if (!foundLayoutNames.has(name)) {
    failures += 1;
    console.error(`  FAIL: layout '${name}' not found via r.bgl(...) in ${LAYOUT_FILES.join(', ')} — LAYOUT_WGSL_FILES is stale`);
  }
}

if (failures > 0) {
  console.error(`[check-bindings] ${failures} binding drift issue(s) across ${checked} layout(s)`);
  process.exit(1);
}
console.log(`[check-bindings] ${checked} layout(s) match their WGSL @binding declarations`);
