#!/usr/bin/env node
/**
 * codegen-bindings.mjs
 *
 * Reads src/pipeline-layout/bind-group-schema.json (source of truth for every
 * `@group(0)` bind group layout) and emits:
 *   src/pipeline-layout/generated/bind-group-layouts.ts
 *
 * The layout registrars (`src/pipeline-layout/layouts/*.ts`) pass those
 * generated entry arrays to `r.bgl(...)`; `npm run check:bindings` diffs the
 * same schema against the WGSL pass files.
 *
 * Usage:
 *   node scripts/codegen-bindings.mjs
 *   node scripts/codegen-bindings.mjs --check
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_PATH = join(ROOT, 'src', 'pipeline-layout', 'bind-group-schema.json');
const OUT = join(ROOT, 'src', 'pipeline-layout', 'generated', 'bind-group-layouts.ts');

/** GPUShaderStage bit values (spec constants) — literal so the module needs no WebGPU global. */
const STAGE_BITS = { V: 1, F: 2, C: 4 };

export const KINDS = {
  uniform: () => `buffer: { type: 'uniform' }`,
  storage: () => `buffer: { type: 'storage' }`,
  'storage-ro': () => `buffer: { type: 'read-only-storage' }`,
  texture: () => `texture: { sampleType: 'float', viewDimension: '2d' }`,
  'texture-depth': () => `texture: { sampleType: 'depth', viewDimension: '2d' }`,
  'texture-depth-ms': () => `texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true }`,
  'texture-array': () => `texture: { sampleType: 'float', viewDimension: '2d-array' }`,
  'storage-texture': (fmt) => `storageTexture: { access: 'write-only', format: '${fmt}', viewDimension: '2d' }`,
  'storage-texture-array': (fmt) => `storageTexture: { access: 'write-only', format: '${fmt}', viewDimension: '2d-array' }`,
  sampler: () => `sampler: { type: 'filtering' }`
};

export function loadSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  for (const [name, layout] of Object.entries(schema.layouts)) {
    const seen = new Set();
    for (const [binding, stages, kind, fmt] of layout.entries) {
      if (seen.has(binding)) throw new Error(`${name}: duplicate binding ${binding}`);
      seen.add(binding);
      if (!KINDS[kind]) throw new Error(`${name}@${binding}: unknown kind '${kind}'`);
      if (kind.startsWith('storage-texture') && !fmt) throw new Error(`${name}@${binding}: storage texture needs a format`);
      if (!stages || [...stages].some((s) => !(s in STAGE_BITS))) {
        throw new Error(`${name}@${binding}: bad stages '${stages}'`);
      }
    }
  }
  return schema;
}

function stageExpr(stages) {
  return [...stages].reduce((acc, s) => acc | STAGE_BITS[s], 0);
}

function render(schema) {
  const names = Object.keys(schema.layouts);
  const lines = [
    '/**',
    ' * AUTO-GENERATED from src/pipeline-layout/bind-group-schema.json — do not edit.',
    ' * Regenerate: npm run codegen:bindings',
    ' */',
    '',
    `export type SchemaBindGroupLayoutName =\n${names.map((n) => `  | '${n}'`).join('\n')};`,
    '',
    '/** `GPUBindGroupLayoutDescriptor.entries` per named layout (visibility: 1=VERTEX 2=FRAGMENT 4=COMPUTE). */',
    'export const BGL: Readonly<Record<SchemaBindGroupLayoutName, readonly GPUBindGroupLayoutEntry[]>> = {'
  ];
  for (const name of names) {
    const entries = schema.layouts[name].entries;
    if (entries.length === 0) {
      lines.push(`  ${name}: [],`);
      continue;
    }
    lines.push(`  ${name}: [`);
    for (const [binding, stages, kind, fmt] of entries) {
      lines.push(`    { binding: ${binding}, visibility: ${stageExpr(stages)}, ${KINDS[kind](fmt)} },`);
    }
    lines.push('  ],');
  }
  lines.push('};', '');
  return lines.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = render(loadSchema());
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    if (current !== out) {
      console.error('[codegen-bindings] generated/bind-group-layouts.ts is stale — run npm run codegen:bindings');
      process.exit(1);
    }
    console.log('[codegen-bindings] generated bind group layouts up to date');
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, out);
    console.log(`[codegen-bindings] wrote ${OUT.slice(ROOT.length + 1)}`);
  }
}
