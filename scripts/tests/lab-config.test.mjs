/**
 * lab-config — the LabConfig contract (#224 §1).
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
 * Usage: npm run test:lab-config   (node --test scripts/tests/lab-config.test.mjs)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** `label` or `label: detail`, as the old hand-rolled check() printed it. */
const msg = (label, detail = '') => (detail === '' ? label : `${label}: ${detail}`);

let m;
before(async () => {
  m = await bundleTs({
    contents: `
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
`,
    sourcefile: 'lab-config-entry.ts'
  });
});

const spec = (k) => m.LAB_CONFIG_FIELDS.find((f) => f.key === k);

class MemStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

describe('1. parser', () => {
  it('booleans', () => {
    for (const v of ['1', 'on', 'true', 'yes', 'ON', ' Yes ', true, 1]) {
      assert.ok(m.parseLabBool(v) === true, msg(`bool ${JSON.stringify(v)} → true`, String(m.parseLabBool(v))));
    }
    for (const v of ['0', 'off', 'false', 'no', 'OFF', false, 0]) {
      assert.ok(m.parseLabBool(v) === false, msg(`bool ${JSON.stringify(v)} → false`, String(m.parseLabBool(v))));
    }
    for (const v of ['', 'maybe', '2', null, undefined, {}, 2]) {
      assert.ok(m.parseLabBool(v) === undefined, msg(`bool ${JSON.stringify(v)} → absent`, String(m.parseLabBool(v))));
    }
  });

  it('enums and aliases', () => {
    assert.ok(m.coerceLabField('look', 'drama') === 'drama', 'enum exact');
    assert.ok(m.coerceLabField('look', 'DRAMA') === 'drama', 'enum case-insensitive');
    assert.ok(m.coerceLabField('look', 'neon') === undefined, 'enum junk → absent');
    assert.ok(m.coerceLabField('layout', 'lab') === 'roschin', 'layout alias lab → roschin');
    assert.ok(m.coerceLabField('layout', 'Godin') === 'roschin', 'layout alias godin → roschin');
    assert.ok(m.coerceLabField('layout', 'showroom') === 'searl', 'layout alias showroom → searl');
    assert.ok(m.coerceLabField('prototype', 'roschin') === 'lab', 'prototype alias roschin → lab');
    assert.ok(m.coerceLabField('frame', '0') === 'off', 'frame alias 0 → off');
    assert.ok(m.coerceLabField('frame', 'min') === 'minimal', 'frame alias min → minimal');
    assert.ok(m.coerceLabField('gpuPower', 'low') === 'low-power', 'gpuPower alias low → low-power');
    assert.ok(m.coerceLabField('gpuChores', 'off') === 'js', 'gpuChores alias off → js');
  });

  it('numbers and ints', () => {
    assert.ok(m.coerceLabField('renderScale', '3') === 1, 'number clamps high');
    assert.ok(m.coerceLabField('renderScale', '0.1') === 0.5, 'number clamps low');
    assert.ok(m.coerceLabField('renderScale', '0') === undefined
      && m.coerceLabField('renderScale', '-1') === undefined, 'number at/below exclusiveMin is absent');
    for (const v of ['abc', '', 'NaN', 'Infinity', '-']) {
      assert.ok(m.coerceLabField('drive', v) === undefined, msg(`number ${JSON.stringify(v)} → absent`, String(m.coerceLabField('drive', v))));
    }
    assert.ok(m.coerceLabField('tourStep', '1e9') === 999, 'int takes the whole value (1e9, not parseInt 1)');
    assert.ok(m.coerceLabField('tourStep', '1.5') === undefined, 'int rejects fractions');
    assert.ok(m.coerceLabField('seed', '99999999999') === 4294967295, 'seed clamps into uint32');
    assert.ok(m.coerceLabField('seed', '-4') === 0, 'seed negative clamps to 0');
  });

  it('string patterns and lists', () => {
    assert.ok(m.coerceLabField('experiment', 'lorentz-force-vs-field') === 'lorentz-force-vs-field', 'string pattern accepts a kebab id');
    assert.ok(m.coerceLabField('experiment', '<script>') === undefined, 'string pattern refuses markup');
    assert.ok(m.coerceLabField('highlight', 'a b') === undefined, 'highlight pattern refuses spaces');
    assert.ok(m.coerceLabField('mode', 'halbach-viz') === 'halbach-viz' && m.coerceLabField('mode', '../x') === undefined, 'mode pattern');

    const list = m.coerceLabField('embedOrigins', 'https://a.example, https://b.example,,');
    assert.ok(JSON.stringify(list) === '["https://a.example","https://b.example"]', msg('list splits and trims', JSON.stringify(list)));
  });

  it('setpoints', () => {
    const sps = m.coerceLabField('setpoints', { halbachSegments: 99, lorentzField: 'x', bogus: 3, pulseCoilCharge: '12' });
    const hseg = m.DEVICE_SETPOINTS.find((s) => s.id === 'halbachSegments');
    assert.ok(sps.halbachSegments === hseg.max, msg('setpoints clamp to the catalog range', JSON.stringify(sps)));
    assert.ok(!('lorentzField' in sps) && !('bogus' in sps), msg('setpoints drop non-finite and unknown ids', JSON.stringify(sps)));
    assert.ok(sps.pulseCoilCharge === 12, msg('setpoints coerce numeric strings', JSON.stringify(sps)));
    assert.ok(m.coerceLabField('setpoints', [1, 2]) === undefined, 'setpoints refuse an array');
  });
});

