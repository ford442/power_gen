#!/usr/bin/env node
/**
 * Fail when a class field shadows a method merged onto its prototype.
 *
 * Several classes get methods from mixin objects via
 * `Object.assign(Cls.prototype, mixinA, mixinB)`. With ES2022 class-field
 * semantics (tsconfig `target: ES2022`, Vite `build.target: 'es2022'`), every
 * field *declaration* in the class body — including `foo!: () => void` — is
 * emitted as an own property initialised to `undefined`, which hides the
 * prototype method. `DebugPanel` shipped exactly that: `new DebugPanel()` threw
 * `this._wireFieldNetworkControls is not a function` and every WebGPU boot
 * hard-failed. Typecheck cannot see it, and e2e only runs WebGL2.
 *
 * Declare mixin methods with interface declaration merging
 * (`export interface Cls { method(): void }`) or `declare method: …`, never as
 * a plain class field.
 *
 * How: find every `Object.assign(X.prototype, …)` in src/**, transform the
 * class's file with esbuild exactly as Vite does to read the fields it really
 * emits, bundle the mixin modules to read their real keys, and intersect.
 *
 * Usage: node scripts/check-mixin-shadowing.mjs   (exit 1 on failure)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== 'public' && ent.name !== 'generated') yield* walk(full);
    } else if (/\.(ts|js)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/** Own fields esbuild emits for `class <name>` under ES2022 define semantics. */
async function emittedFields(file, className) {
  const { code } = await esbuild.transform(readFileSync(file, 'utf8'), {
    loader: file.endsWith('.ts') ? 'ts' : 'js',
    target: 'es2022',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true, target: 'ES2022' } }
  });
  const start = code.search(new RegExp(`class ${className}\\b[^{]*\\{`));
  if (start < 0) return null;
  // Walk the class body; collect depth-1 statements that are field definitions.
  const open = code.indexOf('{', start);
  const fields = new Set();
  let depth = 0;
  let lineStart = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    } else if (c === '\n') {
      if (depth === 1) {
        const line = code.slice(lineStart, i).trim();
        const m = /^(?:static\s+)?([A-Za-z_$][\w$]*)\s*(?:=.*)?;$/.exec(line);
        if (m && !line.startsWith('static')) fields.add(m[1]);
      }
      lineStart = i + 1;
    }
  }
  return fields;
}

/** Real keys of `exportName` from `spec` imported by `fromFile`. */
async function mixinKeys(fromFile, spec, exportName) {
  const entry = resolve(dirname(fromFile), spec);
  const result = await esbuild.build({
    stdin: { contents: `export { ${exportName} as m } from ${JSON.stringify(entry)};`, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
    resolveExtensions: ['.ts', '.js', '.mjs'],
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    define: { 'import.meta.url': '"file:///stub/mixin.js"' },
    plugins: [viteRawStub]
  });
  const mod = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
  return Object.keys(mod.m ?? {});
}

const failures = [];
let sites = 0;
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/Object\.assign\(\s*([A-Za-z_$][\w$]*)\.prototype\s*,([^)]*)\)/g)) {
    const lineHead = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index).trim();
    if (lineHead.startsWith('*') || lineHead.startsWith('//')) continue; // doc comment
    const className = m[1];
    const mixinNames = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    const rel = relative(ROOT, file);
    sites++;
    const fields = await emittedFields(file, className);
    if (!fields) {
      failures.push(`${rel}: Object.assign(${className}.prototype, …) but no \`class ${className}\` in this file`);
      continue;
    }
    for (const name of mixinNames) {
      const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`).exec(src);
      let keys;
      if (imp) keys = await mixinKeys(file, imp[1], name);
      else {
        failures.push(`${rel}: cannot find the import of mixin \`${name}\``);
        continue;
      }
      for (const key of keys) {
        if (fields.has(key)) {
          failures.push(
            `${rel}: class ${className} field \`${key}\` shadows ${name}.${key} on the prototype — ` +
              'declare it in `interface ' + className + '` (declaration merging) instead'
          );
        }
      }
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error('[mixin-shadowing] FAIL', f);
  process.exit(1);
}
console.log(`[mixin-shadowing] ${sites} Object.assign(…prototype) sites — no class field shadows a mixin method`);
