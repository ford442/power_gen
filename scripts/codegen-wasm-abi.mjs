#!/usr/bin/env node
/**
 * codegen-wasm-abi.mjs — cpp/abi.json → the whole JS ⇄ WASM surface (#254 §3).
 *
 * sim_core used to cross the boundary through Embind (`--bind`): a class
 * registry, hidden std::vector marshalling (#221 froze the lab that way) and
 * most of the JS glue. Every binding already took scalars or a scratch
 * pointer, so the boundary is now a flat C ABI, generated from one manifest:
 *
 *   cpp/src/sim_core_abi.cpp            extern "C" EMSCRIPTEN_KEEPALIVE shims
 *                                       (also compiled natively by `make
 *                                       native`, so -Werror type-checks every
 *                                       one against sim_core.h without emcc)
 *   src/wasm/sim-core/abi.generated.ts  SimCoreExports (instance.exports,
 *                                       typed) + bindSimCore(): the
 *                                       SimCoreModule the app uses — no
 *                                       ccall / cwrap, no glue
 *   generated/sim-core-exports.json     EXPORTED_FUNCTIONS for the link
 *
 * A signature change in sim_core.h now fails `make native` / `make wasm` in
 * the generated shim, and `npm run test:wasm-abi` diffs the shipped binary's
 * export table against this manifest — an ABI break cannot reach the frame
 * loop.
 *
 * Manifest types: void f32 f64 i32 u32 bool ptr cstr; a struct name (a
 * return: the shim copies it into a static float block and returns its
 * address; an arg: Vec3 only, passed as three f32); f32[] (args only: the TS
 * wrapper stages the array through the class scratch and the shim takes
 * pointer + count). An arg may carry a third element, its TS default.
 *
 * Usage: node scripts/codegen-wasm-abi.mjs [--check]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'cpp', 'abi.json');
const OUT_CPP = join(ROOT, 'cpp', 'src', 'sim_core_abi.cpp');
const OUT_TS = join(ROOT, 'src', 'wasm', 'sim-core', 'abi.generated.ts');
const OUT_EXPORTS = join(ROOT, 'generated', 'sim-core-exports.json');
const CHECK = process.argv.includes('--check');

const SCALARS = new Set(['void', 'f32', 'f64', 'i32', 'u32', 'bool', 'ptr', 'cstr']);
const CPP_TYPE = { void: 'void', f32: 'float', f64: 'double', i32: 'int', u32: 'uint32_t', bool: 'int', ptr: 'uintptr_t', cstr: 'const char*' };
const IDENT = /^[A-Za-z_]\w*$/;

/** Free functions export as sc_<name>; class members as <prefix><name>. */
export function exportName(kind, cls, name) {
  return kind === 'free' ? `sc_${name}` : `${cls.prefix}${name}`;
}

export function loadManifest(path = MANIFEST) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validate(m) {
  const errors = [];
  const structs = m.structs ?? {};
  const isStruct = (t) => Object.hasOwn(structs, t);
  for (const [name, fields] of Object.entries(structs)) {
    if (!IDENT.test(name)) errors.push(`struct ${name}: not an identifier`);
    if (fields.length > 16) errors.push(`struct ${name}: more than 16 fields (the out block is 16 floats)`);
    for (const [f, t] of fields) if (!['f32', 'bool'].includes(t)) errors.push(`struct ${name}.${f}: fields are f32 or bool`);
  }
  const seen = new Set();
  const checkFn = (fn, where, inClass) => {
    if (!IDENT.test(fn.name)) errors.push(`${where}: bad name`);
    if (!(SCALARS.has(fn.ret) || isStruct(fn.ret))) errors.push(`${where}: unknown return type ${fn.ret}`);
    for (const a of fn.args ?? []) {
      const [an, at] = a;
      if (!IDENT.test(an)) errors.push(`${where}: bad arg name ${an}`);
      const ok = (SCALARS.has(at) && at !== 'void' && at !== 'cstr') || at === 'Vec3' || (at === 'f32[]' && inClass);
      if (!ok) errors.push(`${where}(${an}): unsupported arg type ${at}`);
    }
  };
  for (const fn of m.functions ?? []) {
    const ex = exportName('free', null, fn.name);
    if (seen.has(ex)) errors.push(`duplicate export ${ex}`);
    seen.add(ex);
    checkFn(fn, `function ${fn.name}`, false);
  }
  for (const [cname, cls] of Object.entries(m.classes ?? {})) {
    if (!/^[a-z]+_$/.test(cls.prefix ?? '')) errors.push(`class ${cname}: prefix like "seg_"`);
    for (const fn of [...cls.methods, ...(cls.static ?? []), { name: 'new' }, { name: 'delete' }]) {
      const ex = exportName('class', cls, fn.name);
      if (seen.has(ex)) errors.push(`duplicate export ${ex}`);
      seen.add(ex);
    }
    for (const fn of cls.methods) checkFn(fn, `${cname}.${fn.name}`, true);
    for (const fn of cls.static ?? []) checkFn(fn, `${cname}::${fn.name}`, false);
    if (cls.methods.some((f) => (f.args ?? []).some((a) => a[1] === 'f32[]')) && !cls.methods.some((f) => f.name === cls.scratch)) {
      errors.push(`class ${cname}: an f32[] arg needs "scratch" to name a ptr-returning method`);
    }
  }
  return errors;
}