describe('2. precedence', () => {
  let storage;
  before(() => {
    storage = new MemStorage({ 'seg-field-coupling': 'true', 'heron-layout': 'tower', 'seg-lab-mode': 'twin' });
  });

  it('defaults', () => {
    const d = m.resolveLabConfig({});
    assert.ok(Object.values(d.sources).every((s) => s === 'default'), msg('no inputs → every field default', JSON.stringify(d.sources)));
    assert.ok(JSON.stringify(d.config) === JSON.stringify(m.LAB_CONFIG_DEFAULTS), 'defaults equal LAB_CONFIG_DEFAULTS');
  });

  it('URL > hash > storage > default', () => {
    const s = m.resolveLabConfig({ storage });
    assert.ok(s.config.fieldCoupling === true && s.sources.fieldCoupling === 'storage', 'storage layer applies');
    assert.ok(s.config.heronLayout === 'tower' && s.sources.heronLayout === 'storage', 'stored heron layout applies');

    const h = m.resolveLabConfig({ storage, hashFields: { heronLayout: 'wide', fieldCoupling: false } });
    assert.ok(h.config.heronLayout === 'wide' && h.sources.heronLayout === 'hash', 'hash beats storage');
    assert.ok(h.config.fieldCoupling === false && h.sources.fieldCoupling === 'hash', 'hash false beats stored true');
    assert.ok(h.config.labMode === 'twin' && h.sources.labMode === 'storage', 'storage still fills what the hash leaves');

    const u = m.resolveLabConfig({ search: '?heronLayout=spiral&fieldCoupling=1', storage, hashFields: { heronLayout: 'wide' } });
    assert.ok(u.config.heronLayout === 'spiral' && u.sources.heronLayout === 'url', 'URL beats hash and storage');
    assert.ok(u.config.fieldCoupling === true && u.sources.fieldCoupling === 'url', 'URL bool beats hash');

    const junk = m.resolveLabConfig({ search: '?heronLayout=disco', storage });
    assert.ok(junk.config.heronLayout === 'tower' && junk.sources.heronLayout === 'storage', 'unparsable URL value falls through to storage');
  });

  it('URL aliases', () => {
    const alias = m.resolveLabConfig({ search: '?wasm=1' });
    assert.ok(alias.config.wasmPhysics === true && alias.sources.wasmPhysics === 'url', '?wasm=1 is the wasmPhysics alias');
    assert.ok(m.resolveLabConfig({ search: '?lighting=lab' }).config.look === 'lab', '?lighting= is the look alias');
    assert.ok(m.resolveLabConfig({ search: '?class=0' }).config.classroom === false, '?class= maps to classroom');
  });

  it('storage allow-list', () => {
    const r = m.resolveLabConfig({ storage: new MemStorage({ 'seg-renderer': 'webgl2' }) });
    assert.ok(r.config.renderer === 'webgpu' && r.sources.renderer === 'default', 'stored webgl2 is refused');
    assert.ok(r.rejectedStorage.renderer === 'webgl2', msg('the refusal is reported', JSON.stringify(r.rejectedStorage)));
    assert.ok(m.resolveLabConfig({ storage: new MemStorage({ 'seg-renderer': 'webgpu' }) }).sources.renderer === 'storage', 'stored webgpu is honoured');
    assert.ok(m.resolveLabConfig({ storage: new MemStorage({ 'seg-gpu-chores': 'off' }) }).config.gpuChores === 'js', 'stored gpuChores=off kills to js');
    assert.ok(m.resolveLabConfig({ storage: new MemStorage({ 'seg-gpu-chores': 'wasm' }) }).config.gpuChores === 'auto', 'stored gpuChores=wasm is not honoured');
  });

  it('a share hash carries only share fields', () => {
    const hashRenderer = m.resolveLabConfig({ hashFields: { renderer: 'webgl2', gpuTiming: true, look: 'drama' } });
    assert.ok(hashRenderer.config.renderer === 'webgpu' && hashRenderer.config.gpuTiming === false, 'a share hash cannot pick non-share fields');
    assert.ok(hashRenderer.config.look === 'drama', '…but does carry share fields');
  });

  it('blocked storage and labConfigFor(params)', () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() {}, removeItem() {} };
    assert.ok(m.resolveLabConfig({ storage: throwing }).sources.fieldCoupling === 'default',
      'blocked storage is "nothing stored", not an exception');

    const forParams = m.labConfigFor(new URLSearchParams('fdtd=off'));
    assert.ok(forParams.config.fdtd === false && forParams.sources.fdtd === 'url', 'labConfigFor(params) resolves that query alone');
  });
});

