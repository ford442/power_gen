#!/usr/bin/env node
/**
 * test-prop-registry.mjs — contracts for the per-device glTF CAD props
 * (ADR-0005 WS1, epic #203 WS B).
 *
 * The prop pipeline fails *late* and *quietly*: a bad URL, a GLB the hand-rolled
 * loader can't read, or a prop wired to a device id that doesn't exist all look
 * fine until someone focuses that bench, at which point `setup-gltf.ts` logs a
 * warning and the CAD silently isn't there. And a committed GLB that drifts over
 * the byte budget only shows up as a slower Pages load.
 *
 * So this checks, for every registry entry:
 *
 *   1. Shape: unique id, a real device id, a load policy, an `enabled` predicate.
 *   2. The file exists, is under its `softBudgetBytes`, and is a structurally
 *      valid GLB by the spec's own rules (`glbSpecProblems`) — what external
 *      tools read, which our loader is more forgiving than.
 *   3. It **parses with this repo's own loader** (`parseGlb` + `extractGltfMeshes`)
 *      and yields triangles with positions, normals and UVs — the exact path the
 *      runtime takes. This is also the tripwire for the deferred external-parser
 *      decision: the day an artist asset needs an extension the hand-rolled
 *      loader lacks, it fails here with a named prop.
 *   4. Per-device selection: `propsForDevice` / `listFocusPropIds` /
 *      `listResidentPropIds` are scoped, and the `?gltf…=0` switches work.
 *   5. Material resolution: registry overrides beat glTF extras, and a prop with
 *      no override still resolves to something drawable.
 *
 * Usage: node scripts/test-prop-registry.mjs   (exit 1 on failure)
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
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

async function importTsBundle(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    plugins: [viteRawStub]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

const registry = await importTsBundle('src/assets/gltf/prop-registry.ts');
const loader = await importTsBundle('src/assets/gltf/gltf-loader.ts');
const catalog = await importTsBundle('generated/device-catalog.ts');

const props = registry.SEG_GLTF_PROPS;
/** Every id the device catalog knows about. */
const catalogIds = new Set((catalog.DEVICE_CATALOG ?? []).map((d) => d?.id).filter(Boolean));