/** Every export the binary must have, sorted (the test:wasm-abi diff). */
export function manifestExports(m) {
  const out = (m.functions ?? []).map((f) => exportName('free', null, f.name));
  for (const cls of Object.values(m.classes ?? {})) {
    out.push(exportName('class', cls, 'new'), exportName('class', cls, 'delete'));
    for (const f of [...cls.methods, ...(cls.static ?? [])]) out.push(exportName('class', cls, f.name));
  }
  return out.sort();
}

// ── C++ ─────────────────────────────────────────────────────────────────
function cppParams(args) {
  const out = [];
  for (const [n, t] of args ?? []) {
    if (t === 'Vec3') out.push(`float ${n}_x`, `float ${n}_y`, `float ${n}_z`);
    else if (t === 'f32[]') out.push(`const float* ${n}`, `int ${n}Count`);
    else out.push(`${CPP_TYPE[t]} ${n}`);
  }
  return out;
}

function cppCallArgs(args) {
  return (args ?? []).map(([n, t]) => {
    if (t === 'Vec3') return `Vec3{${n}_x, ${n}_y, ${n}_z}`;
    if (t === 'f32[]') return `${n}, ${n}Count`;
    if (t === 'bool') return `${n} != 0`;
    return n;
  }).join(', ');
}

function cppBody(fn, call, structs) {
  if (fn.ret === 'void') return `    ${call};`;
  if (fn.ret === 'bool') return `    return (${call}) ? 1 : 0;`;
  if (fn.ret === 'ptr') return `    return static_cast<uintptr_t>(${call});`;
  if (Object.hasOwn(structs, fn.ret)) {
    const fields = structs[fn.ret];
    const lines = fields.map(([f, t], i) => `    g_abi_out[${i}] = ${t === 'bool' ? `v.${f} ? 1.f : 0.f` : `v.${f}`};`);
    return `    const ${fn.ret} v = ${call};\n${lines.join('\n')}\n    return out_ptr();`;
  }
  return `    return ${call};`;
}

function cppRet(fn, structs) {
  return Object.hasOwn(structs, fn.ret) ? 'uintptr_t' : CPP_TYPE[fn.ret];
}