describe('3. agreement with code constants', () => {
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  it('enum values match the code constants', () => {
    assert.ok(same(spec('layout').values, Object.keys(m.SEG_LAYOUT_PRESETS)), 'layout values = SEG_LAYOUT_PRESETS');
    assert.ok(same(spec('heronLayout').values, Object.keys(m.HERON_LAYOUT_PRESETS)), 'heronLayout values = HERON_LAYOUT_PRESETS');
    assert.ok(same(spec('labMode').values, m.LAB_MODES), 'labMode values = LAB_MODES');
    assert.ok(same(spec('look').values, Object.keys(m.LIGHTING_LOOKS)), 'look values = LIGHTING_LOOKS');
    assert.ok(same(spec('frame').values, Object.keys(m.SEG_FRAME_LEVELS)), 'frame values = SEG_FRAME_LEVELS');
    assert.ok(same(spec('fdtdDrive').values, Object.values(m.FDTD_DRIVE_SOURCES)), 'fdtdDrive values = FDTD_DRIVE_SOURCES');
    assert.ok(spec('labMode').storage.key === m.LAB_MODE_STORAGE_KEY, 'labMode storage key = LAB_MODE_STORAGE_KEY');
  });

  it('schema hash is 12 hex chars', () => {
    assert.ok(/^[0-9a-f]{12}$/.test(m.LAB_CONFIG_SCHEMA_HASH), msg('schema hash is 12 hex chars', m.LAB_CONFIG_SCHEMA_HASH));
  });

  it('docs matrix lists every URL alias', () => {
    const docs = read('docs/AGENTS.md');
    for (const f of m.LAB_CONFIG_FIELDS) {
      for (const alias of f.url) assert.ok(docs.includes(`\`${alias}\``), msg(`docs matrix lists ?${alias}`, alias));
    }
  });
});

