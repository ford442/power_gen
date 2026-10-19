#!/usr/bin/env node
/**
 * test-lab-config.mjs — the LabConfig contract (#224 §1).
 *
 *   1. Parser: one tolerant coercion for every layer — booleans take
 *      1/0/on/off/true/false/yes/no, enums match case-insensitively with their
 *      aliases, numbers are finite-checked and clamped, ints take the whole
 *      value, patterns gate strings, setpoints clamp to the catalog.
 *   2. Precedence: URL > share hash > localStorage > default, with the source
 *      of every field recorded; a stored value outside the spec's storage
 *      allow-list is refused (stored webgl2 never boots WebGL2).
 *   3. Agreement: enum values match the code constants they stand for.
 *   4. Legacy `#lab=v1` links map onto LabConfig fields (per-mode setpoints,
 *      pcap as a fraction, renderer never applied).
 *   5. Share links v2: `#lab2=` round-trips with both codecs, carries only
 *      share fields that differ from the defaults, stays short, and a junk
 *      payload is an error the page treats as "no hash".
 *   6. `.lab.json`: shape checks for the loader.
 *
 * Generated-file drift and the raw-access ban are `npm run check:lab-config`.
 *
 * Usage: node scripts/test-lab-config.mjs   (exit 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

async function importTsEntry(contents) {
  const result = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'lab-config-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    plugins: [viteRawStub]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail = '') {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

const m = await importTsEntry(`
export * from './src/config/lab-config.ts';
export { decodeLabHashV1, encodeLabHash, labHashV1ToConfig } from './src/config/lab-hash-v1.ts';
export { encodeShareHash, decodeShareHash } from './src/config/share-link.ts';
export { decodeHashFields, nonDefaultShareFields } from './src/config/share-url.ts';
export { LAB_CONFIG_FIELDS, LAB_CONFIG_DEFAULTS, LAB_CONFIG_SCHEMA_HASH } from './generated/lab-config.ts';
export { SEG_LAYOUT_PRESETS } from './src/seg-layout.ts';
export { HERON_LAYOUT_PRESETS } from './src/heron-layout.ts';
export { LAB_MODES, LAB_MODE_STORAGE_KEY } from './src/lab-mode.ts';
export { LIGHTING_LOOKS } from './src/seg-lighting-presets.ts';
export { SEG_FRAME_LEVELS } from './src/seg-frame-model.ts';
export { FDTD_DRIVE_SOURCES } from './src/physics/fdtd-tmz.ts';
export { DEVICE_SETPOINTS } from './generated/device-catalog.ts';
`);

const spec = (k) => m.LAB_CONFIG_FIELDS.find((f) => f.key === k);

class MemStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// ── 1. Parser ───────────────────────────────────────────────────────────────
{
  for (const v of ['1', 'on', 'true', 'yes', 'ON', ' Yes ', true, 1]) {
    check(`bool ${JSON.stringify(v)} → true`, m.parseLabBool(v) === true, String(m.parseLabBool(v)));
  }
  for (const v of ['0', 'off', 'false', 'no', 'OFF', false, 0]) {
    check(`bool ${JSON.stringify(v)} → false`, m.parseLabBool(v) === false, String(m.parseLabBool(v)));
  }
  for (const v of ['', 'maybe', '2', null, undefined, {}, 2]) {
    check(`bool ${JSON.stringify(v)} → absent`, m.parseLabBool(v) === undefined, String(m.parseLabBool(v)));
  }

  check('enum exact', m.coerceLabField('look', 'drama') === 'drama');
  check('enum case-insensitive', m.coerceLabField('look', 'DRAMA') === 'drama');
  check('enum junk → absent', m.coerceLabField('look', 'neon') === undefined);
  check('layout alias lab → roschin', m.coerceLabField('layout', 'lab') === 'roschin');
  check('layout alias godin → roschin', m.coerceLabField('layout', 'Godin') === 'roschin');
  check('layout alias showroom → searl', m.coerceLabField('layout', 'showroom') === 'searl');
  check('prototype alias roschin → lab', m.coerceLabField('prototype', 'roschin') === 'lab');
  check('frame alias 0 → off', m.coerceLabField('frame', '0') === 'off');
  check('frame alias min → minimal', m.coerceLabField('frame', 'min') === 'minimal');
  check('gpuPower alias low → low-power', m.coerceLabField('gpuPower', 'low') === 'low-power');
  check('gpuChores alias off → js', m.coerceLabField('gpuChores', 'off') === 'js');

  check('number clamps high', m.coerceLabField('renderScale', '3') === 1);
  check('number clamps low', m.coerceLabField('renderScale', '0.1') === 0.5);
  check('number at/below exclusiveMin is absent', m.coerceLabField('renderScale', '0') === undefined
    && m.coerceLabField('renderScale', '-1') === undefined);
  for (const v of ['abc', '', 'NaN', 'Infinity', '-']) {
    check(`number ${JSON.stringify(v)} → absent`, m.coerceLabField('drive', v) === undefined, String(m.coerceLabField('drive', v)));
  }
  check('int takes the whole value (1e9, not parseInt 1)', m.coerceLabField('tourStep', '1e9') === 999);
  check('int rejects fractions', m.coerceLabField('tourStep', '1.5') === undefined);
  check('seed clamps into uint32', m.coerceLabField('seed', '99999999999') === 4294967295);
  check('seed negative clamps to 0', m.coerceLabField('seed', '-4') === 0);

  check('string pattern accepts a kebab id', m.coerceLabField('experiment', 'lorentz-force-vs-field') === 'lorentz-force-vs-field');
  check('string pattern refuses markup', m.coerceLabField('experiment', '<script>') === undefined);
  check('highlight pattern refuses spaces', m.coerceLabField('highlight', 'a b') === undefined);
  check('mode pattern', m.coerceLabField('mode', 'halbach-viz') === 'halbach-viz' && m.coerceLabField('mode', '../x') === undefined);

  const list = m.coerceLabField('embedOrigins', 'https://a.example, https://b.example,,');
  check('list splits and trims', JSON.stringify(list) === '["https://a.example","https://b.example"]', JSON.stringify(list));

  const sps = m.coerceLabField('setpoints', { halbachSegments: 99, lorentzField: 'x', bogus: 3, pulseCoilCharge: '12' });
  const hseg = m.DEVICE_SETPOINTS.find((s) => s.id === 'halbachSegments');
  check('setpoints clamp to the catalog range', sps.halbachSegments === hseg.max, JSON.stringify(sps));
  check('setpoints drop non-finite and unknown ids', !('lorentzField' in sps) && !('bogus' in sps), JSON.stringify(sps));
  check('setpoints coerce numeric strings', sps.pulseCoilCharge === 12, JSON.stringify(sps));
  check('setpoints refuse an array', m.coerceLabField('setpoints', [1, 2]) === undefined);
}

// ── 2. Precedence ───────────────────────────────────────────────────────────
{
  const d = m.resolveLabConfig({});
  check('no inputs → every field default', Object.values(d.sources).every((s) => s === 'default'), JSON.stringify(d.sources));
  check('defaults equal LAB_CONFIG_DEFAULTS', JSON.stringify(d.config) === JSON.stringify(m.LAB_CONFIG_DEFAULTS));

  const storage = new MemStorage({ 'seg-field-coupling': 'true', 'heron-layout': 'tower', 'seg-lab-mode': 'twin' });
  const s = m.resolveLabConfig({ storage });
  check('storage layer applies', s.config.fieldCoupling === true && s.sources.fieldCoupling === 'storage');
  check('stored heron layout applies', s.config.heronLayout === 'tower' && s.sources.heronLayout === 'storage');

  const h = m.resolveLabConfig({ storage, hashFields: { heronLayout: 'wide', fieldCoupling: false } });
  check('hash beats storage', h.config.heronLayout === 'wide' && h.sources.heronLayout === 'hash');
  check('hash false beats stored true', h.config.fieldCoupling === false && h.sources.fieldCoupling === 'hash');
  check('storage still fills what the hash leaves', h.config.labMode === 'twin' && h.sources.labMode === 'storage');

  const u = m.resolveLabConfig({ search: '?heronLayout=spiral&fieldCoupling=1', storage, hashFields: { heronLayout: 'wide' } });
  check('URL beats hash and storage', u.config.heronLayout === 'spiral' && u.sources.heronLayout === 'url');
  check('URL bool beats hash', u.config.fieldCoupling === true && u.sources.fieldCoupling === 'url');

  const junk = m.resolveLabConfig({ search: '?heronLayout=disco', storage });
  check('unparsable URL value falls through to storage', junk.config.heronLayout === 'tower' && junk.sources.heronLayout === 'storage');

  const alias = m.resolveLabConfig({ search: '?wasm=1' });
  check('?wasm=1 is the wasmPhysics alias', alias.config.wasmPhysics === true && alias.sources.wasmPhysics === 'url');
  check('?lighting= is the look alias', m.resolveLabConfig({ search: '?lighting=lab' }).config.look === 'lab');
  check('?class= maps to classroom', m.resolveLabConfig({ search: '?class=0' }).config.classroom === false);

  const r = m.resolveLabConfig({ storage: new MemStorage({ 'seg-renderer': 'webgl2' }) });
  check('stored webgl2 is refused', r.config.renderer === 'webgpu' && r.sources.renderer === 'default');
  check('the refusal is reported', r.rejectedStorage.renderer === 'webgl2', JSON.stringify(r.rejectedStorage));
  check('stored webgpu is honoured', m.resolveLabConfig({ storage: new MemStorage({ 'seg-renderer': 'webgpu' }) }).sources.renderer === 'storage');
  check('stored gpuChores=off kills to js', m.resolveLabConfig({ storage: new MemStorage({ 'seg-gpu-chores': 'off' }) }).config.gpuChores === 'js');
  check('stored gpuChores=wasm is not honoured', m.resolveLabConfig({ storage: new MemStorage({ 'seg-gpu-chores': 'wasm' }) }).config.gpuChores === 'auto');

  const hashRenderer = m.resolveLabConfig({ hashFields: { renderer: 'webgl2', gpuTiming: true, look: 'drama' } });
  check('a share hash cannot pick non-share fields', hashRenderer.config.renderer === 'webgpu' && hashRenderer.config.gpuTiming === false);
  check('…but does carry share fields', hashRenderer.config.look === 'drama');

  const throwing = { getItem() { throw new Error('blocked'); }, setItem() {}, removeItem() {} };
  check('blocked storage is "nothing stored", not an exception',
    m.resolveLabConfig({ storage: throwing }).sources.fieldCoupling === 'default');

  const forParams = m.labConfigFor(new URLSearchParams('fdtd=off'));
  check('labConfigFor(params) resolves that query alone', forParams.config.fdtd === false && forParams.sources.fdtd === 'url');
}

// ── 3. Agreement with code constants ───────────────────────────────────────
{
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  check('layout values = SEG_LAYOUT_PRESETS', same(spec('layout').values, Object.keys(m.SEG_LAYOUT_PRESETS)));
  check('heronLayout values = HERON_LAYOUT_PRESETS', same(spec('heronLayout').values, Object.keys(m.HERON_LAYOUT_PRESETS)));
  check('labMode values = LAB_MODES', same(spec('labMode').values, m.LAB_MODES));
  check('look values = LIGHTING_LOOKS', same(spec('look').values, Object.keys(m.LIGHTING_LOOKS)));
  check('frame values = SEG_FRAME_LEVELS', same(spec('frame').values, Object.keys(m.SEG_FRAME_LEVELS)));
  check('fdtdDrive values = FDTD_DRIVE_SOURCES', same(spec('fdtdDrive').values, Object.values(m.FDTD_DRIVE_SOURCES)));
  check('labMode storage key = LAB_MODE_STORAGE_KEY', spec('labMode').storage.key === m.LAB_MODE_STORAGE_KEY);
  check('schema hash is 12 hex chars', /^[0-9a-f]{12}$/.test(m.LAB_CONFIG_SCHEMA_HASH), m.LAB_CONFIG_SCHEMA_HASH);
  const docs = read('docs/AGENTS.md');
  for (const f of m.LAB_CONFIG_FIELDS) {
    for (const alias of f.url) check(`docs matrix lists ?${alias}`, docs.includes(`\`${alias}\``), alias);
  }
}

// ── 4. Legacy #lab=v1 ───────────────────────────────────────────────────────
{
  const v1 = (h) => m.sanitizeFields(m.labHashV1ToConfig(m.decodeLabHashV1(h)), true);
  const a = v1('#lab=v1;mode=halbach-viz;layout=roschin;heron=tower;drive=0.25;field=0.75;bmult=1.5;class=1;tour=1;hi=rollers;step=3;hseg=12;hlin=1;renderer=webgl2');
  check('v1 mode/layout/heron', a.mode === 'halbach-viz' && a.layout === 'roschin' && a.heronLayout === 'tower', JSON.stringify(a));
  check('v1 drive/field/bmult', a.drive === 0.25 && a.field === 0.75 && a.bmult === 1.5, JSON.stringify(a));
  check('v1 class/tour/hi/step', a.classroom === true && a.tour === true && a.highlight === 'rollers' && a.tourStep === 3, JSON.stringify(a));
  check('v1 hseg → setpoints.halbachSegments on the Halbach bench', a.setpoints?.halbachSegments === 12, JSON.stringify(a));
  check('v1 hlin → halbachLinear', a.halbachLinear === true);
  check('v1 renderer is never applied', !('renderer' in a));
  const off = v1('#lab=v1;mode=seg;hseg=12');
  check('v1 hseg on another bench is ignored (as before)', !off.setpoints, JSON.stringify(off));
  const pc = v1('#lab=v1;mode=pulse-coil;pcap=0.5');
  const pcs = m.DEVICE_SETPOINTS.find((s) => s.id === 'pulseCoilCharge');
  check('v1 pcap is a fraction of the bank', pc.setpoints?.pulseCoilCharge === 0.5 * pcs.max, JSON.stringify(pc));
  check('v1 pcap=0 means unset', !v1('#lab=v1;mode=pulse-coil;pcap=0').setpoints);
  check('v1 lfield → lorentzField', v1('#lab=v1;mode=lorentz-sled;lfield=0.4').setpoints?.lorentzField === 0.4);
  check('v1 class=0 is not an explicit classroom', !('classroom' in v1('#lab=v1;class=0')));
  check('decodeHashFields reads v1', (await m.decodeHashFields('#lab=v1;mode=vdg')).mode === 'vdg');
  check('decodeHashFields: no hash → nothing', Object.keys(await m.decodeHashFields('')).length === 0);
  const v2 = await m.encodeShareHash({ mode: 'hall', seed: 9 });
  check('decodeHashFields reads #lab2=', (await m.decodeHashFields(v2)).seed === 9);
}

// ── 5. Share links v2 ──────────────────────────────────────────────────────
{
  const fields = {
    wasmPhysics: true, seed: 1234, look: 'lab', layout: 'roschin', heronLayout: 'wide', labMode: 'lab',
    fieldCoupling: true, chargeCoupling: false, mode: 'lorentz-sled', drive: 0.4, field: 0.6, bmult: 1.2,
    tour: true, tourStep: 4, highlight: 'sled', setpoints: { lorentzField: 0.8, halbachSegments: 10 },
    experiment: 'lorentz-force-vs-field', renderer: 'webgl2', gpuTiming: true
  };
  const hasZ = typeof CompressionStream === 'function';
  check('Node has CompressionStream (deflate-raw codec testable)', hasZ, 'missing');
  const z = await m.encodeShareHash(fields);
  check('compressed link uses codec z', !hasZ || z.startsWith('#lab2=z'), z.slice(0, 12));
  const back = m.sanitizeFields(await m.decodeShareHash(z), true);
  for (const [k, v] of Object.entries(fields)) {
    if (!spec(k).share) {
      check(`${k} (not a share field) is not in the link`, !(k in back), JSON.stringify(back[k]));
      continue;
    }
    if (k === 'chargeCoupling') {
      check('a default-valued field is dropped from the link', !(k in back), JSON.stringify(back[k]));
      continue;
    }
    check(`#lab2 round-trips ${k}`, JSON.stringify(back[k]) === JSON.stringify(v), `${JSON.stringify(back[k])} vs ${JSON.stringify(v)}`);
  }
  check(`a full link stays short (${z.length} chars)`, z.length < 400, String(z.length));
  check('link characters are URL-safe', /^#lab2=[zj][A-Za-z0-9_-]+$/.test(z), z);

  const saved = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  const j = await m.encodeShareHash(fields);
  globalThis.CompressionStream = saved;
  check('without CompressionStream the json codec is used', j.startsWith('#lab2=j'), j.slice(0, 12));
  const backJ = m.sanitizeFields(await m.decodeShareHash(j), true);
  check('json codec round-trips', backJ.seed === 1234 && backJ.setpoints?.lorentzField === 0.8, JSON.stringify(backJ));

  const empty = await m.encodeShareHash({});
  check('an all-default lab encodes an empty config', Object.keys(await m.decodeShareHash(empty)).length === 0);

  let threw = false;
  try { await m.decodeShareHash('#lab2=zAAAA'); } catch { threw = true; }
  check('a junk compressed payload throws (page ignores it)', threw);
  threw = false;
  try { await m.decodeShareHash('#lab2=j' + Buffer.from('{"v":2}').toString('base64url')); } catch { threw = true; }
  check('a payload without config throws', threw);
  check('a non-lab2 hash decodes to nothing', Object.keys(await m.decodeShareHash('#lab=v1;mode=seg')).length === 0);

  const tampered = m.sanitizeFields(await m.decodeShareHash('#lab2=j' + Buffer.from(JSON.stringify({ v: 2, s: 'x', c: {
    drive: 9, seed: -3, look: 'neon', setpoints: { halbachSegments: 1000 }, renderer: 'webgl2'
  } })).toString('base64url')), true);
  check('a hand-edited link clamps and drops like the URL', tampered.drive === 1 && tampered.seed === 0 && !('look' in tampered)
    && tampered.setpoints.halbachSegments === m.DEVICE_SETPOINTS.find((s) => s.id === 'halbachSegments').max
    && !('renderer' in tampered), JSON.stringify(tampered));

  const nd = m.nonDefaultShareFields({ look: 'studio', layout: null, seed: 7, setpoints: {}, gpuTiming: true });
  check('nonDefaultShareFields keeps only changed share fields', JSON.stringify(nd) === '{"seed":7}', JSON.stringify(nd));
}

// ── 6. .lab.json ───────────────────────────────────────────────────────────
{
  const lf = await importTsEntry(`export { LAB_FILE_FORMAT, LAB_FILE_VERSION } from './src/config/lab-file.ts';`);
  check('lab file format id', lf.LAB_FILE_FORMAT === 'seg-lab' && lf.LAB_FILE_VERSION === 1);
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error(`[lab-config] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[lab-config] ${ok.length} checks passed`);