function emitCpp(m) {
  const structs = m.structs ?? {};
  const blocks = [];
  for (const fn of m.functions ?? []) {
    const call = fn.cpp ?? `${fn.name}(${cppCallArgs(fn.args)})`;
    blocks.push(`EMSCRIPTEN_KEEPALIVE ${cppRet(fn, structs)} ${exportName('free', null, fn.name)}(${cppParams(fn.args).join(', ')}) {\n${cppBody(fn, call, structs)}\n}`);
  }
  for (const [cname, cls] of Object.entries(m.classes ?? {})) {
    const p = cls.prefix;
    blocks.push(`EMSCRIPTEN_KEEPALIVE ${cname}* ${p}new() {\n    return new ${cname}();\n}`);
    blocks.push(`EMSCRIPTEN_KEEPALIVE void ${p}delete(${cname}* self) {\n    delete self;\n}`);
    for (const fn of cls.static ?? []) {
      blocks.push(`EMSCRIPTEN_KEEPALIVE ${cppRet(fn, structs)} ${p}${fn.name}(${cppParams(fn.args).join(', ')}) {\n${cppBody(fn, `${cname}::${fn.name}(${cppCallArgs(fn.args)})`, structs)}\n}`);
    }
    for (const fn of cls.methods) {
      const params = [`${cname}* self`, ...cppParams(fn.args)].join(', ');
      blocks.push(`EMSCRIPTEN_KEEPALIVE ${cppRet(fn, structs)} ${p}${fn.name}(${params}) {\n${cppBody(fn, `self->${fn.name}(${cppCallArgs(fn.args)})`, structs)}\n}`);
    }
  }
  return `// AUTO-GENERATED from cpp/abi.json — do not edit.
// Regenerate: npm run codegen:wasm-abi   (scripts/codegen-wasm-abi.mjs)
//
// sim_core's whole JS ⇄ WASM surface as a flat C ABI (#254 §3): scalars in,
// scalars out. A struct return is copied into one static float block whose
// address is returned (the TS wrapper reads it straight back, before the next
// call); an array argument arrives as pointer + count in the class scratch.
// Compiled by \`make native\` too (EMSCRIPTEN_KEEPALIVE is empty there), so a
// signature drift in sim_core.h fails -Werror without emcc.

#include "sim_core.h"

#include <cstdint>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

// Hash of every compiled input (scripts/sim-core-source-hash.mjs), passed by
// \`make wasm\`. The site build defines the same value; a mismatch means the
// shipped binary predates its sources (src/wasm/index.ts reports it).
#ifndef SIM_CORE_SOURCE_HASH
#define SIM_CORE_SOURCE_HASH "unknown"
#endif

namespace {
alignas(16) float g_abi_out[16];
inline uintptr_t out_ptr() { return reinterpret_cast<uintptr_t>(g_abi_out); }
} // namespace

extern "C" {

${blocks.join('\n\n')}

} // extern "C"
`;
}

// ── TS ──────────────────────────────────────────────────────────────────
const TS_TYPE = { void: 'void', f32: 'number', f64: 'number', i32: 'number', u32: 'number', bool: 'boolean', ptr: 'number', cstr: 'string', Vec3: 'Vec3', 'f32[]': 'ArrayLike<number>' };
const wasmTs = (t) => (t === 'void' ? 'void' : 'number');

function tsParams(args) {
  return (args ?? []).map(([n, t, d]) => `${n}${d !== undefined ? '?' : ''}: ${TS_TYPE[t]}`).join(', ');
}

function tsExportParams(args, self) {
  const out = self ? ['self: number'] : [];
  for (const [n, t] of args ?? []) {
    if (t === 'Vec3') out.push(`${n}_x: number`, `${n}_y: number`, `${n}_z: number`);
    else if (t === 'f32[]') out.push(`${n}: number`, `${n}Count: number`);
    else out.push(`${n}: number`);
  }
  return out.join(', ');
}

function tsCallArgs(args) {
  return (args ?? []).map(([n, t, d]) => {
    const v = d !== undefined ? `(${n} ?? ${JSON.stringify(d)})` : n;
    if (t === 'Vec3') return `${n}.x, ${n}.y, ${n}.z`;
    if (t === 'bool') return `${v} ? 1 : 0`;
    if (t === 'f32[]') return `${n}Ptr, ${n}.length`;
    return v;
  });
}

function tsWrapRet(fn, expr, structs) {
  if (fn.ret === 'void') return `${expr};`;
  if (fn.ret === 'bool') return `return ${expr} !== 0;`;
  if (fn.ret === 'u32' || fn.ret === 'ptr') return `return ${expr} >>> 0;`;
  if (fn.ret === 'cstr') return `return cstr(${expr});`;
  if (Object.hasOwn(structs, fn.ret)) return `return read${fn.ret}(${expr});`;
  return `return ${expr};`;
}