describe('4. legacy #lab=v1', () => {
  const v1 = (h) => m.sanitizeFields(m.labHashV1ToConfig(m.decodeLabHashV1(h)), true);

  it('a full v1 link maps onto LabConfig fields', () => {
    const a = v1('#lab=v1;mode=halbach-viz;layout=roschin;heron=tower;drive=0.25;field=0.75;bmult=1.5;class=1;tour=1;hi=rollers;step=3;hseg=12;hlin=1;renderer=webgl2');
    assert.ok(a.mode === 'halbach-viz' && a.layout === 'roschin' && a.heronLayout === 'tower', msg('v1 mode/layout/heron', JSON.stringify(a)));
    assert.ok(a.drive === 0.25 && a.field === 0.75 && a.bmult === 1.5, msg('v1 drive/field/bmult', JSON.stringify(a)));
    assert.ok(a.classroom === true && a.tour === true && a.highlight === 'rollers' && a.tourStep === 3, msg('v1 class/tour/hi/step', JSON.stringify(a)));
    assert.ok(a.setpoints?.halbachSegments === 12, msg('v1 hseg → setpoints.halbachSegments on the Halbach bench', JSON.stringify(a)));
    assert.ok(a.halbachLinear === true, 'v1 hlin → halbachLinear');
    assert.ok(!('renderer' in a), 'v1 renderer is never applied');
  });

  it('per-mode setpoints', () => {
    const off = v1('#lab=v1;mode=seg;hseg=12');
    assert.ok(!off.setpoints, msg('v1 hseg on another bench is ignored (as before)', JSON.stringify(off)));
    const pc = v1('#lab=v1;mode=pulse-coil;pcap=0.5');
    const pcs = m.DEVICE_SETPOINTS.find((s) => s.id === 'pulseCoilCharge');
    assert.ok(pc.setpoints?.pulseCoilCharge === 0.5 * pcs.max, msg('v1 pcap is a fraction of the bank', JSON.stringify(pc)));
    assert.ok(!v1('#lab=v1;mode=pulse-coil;pcap=0').setpoints, 'v1 pcap=0 means unset');
    assert.ok(v1('#lab=v1;mode=lorentz-sled;lfield=0.4').setpoints?.lorentzField === 0.4, 'v1 lfield → lorentzField');
    assert.ok(!('classroom' in v1('#lab=v1;class=0')), 'v1 class=0 is not an explicit classroom');
  });

  it('decodeHashFields reads v1 and #lab2=', async () => {
    assert.ok((await m.decodeHashFields('#lab=v1;mode=vdg')).mode === 'vdg', 'decodeHashFields reads v1');
    assert.ok(Object.keys(await m.decodeHashFields('')).length === 0, 'decodeHashFields: no hash → nothing');
    const v2 = await m.encodeShareHash({ mode: 'hall', seed: 9 });
    assert.ok((await m.decodeHashFields(v2)).seed === 9, 'decodeHashFields reads #lab2=');
  });
});

