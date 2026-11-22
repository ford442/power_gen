#!/usr/bin/env node
/**
 * Hash of every input compiled into sim_core.wasm.
 *
 * `make wasm` bakes it into the binary (`sim_core_source_hash()`), and
 * vite.config.js defines the same value as `__SIM_CORE_SOURCE_HASH__` at site
 * build time. When they differ the shipped binary predates its sources — e.g.
 * Pages deployed before build-wasm.yml committed the rebuild (that commit is
 * `[skip ci]`, so it does not redeploy) — and the loader says so.
 *
 * Inputs: cpp/src/** (.cpp/.h), generated/*.h, generated/sim-core-exports.json
 * (the link's EXPORTED_FUNCTIONS), cpp/emscripten.flags, cpp/Makefile, and the
 * emsdk pin from config/toolchain.json. Path + bytes, sorted, sha256, first
 * 16 hex.
 *
 * The emsdk pin is hashed as the one-line file `cpp/emsdk-version` it used to
 * be (#258 moved the pin into config/toolchain.json): same path, same bytes,
 * so moving it did not stale the committed binary — and bumping naga or
 * Playwright in that file does not either. Bumping emsdk does, which is the
 * point: a binary built with the old compiler reads as stale until rebuilt.
 *
 * Usage: node scripts/sim-core-source-hash.mjs   → prints the hash
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolchain } from './toolchain.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function* walk(dir, filter) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(full, filter);
    else if (ent.isFile() && filter(ent.name)) yield full;
  }
}

/** Sorted repo-relative input paths. */
export function simCoreSourceInputs(root = ROOT) {
  const files = [
    ...walk(join(root, 'cpp/src'), (n) => /\.(cpp|h|hpp)$/.test(n)),
    ...walk(join(root, 'generated'), (n) => n.endsWith('.h')),
    ...['generated/sim-core-exports.json', 'cpp/emscripten.flags', 'cpp/Makefile'].map((p) => join(root, p)).filter(existsSync)
  ];
  return [...files.map((f) => relative(root, f).split('\\').join('/')), EMSDK_PIN_INPUT].sort();
}

/** Virtual input: the emsdk pin, under the path it had as a file. */
const EMSDK_PIN_INPUT = 'cpp/emsdk-version';

export function simCoreSourceHash(root = ROOT) {
  const h = createHash('sha256');
  for (const rel of simCoreSourceInputs(root)) {
    // Normalise CRLF so a Windows checkout hashes like CI.
    const text = rel === EMSDK_PIN_INPUT
      ? `${toolchain(root).emsdk}\n`
      : readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${rel}\0${text}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${simCoreSourceHash()}\n`);
}
