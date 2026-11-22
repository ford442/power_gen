/**
 * bundle-budget — the measurement behind `npm run check:bundle-budget`
 * (#258 §7), on fixture manifests. The real build is checked by that script.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { ROOT } from '../test-harness.mjs';
import { entryClosure, measureBudget } from '../check-bundle-budget.mjs';

const files = {
  'assets/index-a.js': Buffer.from('x'.repeat(4000)),
  // Incompressible, so its gzip size is its size.
  'assets/webgpu-b.js': randomBytes(3000),
  'assets/shared-c.js': Buffer.from('y'.repeat(2000)),
  'assets/lazy-d.js': randomBytes(9000)
};
const manifest = {
  'index.html': { file: 'assets/index-a.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['multi-device-visualizer.ts', 'lazy.ts'] },
  '_shared.js': { file: 'assets/shared-c.js' },
  'multi-device-visualizer.ts': { file: 'assets/webgpu-b.js', isDynamicEntry: true, imports: ['_shared.js'] },
  'lazy.ts': { file: 'assets/lazy-d.js', isDynamicEntry: true }
};
const read = (f) => files[f];

describe('bundle budget', () => {
  it('measures each budgeted chunk by the module that names it', () => {
    const rows = measureBudget(manifest, { chunks: { entry: { module: 'index.html', maxGzipKB: 1 }, webgpu: { module: 'multi-device-visualizer.ts', maxGzipKB: 4 } } }, read);
    assert.deepEqual(rows.map((r) => [r.name, r.file, r.ok]), [['entry', 'assets/index-a.js', true], ['webgpu', 'assets/webgpu-b.js', true]]);
    assert.ok(rows[0].gzip < 100, 'repetitive text compresses');
    assert.ok(rows[1].gzip >= 3000, 'random bytes do not');
  });

  it('fails a chunk over its budget', () => {
    const [row] = measureBudget(manifest, { chunks: { webgpu: { module: 'multi-device-visualizer.ts', maxGzipKB: 2 } } }, read);
    assert.equal(row.ok, false);
    assert.equal(row.problem, undefined);
  });

  it('a budgeted module missing from the manifest is a failure, not a pass', () => {
    const [row] = measureBudget(manifest, { chunks: { webgl2: { module: 'renderers/webgl2/index.js', maxGzipKB: 99 } } }, read);
    assert.equal(row.ok, false);
    assert.match(row.problem, /0 manifest entries/);
  });

  it('the entry closure follows static imports only', () => {
    const c = entryClosure(manifest, read);
    assert.equal(c.chunks, 2);
    assert.equal(c.bytes, 6000);
  });

  it('config/bundle-budget.json budgets the entry and both renderer chunks', () => {
    const budget = JSON.parse(readFileSync(join(ROOT, 'config/bundle-budget.json'), 'utf8'));
    assert.deepEqual(Object.keys(budget.chunks).sort(), ['entry', 'webgl2', 'webgpu']);
    for (const [name, spec] of Object.entries(budget.chunks)) {
      assert.ok(spec.module && spec.maxGzipKB > 0, `${name}: module + maxGzipKB`);
    }
  });
});
