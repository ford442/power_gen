// Shared mesh buffer setup for all devices + core SEG assembly.
import { getMergedDeviceConfig } from '../devices/device-registry.js';
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
} from '../seg-frame-model.js';

export const geometrySetupMethods = {
  async setupSharedGeometry() {
    console.log('Initializing structural mesh geometry layouts...');
    this.deviceGeometryBuffers = this.deviceGeometryBuffers || {};

    // Per-device hooks — never call undefined builders (peltier/mhd are compute-only).
    for (const [deviceId, config] of Object.entries(getMergedDeviceConfig())) {
      if (DEVICE_MESH_LAYOUTS[deviceId]) continue;
      const targetBuilderName = `build${deviceId.toUpperCase()}Geometry`;
      const builderMethod = this[targetBuilderName];

      if (typeof builderMethod === 'function') {
        await builderMethod.call(this, config);
      } else {
        console.log(`[System Neutral]: Bypassing mesh generation for particle-only device: ${deviceId}`);
        await this.setupDefaultPrimitiveGeometry(deviceId, config);
      }
    }

    await this._setupAlternateDeviceSharedMeshes();
    await this._setupCoreSEGSharedMeshes();
  },

  async _setupAlternateDeviceSharedMeshes() {
    const cylData = this.generateCylinder(0.8, 2.5, 64);
    const cylVB = this.device.createBuffer({
      size: cylData.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(cylVB, 0, cylData.vertices);
    const cylIB = this.device.createBuffer({
      size: cylData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(cylIB, 0, cylData.indices);
    this.cylinderBuffer = { vertexBuffer: cylVB, indexBuffer: cylIB, indexCount: cylData.indices.length };
    this.profiler.trackBuffer('shared-cylinder-vertices', cylData.vertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('shared-cylinder-indices', cylData.indices.byteLength, GPUBufferUsage.INDEX);

    const tubeData = this.generateCylinder(TUBE_MESH_RADIUS, TUBE_MESH_HEIGHT, 12);
    const tubeVB = this.device.createBuffer({
      size: tubeData.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(tubeVB, 0, tubeData.vertices);
    const tubeIB = this.device.createBuffer({
      size: tubeData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(tubeIB, 0, tubeData.indices);
    this.deviceTubeBuffer = { vertexBuffer: tubeVB, indexBuffer: tubeIB, indexCount: tubeData.indices.length };
    this.profiler.trackBuffer('device-tube-vertices', tubeData.vertices.byteLength, GPUBufferUsage.VERTEX);

    const torusData = generateTorus(1.0, 0.14, 48, 14);
    const torusVB = this.device.createBuffer({
      size: torusData.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(torusVB, 0, torusData.vertices);
    const torusIB = this.device.createBuffer({
      size: torusData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(torusIB, 0, torusData.indices);
    this.kelvinRingBuffer = { vertexBuffer: torusVB, indexBuffer: torusIB, indexCount: torusData.indices.length };
    this.profiler.trackBuffer('kelvin-ring-vertices', torusData.vertices.byteLength, GPUBufferUsage.VERTEX);

    const panelData = this.generateDisc(0.05, 5.5, 0.06, 64);
    const panelVB = this.device.createBuffer({
      size: panelData.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(panelVB, 0, panelData.vertices);
    const panelIB = this.device.createBuffer({
      size: panelData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(panelIB, 0, panelData.indices);
    this.solarPanelBuffer = { vertexBuffer: panelVB, indexBuffer: panelIB, indexCount: panelData.indices.length };
    this.profiler.trackBuffer('solar-panel-vertices', panelData.vertices.byteLength, GPUBufferUsage.VERTEX);
  },

  async setupDefaultPrimitiveGeometry(deviceId, config) {
    if (this.deviceGeometryBuffers[deviceId]) return;

    const data = this.generateCylinder(0.05, 0.05, 8);
    const vertexBuffer = this.device.createBuffer({
      size: data.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(vertexBuffer, 0, data.vertices);
    const indexBuffer = this.device.createBuffer({
      size: data.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(indexBuffer, 0, data.indices);

    this.deviceGeometryBuffers[deviceId] = {
      vertexBuffer,
      indexBuffer,
      indexCount: data.indices.length,
      color: config.color
    };
    this.profiler.trackBuffer(`placeholder-${deviceId}-vertices`, data.vertices.byteLength, GPUBufferUsage.VERTEX);
  },

  async _setupCoreSEGSharedMeshes() {
    const layout = this.refreshSEGLayout(1.0);
    const ws = layout.worldScale;
    const statorH = layout.statorHeightM * ws;
    const outerR = layout.outerRadiusM * ws;
    const basePlateSize = layout.basePlateRadiusM * ws * 2;
    const coilRadius = outerR * 1.15;
    const frameDims = computeFrameDimensions(layout);

    const generators = {
      generateBearingShaft,
      createDetailedRollerBuffers,
      generateSupportStand,
      generateWireHarness,
      generateCoilWithWindings
    };
    for (const [name, fn] of Object.entries(generators)) {
      if (typeof fn !== 'function') {
        throw new Error(`[setupSharedGeometry] Missing geometry generator: ${name}`);
      }
    }

    // UV cylinder shared by pickup/electromagnet coils
    const coilCylData = this.generateCylinderWithUVs(0.8, 2.5, 64);
    const coilCylVB = this.device.createBuffer({ size: coilCylData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(coilCylVB, 0, coilCylData.vertices);
    const coilCylIB = this.device.createBuffer({ size: coilCylData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(coilCylIB, 0, coilCylData.indices);
    this.coilUVBuffer = { vertexBuffer: coilCylVB, indexBuffer: coilCylIB, indexCount: coilCylData.indices.length };
    this.profiler.trackBuffer('seg-coil-uv-vertices', coilCylData.vertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-coil-uv-indices', coilCylData.indices.byteLength, GPUBufferUsage.INDEX);

    // Industrial base box (UV mesh for enhanced PBR pipeline)
    const baseBoxData = this.generateBoxWithUVs(basePlateSize, statorH * 0.45, basePlateSize);
    const baseBoxVB = this.device.createBuffer({ size: baseBoxData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(baseBoxVB, 0, baseBoxData.vertices);
    const baseBoxIB = this.device.createBuffer({ size: baseBoxData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(baseBoxIB, 0, baseBoxData.indices);
    this.basePlateBuffer = { vertexBuffer: baseBoxVB, indexBuffer: baseBoxIB, indexCount: baseBoxData.indices.length };
    this.profiler.trackBuffer('seg-base-plate-vertices', baseBoxData.vertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-base-plate-indices', baseBoxData.indices.byteLength, GPUBufferUsage.INDEX);

    const baseY = frameDims.baseCenterY;
    this.baseInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.baseInstanceBuffer, 0, new Float32Array([
      0, baseY, 0,  // position
      0.0,          // ringIndex
      0, 0, 0, 1,   // rotation
      0.08, 0.08, 0.12, // dark base color
      0.0           // emissive
    ]));
    this.profiler.trackBuffer('seg-base-instance', 48, GPUBufferUsage.STORAGE);

    // Detailed SEG roller assembly (pole-banded barrel, shaft, bearings, magnet strips).
    this.enhancedRollerBuffer = createDetailedRollerBuffers(this.device, {
      radius: ROLLER_DEFAULTS.radius,
      height: ROLLER_DEFAULTS.height,
      bands: ROLLER_DEFAULTS.bands,
      segments: ROLLER_DEFAULTS.segments
    });
    this.profiler.trackBuffer('enhanced-roller-vertices', this.enhancedRollerBuffer.vertexBuffer.size, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('enhanced-roller-indices', this.enhancedRollerBuffer.indexBuffer.size, GPUBufferUsage.INDEX);

    // Central bearing shaft (replaces sphere)
    this.coreShaftBuffer = generateBearingShaft(this.device, {
      shaftRadius: layout.shaftRadiusM * ws,
      shaftHeight: layout.shaftHeightM * ws,
      flangeRadius: layout.shaftRadiusM * ws * 3.6,
      topRingRadius: layout.shaftRadiusM * ws * 2.6,
      segments: 48
    });
    this.profiler.trackBuffer('core-shaft-vertices', this.coreShaftBuffer.vertexBuffer.size, GPUBufferUsage.VERTEX);

    // Magnetic core (simple cylinder with UVs for enhanced pipeline)
    const magnetData = this.generateCylinderWithUVs(0.8, 2.5, 64);
    const magnetVB = this.device.createBuffer({ size: magnetData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(magnetVB, 0, magnetData.vertices);
    const magnetIB = this.device.createBuffer({ size: magnetData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(magnetIB, 0, magnetData.indices);
    this.coreMagnetBuffer = { vertexBuffer: magnetVB, indexBuffer: magnetIB, indexCount: magnetData.indices.length };

    // Core plates with roller cutouts derived from layout (full roller counts).
    const rollerCutouts = buildRollerCutouts(layout);
    const plateData = generatePlateWithCutouts(this.device, {
      innerRadius: layout.shaftRadiusM * ws * 1.2,
      outerRadius: outerR * 1.08,
      thickness: statorH * 0.55,
      rollerCutouts,
      boltHoles: 16,
      hasRibs: true,
      ribCount: 8,
      segments: 96
    });
    this.corePlateBuffer = plateData;
    this.profiler.trackBuffer('seg-core-plate-vertices', plateData.vertexBuffer.size, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-core-plate-indices', plateData.indexBuffer.size, GPUBufferUsage.INDEX);

    // Bolt geometry (small cylinder with UVs)
    const boltData = this.generateCylinderWithUVs(0.08, 0.15, 8);
    const boltVB = this.device.createBuffer({ size: boltData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(boltVB, 0, boltData.vertices);
    const boltIB = this.device.createBuffer({ size: boltData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(boltIB, 0, boltData.indices);
    this.coreBoltBuffer = { vertexBuffer: boltVB, indexBuffer: boltIB, indexCount: boltData.indices.length };

    // Bolt positions (16 bolts around perimeter)
    const boltPositions = [];
    const boltInstanceData = [];
    const boltCount = 16;
    const boltRadius = outerR * 1.02;
    for (let i = 0; i < boltCount; i++) {
      const angle = (i / boltCount) * Math.PI * 2;
      boltPositions.push(Math.cos(angle) * boltRadius, 0, Math.sin(angle) * boltRadius);
      // Instance: position(3) + ringIndex(1) + rotation(4) + color(3) + emissive(1) = 12 floats
      boltInstanceData.push(
        Math.cos(angle) * boltRadius, 0, Math.sin(angle) * boltRadius,
        11.0, // ringIndex hack for plate/structural
        0, 0, 0, 1, // rotation
        0.70, 0.72, 0.74, // steel bolt color
        0.0 // emissive
      );
    }
    this.coreBoltPositions = new Float32Array(boltPositions);
    this.coreBoltInstanceBuffer = this.device.createBuffer({
      size: boltInstanceData.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coreBoltInstanceBuffer, 0, new Float32Array(boltInstanceData));
    this.profiler.trackBuffer('core-bolt-instances', boltInstanceData.length * 4, GPUBufferUsage.STORAGE);

    // Connection rings (thin UV cylinders, instanced at y = +/-2.0)
    const ringData = this.generateCylinderWithUVs(0.15, 0.3, 48);
    const ringVB = this.device.createBuffer({ size: ringData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ringVB, 0, ringData.vertices);
    const ringIB = this.device.createBuffer({ size: ringData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ringIB, 0, ringData.indices);
    this.connectionRingBuffer = { vertexBuffer: ringVB, indexBuffer: ringIB, indexCount: ringData.indices.length };

    this.connectionRingInstances = this.device.createBuffer({
      size: 2 * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.connectionRingInstances, 0, new Float32Array([
      // top ring
      0, 2.0, 0,  0.0,
      0, 0, 0, 1,
      0.85, 0.48, 0.25,
      0.0,
      // bottom ring
      0, -2.0, 0,  0.0,
      0, 0, 0, 1,
      0.85, 0.48, 0.25,
      0.0
    ]));
    this.profiler.trackBuffer('seg-connection-ring-instances', 2 * 48, GPUBufferUsage.STORAGE);

    // C-shaped pickup coil geometry (core, winding bundle, mounting foot)
    this.cCoreCoilBuffer = generateCCorePickupCoil(this.device, {
      coilRadius,
      jawReach: statorH * 2.2,
      coreWidth: statorH * 2.4,
      coreHeight: statorH * 1.1,
      coreThickness: statorH * 0.6,
      armWidth: statorH * 0.6,
      windingWidth: statorH * 1.9,
      windingHeight: statorH * 1.2,
      windingThickness: statorH * 1.15
    });

    // Battery gauge (simple cylinder)
    const gaugeData = this.generateCylinder(0.3, 0.1, 16);
    const gaugeVB = this.device.createBuffer({ size: gaugeData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(gaugeVB, 0, gaugeData.vertices);
    const gaugeIB = this.device.createBuffer({ size: gaugeData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(gaugeIB, 0, gaugeData.indices);
    this.batteryGaugeVertexBuffer = gaugeVB;
    this.batteryGaugeIndexBuffer = gaugeIB;
    this.batteryGaugeIndexCount = gaugeData.indices.length;

    // Support stand — legs span lab bench top → base plate bottom
    this.standBuffer = generateSupportStand(this.device, {
      legCount: 4,
      legRadius: statorH * 0.22,
      legLength: outerR * 0.95,
      baseRadius: outerR * 0.52,
      baseThickness: statorH * 0.18,
      height: frameDims.standHeight,
      footRadius: statorH * 0.55,
      segments: 24,
      platformY: frameDims.baseBottomY
    });

    // Frame assembly (lab bench, columns, control box, safety cage)
    if (this.segFrameLevel !== 'off') {
      this.segFrameBuffers = createSegFrameBuffers(this.device, layout, this.segFrameLevel);
      this.frameStructuralInstanceBuffer = makeFrameInstanceBuffer(this.device, 11.0, [0.74, 0.76, 0.80]);
      this.frameControlInstanceBuffer = makeFrameInstanceBuffer(this.device, 11.0, [0.62, 0.64, 0.68]);
      this.frameCageInstanceBuffer = makeFrameInstanceBuffer(this.device, 12.0, [0.50, 0.54, 0.60]);
      this.frameLabBenchInstanceBuffer = makeFrameInstanceBuffer(this.device, 13.0, [0.42, 0.40, 0.38]);
      this.profiler.trackBuffer('seg-frame-structural-inst', 48, GPUBufferUsage.STORAGE);
    }

    // Hybrid glTF housing shell (WebGPU; procedural rollers unchanged)
    if (typeof this.setupGltfAssets === 'function') {
      await this.setupGltfAssets();
    }

    // Wire harnesses (8 wires between coils)
    this.wireBuffers = [];
    const coilCount = 8;
    for (let i = 0; i < coilCount; i++) {
      const angle1 = (i / coilCount) * Math.PI * 2;
      const angle2 = ((i + 1) / coilCount) * Math.PI * 2;
      this.wireBuffers.push(generateWireHarness(this.device, {
        start: [Math.cos(angle1) * coilRadius, statorH * 1.2, Math.sin(angle1) * coilRadius],
        end: [Math.cos(angle2) * coilRadius, statorH * 1.2, Math.sin(angle2) * coilRadius],
        radius: statorH * 0.08, sag: statorH * 0.9, segments: 16
      }));
    }

    // Coil with windings
    this.coilWindingBuffer = generateCoilWithWindings(this.device, {
      majorRadius: coilRadius, minorRadius: statorH * 0.85, turns: 60, majorSegments: 96
    });

    // Magnetic wall shells for Roschin–Godin anomalous environmental effects.
    this.magneticWallBuffer = generateMagneticWallShells(this.device, {
      innerRadius: layout.shaftRadiusM * ws * 1.4,
      spacing: statorH * 0.9,
      shellThickness: statorH * 0.1,
      height: outerR * 2.2,
      maxShells: 5,
      segments: 96
    });

    // Stator rings: annular discs with square cross-section (h_s × h_s) per ring.
    const ringSegs = 96;
    const ringVCount = layout.rings.map((ring) => {
      const inner = ring.statorInnerM * ws;
      const outer = ring.statorOuterM * ws;
      const d = this.generateDiscWithUVs(inner, outer, statorH, ringSegs);
      return { data: d, vertexCount: d.vertices.length / 8 };
    });

    let ringTotalVerts = 0;
    let ringTotalIdx = 0;
    for (const r of ringVCount) {
      ringTotalVerts += r.vertexCount;
      ringTotalIdx += r.data.indices.length;
    }
    const ringVertices = new Float32Array(ringTotalVerts * 8);
    const ringIndices = new Uint16Array(ringTotalIdx);
    let vOff = 0;
    let iOff = 0;
    for (let ri = 0; ri < ringVCount.length; ri++) {
      const y = statorH * 0.5;
      const src = ringVCount[ri].data;
      const vCount = ringVCount[ri].vertexCount;
      for (let i = 0; i < vCount; i++) {
        ringVertices[(vOff + i) * 8 + 0] = src.vertices[i * 8 + 0];
        ringVertices[(vOff + i) * 8 + 1] = src.vertices[i * 8 + 1] + y;
        ringVertices[(vOff + i) * 8 + 2] = src.vertices[i * 8 + 2];
        ringVertices[(vOff + i) * 8 + 3] = src.vertices[i * 8 + 3];
        ringVertices[(vOff + i) * 8 + 4] = src.vertices[i * 8 + 4];
        ringVertices[(vOff + i) * 8 + 5] = src.vertices[i * 8 + 5];
        ringVertices[(vOff + i) * 8 + 6] = src.vertices[i * 8 + 6];
        ringVertices[(vOff + i) * 8 + 7] = src.vertices[i * 8 + 7];
      }
      for (let i = 0; i < src.indices.length; i++) {
        ringIndices[iOff + i] = src.indices[i] + vOff;
      }
      vOff += vCount;
      iOff += src.indices.length;
    }

    const statorRingVB = this.device.createBuffer({ size: ringVertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(statorRingVB, 0, ringVertices);
    const statorRingIB = this.device.createBuffer({ size: ringIndices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(statorRingIB, 0, ringIndices);
    this.statorRingUVBuffer = { vertexBuffer: statorRingVB, indexBuffer: statorRingIB, indexCount: ringIndices.length };
    this.profiler.trackBuffer('seg-stator-ring-vertices', ringVertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-stator-ring-indices', ringIndices.byteLength, GPUBufferUsage.INDEX);

    // Single canonical instance entry for the merged stator-ring mesh.
    this.statorRingInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.statorRingInstanceBuffer, 0, new Float32Array([
      0, 0, 0,       // position
      0.0,           // ringIndex
      0, 0, 0, 1,    // rotation
      0.85, 0.48, 0.25, // copper color
      0.0            // emissive
    ]));
    this.profiler.trackBuffer('seg-stator-ring-instance', 48, GPUBufferUsage.STORAGE);

    // Wiring cylinder with UVs (for enhanced PBR pipeline)
    const wireCylData = this.generateCylinderWithUVs(0.15, 2.0, 16);
    const wireCylVB = this.device.createBuffer({ size: wireCylData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(wireCylVB, 0, wireCylData.vertices);
    const wireCylIB = this.device.createBuffer({ size: wireCylData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(wireCylIB, 0, wireCylData.indices);
    this.wiringUVBuffer = { vertexBuffer: wireCylVB, indexBuffer: wireCylIB, indexCount: wireCylData.indices.length };
  }
};
