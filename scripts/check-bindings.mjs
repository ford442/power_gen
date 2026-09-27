#!/usr/bin/env node
/**
 * check-bindings.mjs — assert every production bind group layout agrees with
 * the WGSL that consumes it.
 *
 * Source of truth: src/pipeline-layout/bind-group-schema.json. The schema is
 * compiled into src/pipeline-layout/generated/bind-group-layouts.ts
 * (`npm run codegen:bindings`), which the layout registrars pass to
 * `r.bgl(...)`. This script fails when:
 *
 *   - the generated TS is stale vs the schema;
 *   - a `r.bgl('name', ...)` in src/pipeline-layout/layouts/*.ts does not pass
 *     `BGL.name` (hand-written entries bypass the schema), or a schema layout
 *     is never registered / a registered one is missing from the schema;
 *   - a pipeline's WGSL declares a `@group(0)` binding the layout lacks, or
 *     with a different resource kind (uniform / storage rw / storage read /
 *     texture / depth / sampler / storage texture + format);
 *   - a layout entry is declared by none of its pipelines' WGSL;
 *   - a pass file in src/shaders/passes/ declares bindings but belongs to no
 *     layout (and is not listed under `unboundPasses`).
 *
 * naga (check:wgsl) validates each WGSL file in isolation and can't see the
 * JS side; this closes that gap for every layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSchema } from './codegen-bindings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSES_DIR = path.join(ROOT, 'src/shaders/passes');
const LAYOUTS_DIR = path.join(ROOT, 'src/pipeline-layout/layouts');

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL: ${msg}`);
};

// 1. Generated TS freshness.
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/codegen-bindings.mjs'), '--check'], { stdio: 'pipe' });
} catch (e) {
  fail(String(e.stderr || e.message).trim());
}

const schema = loadSchema();
const layouts = schema.layouts;
const unbound = new Set(Object.keys(schema.unboundPasses || {}).filter((k) => !k.startsWith('$')));

// 2. Registrars must feed the generated entries.
const registered = new Set();
for (const file of fs.readdirSync(LAYOUTS_DIR).filter((f) => f.endsWith('.ts'))) {
  const src = fs.readFileSync(path.join(LAYOUTS_DIR, file), 'utf8');
  for (const m of src.matchAll(/r\.bgl\(\s*'([^']+)'\s*,\s*([^)]*?)\s*\)/g)) {
    const [, name, arg] = m;
    registered.add(name);
    if (arg !== `BGL.${name}`) fail(`${file}: r.bgl('${name}', ${arg}) — must pass BGL.${name} from generated/bind-group-layouts.ts`);
    if (!layouts[name]) fail(`${file}: layout '${name}' is not in bind-group-schema.json`);
  }
}
for (const name of Object.keys(layouts)) {
  if (!registered.has(name)) fail(`schema layout '${name}' is never registered via r.bgl(...)`);
}

// 3. WGSL vs schema.
/** Map a WGSL `var<...> name: type` declaration to a schema kind (+ format). */
function wgslKind(addrSpace, type) {
  const t = type.replace(/\s+/g, '');
  if (addrSpace) {
    const parts = addrSpace.replace(/\s+/g, '').split(',');
    if (parts[0] === 'uniform') return { kind: 'uniform' };
    if (parts[0] === 'storage') return { kind: parts[1] === 'read_write' ? 'storage' : 'storage-ro' };
    return { kind: `?${addrSpace}` };
  }
  if (t === 'sampler') return { kind: 'sampler' };
  if (t === 'texture_depth_2d') return { kind: 'texture-depth' };
  if (t === 'texture_depth_multisampled_2d') return { kind: 'texture-depth-ms' };
  if (t === 'texture_2d<f32>') return { kind: 'texture' };
  if (t === 'texture_2d_array<f32>') return { kind: 'texture-array' };
  let m = t.match(/^texture_storage_2d<(\w+),write>$/);
  if (m) return { kind: 'storage-texture', format: m[1] };
  m = t.match(/^texture_storage_2d_array<(\w+),write>$/);
  if (m) return { kind: 'storage-texture-array', format: m[1] };
  return { kind: `?${t}` };
}

const DECL_RE = /((?:@(?:group|binding)\(\s*\d+\s*\)\s*){2})var(?:<([^>]*)>)?\s+\w+\s*:\s*([^;]+);/g;
const wgslCache = new Map();
function parseWgsl(file) {
  if (wgslCache.has(file)) return wgslCache.get(file);
  const src = fs.readFileSync(path.join(PASSES_DIR, file), 'utf8');
  const out = new Map(); // binding -> {kind, format}
  for (const m of src.matchAll(DECL_RE)) {
    const group = Number(m[1].match(/@group\(\s*(\d+)/)[1]);
    const binding = Number(m[1].match(/@binding\(\s*(\d+)/)[1]);
    if (group !== 0) continue;
    out.set(binding, wgslKind(m[2], m[3]));
  }
  wgslCache.set(file, out);
  return out;
}

const mappedPasses = new Set();
let checked = 0;
for (const [name, layout] of Object.entries(layouts)) {
  const entries = new Map(layout.entries.map(([b, , kind, format]) => [b, { kind, format }]));
  const used = new Set();
  const before = failures;
  for (const files of layout.pipelines) {
    for (const f of files) {
      mappedPasses.add(f);
      if (!fs.existsSync(path.join(PASSES_DIR, f))) {
        fail(`${name}: pass file ${f} does not exist`);
        continue;
      }
      for (const [b, decl] of parseWgsl(f)) {
        used.add(b);
        const e = entries.get(b);
        if (!e) {
          fail(`${name}: ${f} declares @binding(${b}) but the layout has no entry ${b}`);
        } else if (e.kind !== decl.kind || (e.format && e.format !== decl.format)) {
          fail(`${name}@${b}: layout says ${e.kind}${e.format ? `(${e.format})` : ''}, ${f} declares ${decl.kind}${decl.format ? `(${decl.format})` : ''}`);
        }
      }
    }
  }
  for (const b of entries.keys()) {
    if (!used.has(b)) fail(`${name}: entry ${b} is declared by none of ${layout.pipelines.flat().join(', ')}`);
  }
  checked += 1;
  if (failures === before) console.log(`  ok: ${name} — {${[...entries.keys()].sort((a, b) => a - b).join(', ')}}`);
}

for (const f of fs.readdirSync(PASSES_DIR).filter((p) => p.endsWith('.wgsl'))) {
  if (mappedPasses.has(f) || unbound.has(f)) continue;
  if (parseWgsl(f).size > 0) fail(`${f} declares @group(0) bindings but maps to no layout in bind-group-schema.json`);
}

if (failures > 0) {
  console.error(`[check-bindings] ${failures} binding drift issue(s) across ${checked} layout(s)`);
  process.exit(1);
}
console.log(`[check-bindings] ${checked} layout(s) match their WGSL @binding declarations`);