/** `./assets/x/y.glb` (as the browser sees it) → a path under src/public. */
function assetPath(url) {
  return join(ROOT, 'src/public', url.replace(/^\.?\//, ''));
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/**
 * Structural glTF 2.0 / GLB rules that this repo's loader does not need but
 * external readers check. Our loader reads interleaved attributes by stride and
 * never looks at a bufferView's byteLength, so every placeholder GLB shipped
 * with accessors overrunning their views ~2.7× and nothing here noticed — until
 * cgltf (gltfpack) refused all nine ("buffer too short"). An artist's first
 * step is importing the placeholder they are replacing into a DCC tool, so this
 * is checked rather than assumed. Returns a list of problems (empty = valid).
 */
function glbSpecProblems(buf) {
  const problems = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return ['not a GLB (magic)'];
  if (dv.getUint32(4, true) !== 2) problems.push(`GLB version ${dv.getUint32(4, true)}`);
  if (dv.getUint32(8, true) !== buf.byteLength) problems.push('header length ≠ file length');
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) return [...problems, 'first chunk is not JSON'];
  if (jsonLen % 4) problems.push('JSON chunk not 4-byte padded');
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
  // gltf-loader.ts implements no extensions, so a meshopt / quantized file
  // must fail here by name, not decode as garbage (docs/GLTF_ASSETS.md → meshopt).
  for (const ext of json.extensionsRequired ?? []) {
    problems.push(`requires ${ext}, which src/assets/gltf/gltf-loader.ts does not implement`);
  }
  let binLen = 0;
  const binAt = 20 + jsonLen;
  if (binAt + 8 <= buf.byteLength) {
    binLen = dv.getUint32(binAt, true);
    if (dv.getUint32(binAt + 4, true) !== 0x004e4942) problems.push('second chunk is not BIN');
    if (binAt + 8 + binLen > buf.byteLength) problems.push('BIN chunk runs past the file');
  }
  const buffers = json.buffers ?? [];
  if (buffers[0] && buffers[0].uri === undefined && buffers[0].byteLength > binLen) {
    problems.push(`buffer 0 declares ${buffers[0].byteLength} B, BIN chunk holds ${binLen}`);
  }
  const views = json.bufferViews ?? [];
  views.forEach((v, i) => {
    const b = buffers[v.buffer];
    if (!b) { problems.push(`bufferView ${i} → missing buffer ${v.buffer}`); return; }
    if ((v.byteOffset ?? 0) + v.byteLength > b.byteLength) problems.push(`bufferView ${i} runs past its buffer`);
    if (v.byteStride !== undefined && (v.byteStride < 4 || v.byteStride > 252 || v.byteStride % 4)) {
      problems.push(`bufferView ${i} byteStride ${v.byteStride}`);
    }
  });
  (json.accessors ?? []).forEach((a, i) => {
    const comp = COMPONENT_BYTES[a.componentType];
    const n = TYPE_COMPONENTS[a.type];
    if (!comp || !n) { problems.push(`accessor ${i} type ${a.type}/${a.componentType}`); return; }
    if (a.bufferView === undefined) return;
    const v = views[a.bufferView];
    if (!v) { problems.push(`accessor ${i} → missing bufferView ${a.bufferView}`); return; }
    const elem = comp * n;
    const stride = v.byteStride ?? elem;
    const off = a.byteOffset ?? 0;
    if (off % comp) problems.push(`accessor ${i} byteOffset ${off} not aligned to ${comp}`);
    if (v.byteStride !== undefined && off + elem > stride) problems.push(`accessor ${i} element straddles the stride`);
    const need = off + stride * (a.count - 1) + elem;
    if (need > v.byteLength) problems.push(`accessor ${i} needs ${need} B of bufferView ${a.bufferView}, which has ${v.byteLength}`);
  });
  for (const [mi, mesh] of (json.meshes ?? []).entries()) {
    for (const [pi, prim] of (mesh.primitives ?? []).entries()) {
      const counts = Object.values(prim.attributes ?? {}).map((ai) => json.accessors?.[ai]?.count);
      if (new Set(counts).size > 1) problems.push(`mesh ${mi}/${pi} attributes disagree on count`);
      const pos = json.accessors?.[prim.attributes?.POSITION];
      if (pos && (!pos.min || !pos.max)) problems.push(`mesh ${mi}/${pi} POSITION lacks min/max`);
    }
  }
  (json.images ?? []).forEach((img, i) => {
    if (img.bufferView !== undefined && !views[img.bufferView]) problems.push(`image ${i} → missing bufferView`);
  });
  return problems;
}

// ── 1. Registry shape ──────────────────────────────────────────────────────
{
  check('registry is non-empty', Array.isArray(props) && props.length >= 6,
    `${props?.length} entries`);
  const ids = props.map((p) => p.id);
  check('prop ids are unique', new Set(ids).size === ids.length, ids.join(', '));
  check('prop urls are unique', new Set(props.map((p) => p.url)).size === props.length,
    'two props share a URL');

  for (const p of props) {
    check(`${p.id} names a device`, typeof p.deviceId === 'string' && p.deviceId.length > 0,
      JSON.stringify(p.deviceId));
    // A prop wired to a device that isn't registered can never load.
    if (catalogIds.size) {
      check(`${p.id} → "${p.deviceId}" is a catalog device`, catalogIds.has(p.deviceId),
        `${p.deviceId} is not in the device catalog (${[...catalogIds].join(', ')})`);
    }
    check(`${p.id} has a load policy`, p.loadPolicy === 'focus' || p.loadPolicy === 'resident',
      String(p.loadPolicy));
    check(`${p.id} has an enabled predicate`, typeof p.enabled === 'function',
      typeof p.enabled);
    check(`${p.id} has a role`, typeof p.role === 'string' && p.role.length > 0, String(p.role));
    check(`${p.id} declares a byte budget`,
      typeof p.softBudgetBytes === 'number' && p.softBudgetBytes > 0,
      String(p.softBudgetBytes));
  }

  // Only SEG may keep GPU buffers across a mode change: any other bench holding
  // resident CAD would defeat the point of per-device loading.
  const nonSegResident = props.filter((p) => p.loadPolicy === 'resident' && p.deviceId !== 'seg');
  check('only SEG has resident props', nonSegResident.length === 0,
    nonSegResident.map((p) => `${p.id}@${p.deviceId}`).join(', '));

  // The epic's acceptance: at least two non-SEG focus views load a lazy GLB.
  const nonSegDevices = new Set(props.filter((p) => p.deviceId !== 'seg' && !p.placeholder)
    .map((p) => p.deviceId));
  check(`non-SEG devices with CAD: ${[...nonSegDevices].join(', ') || 'none'}`,
    nonSegDevices.size >= 2,
    `only ${nonSegDevices.size} non-SEG device(s) have props`);
}

// ── 2 & 3. Files exist, fit the budget, and parse with our own loader ───────
for (const p of props) {
  if (p.placeholder) {
    ok.push(`${p.id} is a registry placeholder (no file expected)`);
    continue;
  }
  const file = assetPath(p.url);
  if (!existsSync(file)) {
    failures.push(`${p.id} asset missing: ${p.url} → ${file.replace(ROOT, '')}`);
    continue;
  }
  const bytes = statSync(file).size;
  ok.push(`${p.id} asset present (${bytes} bytes)`);
  check(`${p.id} is within its ${p.softBudgetBytes} B budget`, bytes <= p.softBudgetBytes,
    `${bytes} B exceeds ${p.softBudgetBytes} B — shrink it or raise the budget deliberately`);

  const specProblems = glbSpecProblems(readFileSync(file));
  check(`${p.id} is a spec-valid GLB (accessors fit their views — cgltf reads it, not just our loader)`,
    specProblems.length === 0, specProblems.slice(0, 3).join('; '));

  // The runtime path, exactly: parseGlb → extractGltfMeshes.
  let extracted = null;
  try {
    const buf = readFileSync(file);
    const doc = loader.parseGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    extracted = loader.extractGltfMeshes(doc);
    ok.push(`${p.id} parses with the hand-rolled GLB loader`);
  } catch (err) {
    failures.push(`${p.id} failed to parse: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  const meshes = extracted.meshes ?? [];
  const prims = meshes.flatMap((mesh) => mesh.primitives ?? []);
  check(`${p.id} yields geometry`, prims.length > 0, `${meshes.length} mesh(es), no primitives`);
  for (const prim of prims) {
    const verts = prim.vertices;
    const idx = prim.indices;
    check(`${p.id} primitive has vertices`, verts?.length > 0, `${verts?.length} floats`);
    // gltf-gpu.ts uploads 8-float vertices: pos(3) + normal(3) + uv(2).
    check(`${p.id} vertex stride is 8 floats`, verts.length % 8 === 0,
      `${verts.length} floats is not a multiple of 8`);
    check(`${p.id} has triangles`, idx?.length > 0 && idx.length % 3 === 0,
      `${idx?.length} indices`);
    check(`${p.id} indices are in range`,
      Array.from(idx).every((i) => i >= 0 && i < verts.length / 8),
      'an index points past the vertex array');
    check(`${p.id} vertex data is finite`, Array.from(verts).every((v) => Number.isFinite(v)),
      'NaN/Inf in the vertex buffer');
    // Unit-ish normals: a zero normal turns the PBR pass black.
    let worstNormal = 0;
    for (let i = 0; i < verts.length; i += 8) {
      const len = Math.hypot(verts[i + 3], verts[i + 4], verts[i + 5]);
      worstNormal = Math.max(worstNormal, Math.abs(len - 1));
    }
    check(`${p.id} normals are unit length (err ${worstNormal.toExponential(1)})`,
      worstNormal < 1e-3, `worst normal length error ${worstNormal}`);

    // Triangle winding. `segEnhanced` is the only pipeline in the repo with
    // `cullMode: 'back'`, and it is the one that draws these props, so a prop
    // wound the wrong way simply is not on screen. Nothing else can catch that:
    // not typecheck, not naga, not any test without a GPU.
    //
    // The convention (see scripts/lib/seg-placeholder-glb.mjs) is that each
    // triangle's geometric normal is ANTI-parallel to its vertex normals, as
    // box() and the shipped coil-former cylinderY both emit.
    let flipped = 0;
    let checked = 0;
    let worstFacing = 1;
    const at3 = (arr, i) => [arr[i * 8 + 0], arr[i * 8 + 1], arr[i * 8 + 2]];
    const nrm3 = (arr, i) => [arr[i * 8 + 3], arr[i * 8 + 4], arr[i * 8 + 5]];
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const [ia, ib, ic] = [idx[t], idx[t + 1], idx[t + 2]];
      const p0 = at3(verts, ia);
      const p1 = at3(verts, ib);
      const p2 = at3(verts, ic);
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const g = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0]
      ];
      const gl = Math.hypot(...g);
      const vn = [0, 1, 2].map((k) =>
        (nrm3(verts, ia)[k] + nrm3(verts, ib)[k] + nrm3(verts, ic)[k]) / 3);
      const vl = Math.hypot(...vn);
      // Degenerate triangles and zero normals carry no winding information.
      if (gl < 1e-9 || vl < 1e-9) continue;
      const align = -(g[0] * vn[0] + g[1] * vn[1] + g[2] * vn[2]) / (gl * vl);
      checked += 1;
      worstFacing = Math.min(worstFacing, align);
      if (align < 0.2) flipped += 1;
    }
    check(`${p.id} winding matches the culled-pipeline convention `
      + `(${checked} tris, worst ${worstFacing.toFixed(2)})`,
      checked > 0 && flipped === 0,
      `${flipped} of ${checked} triangle(s) wound the wrong way — segEnhanced `
      + 'culls back faces, so those surfaces are invisible');
  }

  // The runtime reads `extras.power_gen.role` off the nodes; a prop whose GLB
  // forgot it falls back to the registry role, but the drift is worth flagging.
  const roles = (extracted.nodes ?? [])
    .map((n) => n.extras?.power_gen?.role)
    .filter(Boolean);
  check(`${p.id} GLB declares role "${p.role}"`, roles.includes(p.role),
    `GLB roles are [${roles.join(', ')}], registry says "${p.role}"`);
}

// ── 4. Per-device selection and the kill switches ───────────────────────────
{
  const all = new URLSearchParams('');
  const devices = [...new Set(props.map((p) => p.deviceId))];
  for (const deviceId of devices) {
    const forDevice = registry.propsForDevice(deviceId, all);
    check(`propsForDevice("${deviceId}") is scoped`,
      forDevice.length > 0 && forDevice.every((p) => p.deviceId === deviceId),
      forDevice.map((p) => `${p.id}@${p.deviceId}`).join(', '));
  }
  check('propsForDevice on an unknown device is empty',
    registry.propsForDevice('not-a-bench', all).length === 0, 'it returned props');

  check('listResidentPropIds is SEG-only',
    registry.listResidentPropIds(all).includes('housing')
      && registry.listResidentPropIds(all, 'transformer').length === 0,
    JSON.stringify([registry.listResidentPropIds(all), registry.listResidentPropIds(all, 'transformer')]));
  check('listFocusPropIds defaults to SEG',
    registry.listFocusPropIds(all).every((id) => registry.getPropDef(id)?.deviceId === 'seg'),
    registry.listFocusPropIds(all).join(', '));
  check('listFocusPropIds is scoped per device',
    registry.listFocusPropIds(all, 'transformer').length > 0
      && registry.listFocusPropIds(all, 'transformer')
        .every((id) => registry.getPropDef(id)?.deviceId === 'transformer'),
    registry.listFocusPropIds(all, 'transformer').join(', '));

  check('listPropDeviceIds covers every entry',
    new Set(registry.listPropDeviceIds()).size === devices.length,
    `${registry.listPropDeviceIds().join(', ')} vs ${devices.join(', ')}`);

  // `?gltfHousing=0` is the *default* for every prop, so on its own it clears them all.
  const off = new URLSearchParams('gltfHousing=0');
  for (const deviceId of devices) {
    const enabled = registry.propsForDevice(deviceId, off).filter((p) => p.enabled(off));
    check(`?gltfHousing=0 disables ${deviceId} props`, enabled.length === 0,
      enabled.map((p) => p.id).join(', '));
  }

  // ...but an explicit per-prop value beats that default, which is how you look
  // at one prop with the rest of the assembly out of the way. Pinned in both
  // directions so the precedence cannot drift silently either way.
  const soloCases = [
    ['gltfHousing=0&gltfTransformerCore=1', 'transformerCore', 'transformer'],
    ['gltfHousing=0&gltfVdgTerminal=1', 'vdgTerminal', 'vdg'],
    ['gltfHousing=0&gltfKelvinJars=1', 'kelvinJars', 'kelvin'],
    ['gltfHousing=0&gltfThomsonStand=1', 'thomsonStand', 'jumping-ring'],
    ['gltfHousing=0&gltfHeronVessels=1', 'heronVessels', 'heron'],
    ['gltfHousing=0&gltfStand=1', 'stand', 'seg']
  ];
  for (const [query, id, deviceId] of soloCases) {
    const params = new URLSearchParams(query);
    const def = registry.getPropDef(id);
    if (!def) continue;
    check(`?${query} keeps ${id} alone`, def.enabled(params) === true,
      `${id} was disabled despite an explicit =1`);
    const others = registry.propsForDevice(deviceId, params).filter((p) => p.id !== id);
    check(`?${query} leaves ${deviceId}'s other props off`,
      others.every((p) => p.enabled(params) === false),
      others.filter((p) => p.enabled(params)).map((p) => p.id).join(', '));
  }

  // Per-prop switches take a prop out without disturbing its neighbours.
  const perProp = [
    ['gltfCoilFormer=0', 'coilFormer', 'seg'],
    ['gltfStand=0', 'stand', 'seg'],
    ['gltfBasePlate=0', 'basePlate', 'seg'],
    ['gltfTransformerCore=0', 'transformerCore', 'transformer'],
    ['gltfVdgTerminal=0', 'vdgTerminal', 'vdg'],
    ['gltfHeronVessels=0', 'heronVessels', 'heron'],
    ['gltfKelvinJars=0', 'kelvinJars', 'kelvin'],
    ['gltfThomsonStand=0', 'thomsonStand', 'jumping-ring']
  ];
  for (const [query, id, deviceId] of perProp) {
    const params = new URLSearchParams(query);
    const def = registry.getPropDef(id);
    check(`${id} exists in the registry`, !!def, `no prop "${id}"`);
    if (!def) continue;
    check(`?${query} disables only ${id}`,
      def.enabled(params) === false
        && registry.propsForDevice(deviceId, params)
          .filter((p) => p.id !== id)
          .every((p) => p.enabled(params) === true),
      `${query} disabled a neighbour, or did not disable ${id}`);
    check(`${id} is on by default`, def.enabled(new URLSearchParams('')) === true,
      `${id} defaulted off`);
    check(`?${query.replace('=0', '=1')} forces ${id} on`,
      def.enabled(new URLSearchParams(query.replace('=0', '=1'))) === true,
      'the explicit-on form did not work');
  }
}

// ── 4b. Heron's preset gate ────────────────────────────────────────────────
//
// `heronVessels` is the one prop whose `enabled` depends on something other
// than a query switch: the GLB is baked for the `classic` layout, and Heron's
// presets re-route the plumbing rather than rescale one shape. If this gate
// ever silently opens, the classic glass hangs in a tower layout; if it
// silently closes, the bench loses its CAD for no stated reason. Neither shows
// up anywhere else, so pin both directions here.
{
  const heron = registry.getPropDef('heronVessels');
  check('heronVessels is in the registry', !!heron, 'no prop "heronVessels"');
  if (heron) {
    check('heronVessels is on for the default (classic) preset',
      heron.enabled(new URLSearchParams('')) === true, 'it defaulted off');
    check('heronVessels is on for an explicit ?heronLayout=classic',
      heron.enabled(new URLSearchParams('heronLayout=classic')) === true, 'it was off');

    for (const preset of ['compact', 'tower', 'wide', 'spiral']) {
      const params = new URLSearchParams(`heronLayout=${preset}`);
      check(`heronVessels is off for ?heronLayout=${preset}`,
        heron.enabled(params) === false,
        `the classic GLB would hang in the ${preset} layout`);
      // And the loader must agree, because `_disposeFocusOnlyGltfProps` keeps
      // exactly what `propsForDevice` still reports — that is what frees the
      // GPU buffers when the user switches preset without leaving the bench.
      check(`propsForDevice("heron") is empty for ?heronLayout=${preset}`,
        registry.propsForDevice('heron', params).length === 0,
        registry.propsForDevice('heron', params).map((x) => x.id).join(', '));
    }

    // An unknown preset falls back to classic in `parseHeronLayoutPreset`, so
    // a typo in a shared lab URL must not silently strip the CAD.
    check('heronVessels survives an unknown preset (falls back to classic)',
      heron.enabled(new URLSearchParams('heronLayout=not-a-preset')) === true,
      'an unknown preset disabled the prop');
    // The preset gate must not override an explicit off.
    check('?gltfHeronVessels=0 still wins on the classic preset',
      heron.enabled(new URLSearchParams('heronLayout=classic&gltfHeronVessels=0')) === false,
      'the explicit off was ignored');
    // ...nor should an explicit on resurrect it in a layout it does not fit.
    check('?gltfHeronVessels=1 does not force the classic GLB into a tower',
      heron.enabled(new URLSearchParams('heronLayout=tower&gltfHeronVessels=1')) === false,
      'the preset gate was bypassed by an explicit on');

    // The session's published preset outranks the query string, because
    // `applyStoredHeronLayout()` lets a localStorage preset override
    // `?heronLayout=` at boot. Without this the prop reads the URL, disagrees
    // with the geometry actually on screen, and hangs classic glass in a tower.
    const hadWindow = 'window' in globalThis;
    const priorWindow = globalThis.window;
    try {
      globalThis.window = { HERON_LAYOUT_PRESET: 'tower' };
      check('a published "tower" preset beats an empty query',
        heron.enabled(new URLSearchParams('')) === false,
        'the prop stayed on for a session that is not on classic');
      check('a published "tower" preset beats ?heronLayout=classic',
        heron.enabled(new URLSearchParams('heronLayout=classic')) === false,
        'the query string outranked the session');

      globalThis.window = { HERON_LAYOUT_PRESET: 'classic' };
      check('a published "classic" preset turns the prop on',
        heron.enabled(new URLSearchParams('heronLayout=tower')) === true,
        'the prop stayed off for a session that is on classic');

      // A junk global must not strip the CAD — fall back to the query.
      globalThis.window = { HERON_LAYOUT_PRESET: 'not-a-preset' };
      check('an unknown published preset falls back to the query',
        heron.enabled(new URLSearchParams('')) === true
          && heron.enabled(new URLSearchParams('heronLayout=tower')) === false,
        'the fallback did not use the query string');
    } finally {
      if (hadWindow) globalThis.window = priorWindow;
      else delete globalThis.window;
    }
  }
}

// ── 5. Material resolution ─────────────────────────────────────────────────
{
  for (const p of props) {
    const mat = registry.resolvePropMaterial(p, {});
    check(`${p.id} resolves a ring index`, Number.isFinite(mat.ringIndex), String(mat.ringIndex));
    check(`${p.id} resolves an RGB colour`,
      Array.isArray(mat.color) && mat.color.length === 3
        && mat.color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1),
      JSON.stringify(mat.color));
    check(`${p.id} resolves an emissive scale`,
      Number.isFinite(mat.emissiveScale) && mat.emissiveScale >= 0, String(mat.emissiveScale));
  }

  // A registry override must beat the glTF's own extras.
  const overridden = props.find((p) => p.materialOverride?.ringIndex !== undefined);
  check('some prop carries a material override', !!overridden, 'no prop has an override to test');
  if (overridden) {
    const mat = registry.resolvePropMaterial(overridden, { materialRingIndex: 99 });
    check('registry override beats glTF extras',
      mat.ringIndex === overridden.materialOverride.ringIndex,
      `${mat.ringIndex} vs ${overridden.materialOverride.ringIndex}`);
  }
  // A drawable's extras are still used where the registry says nothing.
  const bare = { id: 'bare', deviceId: 'seg', url: '', role: 'x', loadPolicy: 'focus', enabled: () => true };
  const fromExtras = registry.resolvePropMaterial(bare, { materialRingIndex: 7, material: { color: [0.1, 0.2, 0.3] } });
  check('glTF extras fill in where the registry is silent',
    fromExtras.ringIndex === 7 && fromExtras.color[1] === 0.2, JSON.stringify(fromExtras));
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[prop-registry] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[prop-registry] ${ok.length} checks passed`);
