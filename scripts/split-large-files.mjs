#!/usr/bin/env node
/**
 * Split seg-geometry-generators.js and multi-device-visualizer.js into modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

function readGit(rel) {
  return execSync(`git show HEAD:${rel}`, { cwd: ROOT, encoding: 'utf8' });
}

function write(rel, content) {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function sliceLines(text, start, end) {
  return text.split('\n').slice(start - 1, end).join('\n');
}

function replaceMakeGeom(s) {
  return s.replace(/_makeGeomBuffers/g, 'makeGeomBuffers');
}

function extractClassMethods(source, methodNames) {
  const blocks = {};
  for (const name of methodNames) {
    const re = new RegExp(
      `^(  (?:async )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\([^)]*\\) \\{[\\s\\S]*?^  \\})`,
      'm'
    );
    const m = source.match(re);
    if (!m) throw new Error(`Method not found: ${name}`);
    blocks[name] = m[1];
  }
  return blocks;
}

function buildMixinFile(header, imports, blocks, exportName) {
  const methods = Object.values(blocks).join(',\n\n');
  return `${header}\n${imports ? imports + '\n' : ''}\nexport const ${exportName} = {\n${methods}\n};\n`;
}

// ─── SEG geometry ───────────────────────────────────────────────────────────

const segOrig = readGit('src/seg-geometry-generators.js');

write(
  'src/seg-geometry/helpers.js',
  `// Shared buffer + box builders for SEG geometry generators.

${sliceLines(segOrig, 20, 32).replace('function _makeGeomBuffers', 'export function makeGeomBuffers')}
${sliceLines(segOrig, 933, 1105)
  .replace(/^function _dot3/, 'export function _dot3')
  .replace(/^function _appendBox/, 'export function _appendBox')
  .replace(/^function _buildBoxPart/, 'export function _buildBoxPart')
  .replace(/^function _buildWindingPart/, 'export function _buildWindingPart')
  .replace(/_makeGeomBuffers/g, 'makeGeomBuffers')}
`
);

const segModules = [
  ['bearing-shaft.js', 'import { makeGeomBuffers } from \'./helpers.js\';\n\n', 34, 182],
  ['pole-roller.js', 'import { createDetailedRollerBuffers } from \'../seg-roller-model.js\';\n\n', 184, 212],
  ['plate-cutouts.js', 'import { makeGeomBuffers } from \'./helpers.js\';\n\n', 214, 490],
  ['support-stand.js', 'import { makeGeomBuffers } from \'./helpers.js\';\n\n', 492, 686],
  ['wire-harness.js', 'import { makeGeomBuffers } from \'./helpers.js\';\n\n', 688, 807],
  ['coil-windings.js', 'import { makeGeomBuffers } from \'./helpers.js\';\n\n', 809, 922],
  [
    'c-core-coil.js',
    'import { _buildBoxPart, _buildWindingPart } from \'./helpers.js\';\n\n',
    924,
    931,
    1107,
    1169
  ],
  ['magnetic-walls.js', 'import { makeGeomBuffers } from \'./helpers.js\';\n\n', 1171, 1250],
  [
    'banded-rollers.js',
    `import {
  poleTintColor,
  computeRollerRotation,
  isNorthPole
} from '../seg-roller-model.js';

`,
    1252,
    1307
  ]
];

for (const entry of segModules) {
  const [file, header, ...ranges] = entry;
  let body;
  if (ranges.length === 4) {
    body = `${sliceLines(segOrig, ranges[0], ranges[1])}\n${sliceLines(segOrig, ranges[2], ranges[3])}`;
  } else {
    body = sliceLines(segOrig, ranges[0], ranges[1]);
  }
  write(`src/seg-geometry/${file}`, header + replaceMakeGeom(body) + '\n');
}

write(
  'src/seg-geometry/index.js',
  `export { makeGeomBuffers } from './helpers.js';
export { generateBearingShaft } from './bearing-shaft.js';
export { generatePoleBandedRoller } from './pole-roller.js';
export { generatePlateWithCutouts } from './plate-cutouts.js';
export { generateSupportStand } from './support-stand.js';
export { generateWireHarness } from './wire-harness.js';
export { generateCoilWithWindings } from './coil-windings.js';
export { generateCCorePickupCoil } from './c-core-coil.js';
export { generateMagneticWallShells } from './magnetic-walls.js';
export { generateBandedRollerInstances } from './banded-rollers.js';
`
);

write(
  'src/seg-geometry-generators.js',
  `// Barrel re-export — implementations live in src/seg-geometry/
export {
  makeGeomBuffers,
  generateBearingShaft,
  generatePoleBandedRoller,
  generatePlateWithCutouts,
  generateSupportStand,
  generateWireHarness,
  generateCoilWithWindings,
  generateCCorePickupCoil,
  generateMagneticWallShells,
  generateBandedRollerInstances
} from './seg-geometry/index.js';
`
);

// ─── Multi-device visualizer ────────────────────────────────────────────────

const vizOrig = readGit('src/multi-device-visualizer.js');

const primitiveMethods = [
  'generateCylinder',
  'generateDisc',
  'generateCylinderWithUVs',
  'generateDiscWithUVs',
  'generateBoxWithUVs'
];

const geometryMethods = [
  'setupSharedGeometry',
  '_setupAlternateDeviceSharedMeshes',
  'setupDefaultPrimitiveGeometry',
  '_setupCoreSEGSharedMeshes'
];

const sceneMethods = [
  'setupFloorGrid',
  'setupSkyGradient',
  'setupAnomalyWallPipeline',
  '_waitForCanvasLayout',
  '_observeCanvasLayout',
  '_syncCanvasSize',
  'setupDepthBuffer',
  'setupBloomTextures',
  'setupBloomPipeline'
];

const renderMethods = ['renderAnomalyWalls', 'render'];
const hardwareMethods = ['_updateTachometer', '_updateHardwareTwin', '_updateDeviceTelemetry'];

write(
  'src/visualizer/primitives.js',
  buildMixinFile('// CPU primitive mesh builders (pos+normal or pos+normal+uv).', '', extractClassMethods(vizOrig, primitiveMethods), 'primitiveMethods')
);

write(
  'src/visualizer/setup-geometry.js',
  buildMixinFile(
    '// Shared mesh buffer setup for all devices + core SEG assembly.',
    `import { getMergedDeviceConfig } from '../devices/device-registry.js';
import { DEVICE_MESH_LAYOUTS, TUBE_MESH_RADIUS, TUBE_MESH_HEIGHT } from '../device-mesh-layouts.js';
import { generateTorus } from '../renderers/shared/primitive-geometry.js';
import {
  generateBearingShaft,
  generateCoilWithWindings,
  generateCCorePickupCoil,
  generateMagneticWallShells,
  generatePlateWithCutouts,
  generateSupportStand,
  generateWireHarness
} from '../seg-enhanced-geometry.js';
import { buildRollerCutouts } from '../seg-layout.js';
import { createDetailedRollerBuffers, ROLLER_DEFAULTS } from '../seg-roller-model.js';
import {
  createSegFrameBuffers,
  makeFrameInstanceBuffer,
  computeFrameDimensions
} from '../seg-frame-model.js';`,
    extractClassMethods(vizOrig, geometryMethods),
    'geometrySetupMethods'
  )
);

write(
  'src/visualizer/scene-setup.js',
  buildMixinFile(
    '// Floor grid, sky, bloom, depth, and canvas resize.',
    `import { WebGPUManager, DEPTH_FORMAT } from '../webgpu-manager.js';
import { packPostUniforms } from '../seg-lighting-presets.js';`,
    extractClassMethods(vizOrig, sceneMethods),
    'sceneSetupMethods'
  )
);

write(
  'src/visualizer/render-loop.js',
  buildMixinFile(
    '// Per-frame simulation update + GPU encode (scene + bloom).',
    `import { WebGPUManager } from '../webgpu-manager.js';
import { MAX_ROLLERS } from '../seg-layout.js';
import { packPostUniforms } from '../seg-lighting-presets.js';
import { segOperator } from '../seg-operator-state.js';
import { telemetryHub, TelemetryHub } from '../telemetry-hub.js';
import { segWasm } from '../wasm/seg-physics-bridge.js';
import { explainerState } from '../seg-explainer/explainer-state.js';
import { getViewMeshLod, getDeviceParticleScale } from '../renderers/shared/view-lod.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}`,
    extractClassMethods(vizOrig, renderMethods),
    'renderLoopMethods'
  )
);

write(
  'src/visualizer/hardware-twin.js',
  buildMixinFile(
    '// Tachometer overlay + hardware digital twin sync.',
    `import { segOperator } from '../seg-operator-state.js';
import { telemetryHub, TelemetryHub } from '../telemetry-hub.js';
import { TWIN_MODES } from '../hardware-bridge.js';`,
    extractClassMethods(vizOrig, hardwareMethods),
    'hardwareTwinMethods'
  )
);

const allExtracted = [
  ...primitiveMethods,
  ...geometryMethods,
  ...sceneMethods,
  ...renderMethods,
  ...hardwareMethods
];

let slim = vizOrig.replace(
  /function smoothstep\(edge0, edge1, x\) \{\n  const t = Math\.max\(0, Math\.min\(1, \(x - edge0\) \/ \(edge1 - edge0\)\)\);\n  return t \* t \* \(3 - 2 \* t\);\n\}\n\n/,
  ''
);

for (const name of allExtracted) {
  const re = new RegExp(
    `^  (?:async )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\([^)]*\\) \\{[\\s\\S]*?^  \\}\n\n`,
    'm'
  );
  slim = slim.replace(re, '');
}

const mixinImports = `import { primitiveMethods } from './visualizer/primitives.js';
import { geometrySetupMethods } from './visualizer/setup-geometry.js';
import { sceneSetupMethods } from './visualizer/scene-setup.js';
import { renderLoopMethods } from './visualizer/render-loop.js';
import { hardwareTwinMethods } from './visualizer/hardware-twin.js';
`;

slim = slim.replace(
  "import {\n  SEGIntegrationManager,\n  PHYSICS_UNIFORM_BYTES\n} from './integration.ts';\n",
  "import {\n  SEGIntegrationManager,\n  PHYSICS_UNIFORM_BYTES\n} from './integration.ts';\n" + mixinImports
);

slim = slim
  .replace(/import \{ generateTorus \} from '\.\/renderers\/shared\/primitive-geometry\.js';\n/, '')
  .replace(
    /import \{ DEVICE_MESH_LAYOUTS, TUBE_MESH_RADIUS, TUBE_MESH_HEIGHT \} from '\.\/device-mesh-layouts\.js';\n/,
    ''
  )
  .replace(
    /import \{\n  generateBearingShaft,\n  generateCoilWithWindings,\n  generateCCorePickupCoil,\n  generateMagneticWallShells,\n  generatePlateWithCutouts,\n  generateSupportStand,\n  generateWireHarness\n\} from '\.\/seg-enhanced-geometry\.js';\n/,
    ''
  )
  .replace(/  buildRollerCutouts,\n  MAX_ROLLERS\n/, '')
  .replace(/import \{ createDetailedRollerBuffers, ROLLER_DEFAULTS \} from '\.\/seg-roller-model\.js';\n/, '')
  .replace(
    /import \{\n  parseSegFrameLevel,\n  createSegFrameBuffers,\n  makeFrameInstanceBuffer,\n  computeFrameDimensions\n\} from '\.\/seg-frame-model\.js';\n/,
    "import { parseSegFrameLevel } from './seg-frame-model.js';\n"
  )
  .replace(/  packPostUniforms\n/, '')
  .replace(/import \{ TWIN_MODES \} from '\.\/hardware-bridge\.js';\n/, '')
  .replace(/  getViewMeshLod,\n  isDeviceInCameraFrustum,\n/, '  isDeviceInCameraFrustum,\n');

slim = slim.replace(
  /(\}\n)$/,
  `}\n\nObject.assign(\n  MultiDeviceVisualizer.prototype,\n  primitiveMethods,\n  geometrySetupMethods,\n  sceneSetupMethods,\n  renderLoopMethods,\n  hardwareTwinMethods\n);\n`
);

write('src/multi-device-visualizer.js', slim);

console.log('Split complete.');
for (const rel of fs
  .globSync('src/seg-geometry/*.js', { cwd: ROOT })
  .concat(fs.globSync('src/visualizer/*.js', { cwd: ROOT }))
  .concat(['src/multi-device-visualizer.js', 'src/seg-geometry-generators.js'])) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length;
  const flag = lines > 700 ? ' *** OVER 700 ***' : '';
  console.log(`  ${String(lines).padStart(4)}  ${rel}${flag}`);
}