function emitTs(m) {
  const structs = m.structs ?? {};
  const structIfaces = Object.entries(structs).map(([n, fields]) =>
    `export interface ${n} {\n${fields.map(([f, t]) => `  ${f}: ${t === 'bool' ? 'boolean' : 'number'};`).join('\n')}\n}`).join('\n\n');
  const readers = Object.entries(structs).map(([n, fields]) => {
    const body = fields.map(([f, t], i) => `${f}: ${t === 'bool' ? `h[b + ${i}] !== 0` : `h[b + ${i}]`}`).join(', ');
    return `  const read${n} = (ptr: number): ${n} => {\n    const h = heapF32();\n    const b = (ptr >>> 0) >> 2;\n    return { ${body} };\n  };`;
  }).join('\n');

  const exportsIface = [];
  for (const fn of m.functions ?? []) exportsIface.push(`  ${exportName('free', null, fn.name)}(${tsExportParams(fn.args, false)}): ${wasmTs(fn.ret)};`);
  const classIfaces = [];
  const classImpls = [];
  const moduleFields = [];
  for (const [cname, cls] of Object.entries(m.classes ?? {})) {
    const p = cls.prefix;
    exportsIface.push(`  ${p}new(): number;`, `  ${p}delete(self: number): void;`);
    for (const fn of cls.static ?? []) exportsIface.push(`  ${p}${fn.name}(${tsExportParams(fn.args, false)}): ${wasmTs(fn.ret)};`);
    for (const fn of cls.methods) exportsIface.push(`  ${p}${fn.name}(${tsExportParams(fn.args, true)}): ${wasmTs(fn.ret)};`);

    const sigs = cls.methods.map((fn) => `  ${fn.name}(${tsParams(fn.args)}): ${TS_TYPE[fn.ret] ?? fn.ret};`);
    classIfaces.push(`export interface ${cname}Instance {\n  /** Address of the C++ object (for diagnostics). */\n  readonly ptr: number;\n${sigs.join('\n')}\n  /** Free the C++ object. Idempotent; the instance is dead afterwards. */\n  delete(): void;\n}\n\nexport interface ${cname}Constructor {\n  new (): ${cname}Instance;\n${(cls.static ?? []).map((fn) => `  ${fn.name}(${tsParams(fn.args)}): ${TS_TYPE[fn.ret] ?? fn.ret};`).join('\n')}\n}`);
    const methods = cls.methods.map((fn) => {
      const arrays = (fn.args ?? []).filter((a) => a[1] === 'f32[]');
      const stage = arrays.map(([n]) => `      const ${n}Ptr = this.${cls.scratch}(${n}.length);\n      heapF32().set(${n}, ${n}Ptr >> 2);`).join('\n');
      const call = `ex.${p}${fn.name}(${['this.ptr', ...tsCallArgs(fn.args)].join(', ')})`;
      return `    ${fn.name}(${tsParams(fn.args)}): ${TS_TYPE[fn.ret] ?? fn.ret} {\n${stage ? `${stage}\n` : ''}      ${tsWrapRet(fn, call, structs)}\n    }`;
    }).join('\n');
    const statics = (cls.static ?? []).map((fn) =>
      `    static ${fn.name}(${tsParams(fn.args)}): ${TS_TYPE[fn.ret] ?? fn.ret} {\n      ${tsWrapRet(fn, `ex.${p}${fn.name}(${tsCallArgs(fn.args).join(', ')})`, structs)}\n    }`).join('\n');
    classImpls.push(`  class ${cname}Impl implements ${cname}Instance {
    ptr: number;
    constructor() {
      this.ptr = ex.${p}new() >>> 0;
      if (this.ptr === 0) throw new Error('sim_core: ${cname} allocation failed');
    }
${statics}
    delete(): void {
      if (this.ptr !== 0) ex.${p}delete(this.ptr);
      this.ptr = 0;
    }
${methods}
  }`);
    moduleFields.push(`    ${cname}: ${cname}Impl,`);
  }
  const freeSigs = (m.functions ?? []).map((fn) => `  ${fn.name}(${tsParams(fn.args)}): ${TS_TYPE[fn.ret] ?? fn.ret};`);
  const freeImpls = (m.functions ?? []).map((fn) => {
    const call = `ex.${exportName('free', null, fn.name)}(${tsCallArgs(fn.args).join(', ')})`;
    return `    ${fn.name}(${tsParams(fn.args)}): ${TS_TYPE[fn.ret] ?? fn.ret} {\n      ${tsWrapRet(fn, call, structs)}\n    },`;
  });
  const exportList = manifestExports(m);
  return `/**
 * AUTO-GENERATED from cpp/abi.json — do not edit.
 * Regenerate: npm run codegen:wasm-abi   (scripts/codegen-wasm-abi.mjs)
 *
 * The only JS ⇄ WASM surface of sim_core (#254 §3): \`SimCoreExports\` types
 * the instance's exports (the flat C ABI in cpp/src/sim_core_abi.cpp) and
 * \`bindSimCore\` wraps them into the \`SimCoreModule\` the app uses. No
 * Embind, no ccall / cwrap: each method is one direct call into the export.
 */

${structIfaces}

/** \`WebAssembly.Instance.exports\` of sim_core.wasm, as cpp/abi.json declares them. */
export interface SimCoreExports {
  memory: WebAssembly.Memory;
${exportsIface.join('\n')}
}

/** Every function export the manifest declares, sorted (test:wasm-abi diffs the binary against it). */
export const SIM_CORE_ABI_EXPORTS: readonly string[] = [
${exportList.map((n) => `  '${n}'`).join(',\n')}
];

${classIfaces.join('\n\n')}

export interface SimCoreModule {
${(Object.keys(m.classes ?? {})).map((c) => `  ${c}: ${c}Constructor;`).join('\n')}
  /** View over the instance memory; re-read after any call that may grow the heap. */
  readonly HEAPF32: Float32Array;
${freeSigs.join('\n')}
}

/** Wrap an instantiated sim_core.wasm. */
export function bindSimCore(ex: SimCoreExports): SimCoreModule {
  let f32 = new Float32Array(ex.memory.buffer);
  let u8 = new Uint8Array(ex.memory.buffer);
  // memory.grow detaches the old buffer: rebuild the views lazily.
  const heapF32 = (): Float32Array => (f32.buffer === ex.memory.buffer ? f32 : (f32 = new Float32Array(ex.memory.buffer)));
  const heapU8 = (): Uint8Array => (u8.buffer === ex.memory.buffer ? u8 : (u8 = new Uint8Array(ex.memory.buffer)));
  const decoder = new TextDecoder();
  const cstr = (ptr: number): string => {
    const h = heapU8();
    const start = ptr >>> 0;
    let end = start;
    while (end < h.length && h[end] !== 0) end++;
    return decoder.decode(h.subarray(start, end));
  };
${readers}

${classImpls.join('\n\n')}

  return {
${moduleFields.join('\n')}
    get HEAPF32(): Float32Array {
      return heapF32();
    },
${freeImpls.join('\n')}
  };
}
`;
}

function writeOrCheck(path, content) {
  if (CHECK) {
    let existing = null;
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    if (existing !== content) {
      console.error(`[wasm-abi] stale: ${path} — run npm run codegen:wasm-abi`);
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function main() {
  const m = loadManifest();
  const errors = validate(m);
  if (errors.length) {
    for (const e of errors) console.error(`[wasm-abi] ${e}`);
    process.exit(1);
  }
  const exportsJson = `${JSON.stringify(manifestExports(m).map((n) => `_${n}`), null, 0)}\n`;
  writeOrCheck(OUT_CPP, emitCpp(m));
  writeOrCheck(OUT_TS, emitTs(m));
  writeOrCheck(OUT_EXPORTS, exportsJson);
  if (!CHECK) console.log(`[wasm-abi] wrote 3 files — ${manifestExports(m).length} exports`);
  else if (!process.exitCode) console.log('[wasm-abi] OK — generated ABI matches cpp/abi.json');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
