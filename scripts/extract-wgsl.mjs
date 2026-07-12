#!/usr/bin/env node
/**
 * extract-wgsl.mjs — expand #includes and extract generator template shaders
 * for offline naga validation.
 *
 * Usage:
 *   node scripts/extract-wgsl.mjs                 # write to build/wgsl-check/
 *   node scripts/extract-wgsl.mjs --list          # print plan only
 *   node scripts/extract-wgsl.mjs --stdout path   # print one expanded file
 *
 * Exit 0 always (extraction only). Validation is scripts/check-wgsl.sh.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHADER_ROOT,
  loadWgslFile,
  resolveWgsl,
  hasIncludes
} from '../src/shaders/wgsl-include.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build', 'wgsl-check');

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const stdoutIdx = args.indexOf('--stdout');

function walkWgsl(dir, acc = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === 'generators') continue; // JS templates handled separately
      walkWgsl(p, acc);
    } else if (name.name.endsWith('.wgsl')) {
      acc.push(p);
    }
  }
  return acc;
}

/** Pull wgsl tagged template returns and plain return templates from generator JS. */
function extractTemplatesFromJs(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const out = [];
  // Match return /* wgsl */ `...` or return `...` with @vertex|@fragment|@compute inside
  const re = /return\s+(?:\/\*\s*wgsl\s*\*\/\s*)?`([\s\S]*?)`/g;
  let m;
  let i = 0;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    if (!/@(vertex|fragment|compute)\b/.test(body)) continue;
    i += 1;
    out.push({ index: i, body: body.replace(/^\n/, '') });
  }
  return out;
}

function hasEntryPoint(wgsl) {
  return /@(vertex|fragment|compute)\b/.test(wgsl);
}

function main() {
  if (stdoutIdx >= 0) {
    const rel = args[stdoutIdx + 1];
    if (!rel) {
      console.error('usage: --stdout <path-under-src/shaders>');
      process.exit(2);
    }
    process.stdout.write(loadWgslFile(rel));
    return;
  }

  const plan = [];

  // 1) All .wgsl under shaders/ (including common + passes + legacy roots)
  for (const abs of walkWgsl(SHADER_ROOT)) {
    const rel = relative(SHADER_ROOT, abs);
    let source;
    try {
      source = loadWgslFile(abs);
    } catch (e) {
      plan.push({ id: rel, ok: false, error: String(e.message || e) });
      continue;
    }
    plan.push({
      id: rel,
      ok: true,
      entry: hasEntryPoint(source),
      source,
      kind: 'file'
    });
  }

  // 2) Generator JS templates (skip those that only re-export raw files if empty)
  const genDir = join(SHADER_ROOT, 'generators');
  for (const name of readdirSync(genDir)) {
    if (!name.endsWith('.js')) continue;
    if (name === 'pbr-wgsl-chunks.js') continue;
    const abs = join(genDir, name);
    const templates = extractTemplatesFromJs(abs);
    for (const t of templates) {
      const id = `generators/${name}#${t.index}`;
      let source = t.body;
      // Expand any #include that slipped into templates
      if (hasIncludes(source)) {
        try {
          source = resolveWgsl(source, { fromFile: abs });
        } catch (e) {
          plan.push({ id, ok: false, error: String(e.message || e) });
          continue;
        }
      }
      // Expand common / PBR template interpolations used by generators
      const inject = {
        frameUniformsWgsl: 'common/frame-uniforms.wgsl',
        deviceUniformsWgsl: 'common/device-uniforms.wgsl',
        particleStructsWgsl: 'common/particle.wgsl',
        PBR_SURFACE_WGSL: 'common/pbr-surface.wgsl',
        PBR_BRDF_WGSL: 'common/pbr-brdf.wgsl',
        PBR_LIGHTING_STRUCT_WGSL: 'common/pbr-lighting.wgsl',
        PBR_EVAL_WGSL: 'common/pbr-eval.wgsl'
      };
      for (const [key, rel] of Object.entries(inject)) {
        if (source.includes(`\${${key}}`)) {
          source = source.split(`\${${key}}`).join(
            readFileSync(join(SHADER_ROOT, rel), 'utf8')
          );
        }
      }
      // Skip templates that still have unresolved ${
      if (/\$\{[A-Za-z_]/.test(source)) {
        plan.push({ id, ok: true, entry: false, skip: 'unresolved-template', source });
        continue;
      }
      plan.push({
        id,
        ok: true,
        entry: hasEntryPoint(source),
        source,
        kind: 'generator'
      });
    }
  }

  // 3) Always emit expanded particle compute under a stable name
  const particleCompute = loadWgslFile('passes/particle-compute.wgsl');
  plan.push({
    id: 'passes/particle-compute.wgsl',
    ok: true,
    entry: true,
    source: particleCompute,
    kind: 'file',
    dedupe: true
  });

  if (listOnly) {
    for (const p of plan) {
      const flag = !p.ok ? 'ERR' : p.skip ? 'SKIP' : p.entry ? 'ENTRY' : 'FRAG';
      console.log(`${flag.padEnd(6)} ${p.id}${p.error ? ' — ' + p.error : ''}`);
    }
    console.log(`[extract-wgsl] ${plan.length} units`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  // Clear old
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.wgsl') || f.endsWith('.json')) {
      try {
        writeFileSync(join(OUT_DIR, f), '');
      } catch { /* ignore */ }
    }
  }

  const manifest = [];
  const seen = new Set();
  let written = 0;
  for (const p of plan) {
    if (!p.ok || p.skip || !p.entry) continue;
    if (seen.has(p.id) && p.dedupe) continue;
    seen.add(p.id);
    const safe = p.id.replace(/[/#]/g, '_');
    const outPath = join(OUT_DIR, safe.endsWith('.wgsl') ? safe : `${safe}.wgsl`);
    writeFileSync(outPath, p.source);
    manifest.push({ id: p.id, file: basename(outPath), kind: p.kind });
    written += 1;
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[extract-wgsl] wrote ${written} entry-point modules → ${relative(ROOT, OUT_DIR)}`);
}

main();
