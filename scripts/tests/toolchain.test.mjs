/**
 * toolchain — config/toolchain.json is the one pin file (#258 §6).
 *
 * `check:toolchain` (scripts/toolchain.mjs --check) is the gate on the repo;
 * this pins down what that gate catches, with fixtures.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findHardCoded, toolchain } from '../toolchain.mjs';
import { simCoreSourceHash, simCoreSourceInputs } from '../sim-core-source-hash.mjs';

describe('toolchain pins', () => {
  const pins = toolchain();

  it('has the four tools, as version strings', () => {
    assert.deepEqual(Object.keys(pins).sort(), ['emsdk', 'naga', 'node', 'playwright']);
    for (const [tool, v] of Object.entries(pins)) assert.match(v, /^\d+(\.\d+){0,2}$/, `${tool}: "${v}"`);
  });

  it('the emsdk pin is an input of the sim_core source hash, under its old path', () => {
    // Same path + bytes as the cpp/emsdk-version file it replaced, so the
    // move did not stale the committed binary; bumping emsdk still does.
    assert.ok(simCoreSourceInputs().includes('cpp/emsdk-version'));
    assert.match(simCoreSourceHash(), /^[0-9a-f]{16}$/);
  });
});

describe('check:toolchain finds a hard-coded version', () => {
  const hits = (text, file = 'docs/X.md', allowed = []) => findHardCoded({ [file]: text }, allowed);

  it('emsdk / emscripten, naga, playwright, a workflow node-version', () => {
    assert.equal(hits('./emsdk install 3.1.61')[0]?.tool, 'emsdk');
    assert.equal(hits('built with Emscripten 4.0.12')[0]?.version, '4.0.12');
    assert.equal(hits('cargo install naga-cli --version 0.19.0 --locked')[0]?.tool, 'naga');
    assert.equal(hits('key: naga-cli-0.19.0-${{ runner.os }}')[0]?.version, '0.19.0');
    assert.equal(hits('"@playwright/test": "^1.64.1"', 'package.json')[0]?.tool, 'playwright');
    assert.equal(hits("          node-version: '22'", '.github/workflows/x.yml')[0]?.version, '22');
  });

  it('reports file and line', () => {
    const [h] = hits('line one\nline two\nuse naga 29.0.3 here\n');
    assert.deepEqual([h.file, h.line, h.text], ['docs/X.md', 3, 'use naga 29.0.3 here']);
  });

  it('leaves alone a tool name with no version, and a version read from the pin', () => {
    assert.deepEqual(hits('naga validates each module; Chrome compiles with Tint'), []);
    assert.deepEqual(hits('cargo install naga-cli --version "$(node scripts/toolchain.mjs naga)" --locked'), []);
    assert.deepEqual(hits('emsdk install "$EMSDK_PIN"'), []);
    assert.deepEqual(hits("node-version-file: '.nvmrc'", '.github/workflows/x.yml'), []);
    // An unrelated version on a line that never names a tool.
    assert.deepEqual(hits('protocol 3.1.61 of something else'), []);
  });

  it('an allowlist entry is per file and per line', () => {
    const allowed = [{ file: 'cpp/bench.json', match: '"flags"' }];
    assert.deepEqual(hits('"flags": "-O3; emsdk 3.1.61"', 'cpp/bench.json', allowed), []);
    assert.equal(hits('"notes": "emsdk 3.1.61"', 'cpp/bench.json', allowed).length, 1);
    assert.equal(hits('"flags": "-O3; emsdk 3.1.61"', 'docs/other.md', allowed).length, 1);
  });
});