describe('5. share links v2', () => {
  const fields = {
    wasmPhysics: true, seed: 1234, look: 'lab', layout: 'roschin', heronLayout: 'wide', labMode: 'lab',
    fieldCoupling: true, chargeCoupling: false, mode: 'lorentz-sled', drive: 0.4, field: 0.6, bmult: 1.2,
    tour: true, tourStep: 4, highlight: 'sled', setpoints: { lorentzField: 0.8, halbachSegments: 10 },
    experiment: 'lorentz-force-vs-field', renderer: 'webgl2', gpuTiming: true
  };

  it('compressed codec z round-trips share fields only, short and URL-safe', async () => {
    const hasZ = typeof CompressionStream === 'function';
    assert.ok(hasZ, msg('Node has CompressionStream (deflate-raw codec testable)', 'missing'));
    const z = await m.encodeShareHash(fields);
    assert.ok(!hasZ || z.startsWith('#lab2=z'), msg('compressed link uses codec z', z.slice(0, 12)));
    const back = m.sanitizeFields(await m.decodeShareHash(z), true);
    for (const [k, v] of Object.entries(fields)) {
      if (!spec(k).share) {
        assert.ok(!(k in back), msg(`${k} (not a share field) is not in the link`, JSON.stringify(back[k])));
        continue;
      }
      if (k === 'chargeCoupling') {
        assert.ok(!(k in back), msg('a default-valued field is dropped from the link', JSON.stringify(back[k])));
        continue;
      }
      assert.ok(JSON.stringify(back[k]) === JSON.stringify(v), msg(`#lab2 round-trips ${k}`, `${JSON.stringify(back[k])} vs ${JSON.stringify(v)}`));
    }
    assert.ok(z.length < 400, msg(`a full link stays short (${z.length} chars)`, String(z.length)));
    assert.ok(/^#lab2=[zj][A-Za-z0-9_-]+$/.test(z), msg('link characters are URL-safe', z));
  });

  it('json codec without CompressionStream', async () => {
    const saved = globalThis.CompressionStream;
    globalThis.CompressionStream = undefined;
    let j;
    try {
      j = await m.encodeShareHash(fields);
    } finally {
      globalThis.CompressionStream = saved;
    }
    assert.ok(j.startsWith('#lab2=j'), msg('without CompressionStream the json codec is used', j.slice(0, 12)));
    const backJ = m.sanitizeFields(await m.decodeShareHash(j), true);
    assert.ok(backJ.seed === 1234 && backJ.setpoints?.lorentzField === 0.8, msg('json codec round-trips', JSON.stringify(backJ)));
  });

  it('empty, junk and non-lab2 payloads', async () => {
    const empty = await m.encodeShareHash({});
    assert.ok(Object.keys(await m.decodeShareHash(empty)).length === 0, 'an all-default lab encodes an empty config');

    let threw = false;
    try { await m.decodeShareHash('#lab2=zAAAA'); } catch { threw = true; }
    assert.ok(threw, 'a junk compressed payload throws (page ignores it)');
    threw = false;
    try { await m.decodeShareHash('#lab2=j' + Buffer.from('{"v":2}').toString('base64url')); } catch { threw = true; }
    assert.ok(threw, 'a payload without config throws');
    assert.ok(Object.keys(await m.decodeShareHash('#lab=v1;mode=seg')).length === 0, 'a non-lab2 hash decodes to nothing');
  });

  it('a hand-edited link clamps and drops like the URL', async () => {
    const tampered = m.sanitizeFields(await m.decodeShareHash('#lab2=j' + Buffer.from(JSON.stringify({ v: 2, s: 'x', c: {
      drive: 9, seed: -3, look: 'neon', setpoints: { halbachSegments: 1000 }, renderer: 'webgl2'
    } })).toString('base64url')), true);
    assert.ok(tampered.drive === 1 && tampered.seed === 0 && !('look' in tampered)
      && tampered.setpoints.halbachSegments === m.DEVICE_SETPOINTS.find((s) => s.id === 'halbachSegments').max
      && !('renderer' in tampered), msg('a hand-edited link clamps and drops like the URL', JSON.stringify(tampered)));
  });

  it('nonDefaultShareFields keeps only changed share fields', () => {
    const nd = m.nonDefaultShareFields({ look: 'studio', layout: null, seed: 7, setpoints: {}, gpuTiming: true });
    assert.ok(JSON.stringify(nd) === '{"seed":7}', msg('nonDefaultShareFields keeps only changed share fields', JSON.stringify(nd)));
  });
});

describe('6. .lab.json', () => {
  it('lab file format id', async () => {
    const lf = await bundleTs({
      contents: "export { LAB_FILE_FORMAT, LAB_FILE_VERSION } from './src/config/lab-file.ts';",
      sourcefile: 'lab-file-entry.ts'
    });
    assert.ok(lf.LAB_FILE_FORMAT === 'seg-lab' && lf.LAB_FILE_VERSION === 1, 'lab file format id');
  });
});
