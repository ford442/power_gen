// ============================================================================
// SEG Enhanced Geometry Module
// ============================================================================
// Drop-in enhancements for the Searl Effect Generator visualization.
// Import the functions you need and call them during setupGeometry() to replace
// or augment the basic primitives with detailed, photo-realistic counterparts.
//
// Based on analysis of real SEG device photographs including:
//   - Roschin & Godin replica (2025 demo)
//   - Bharath tabletop prototype  
//   - Searl original historical photographs
//   - Prof. John Searl's documented 4-layer material composition
//
// USAGE:
//   import {
//     generateBearingShaft, generatePoleBandedRoller, generatePlateWithCutouts,
//     generateSupportStand, generateWireHarness, generateCoilWithWindings,
//     SEGMaterialPresets, EnhancedSEGGeometry
//   } from './seg-enhanced-geometry.js';
//
//   // In your setupGeometry(), replace simple shapes with detailed ones:
//   const shaft = generateBearingShaft(device, { shaftRadius: 0.6, ... });
//   const roller = generatePoleBandedRoller(device, { bands: 4, ... });
// ============================================================================

import { SEGMaterialPresets } from './seg-materials.js';
import {
  generateBearingShaft,
  generatePoleBandedRoller,
  generatePlateWithCutouts,
  generateSupportStand,
  generateWireHarness,
  generateCoilWithWindings,
  generateBandedRollerInstances
} from './seg-geometry-generators.js';

export {
  generateBearingShaft,
  generatePoleBandedRoller,
  generatePlateWithCutouts,
  generateSupportStand,
  generateWireHarness,
  generateCoilWithWindings,
  generateBandedRollerInstances
};

export class EnhancedSEGGeometry {
  constructor(device, config) {
    this.device = device;
    this.config = config;
    this.buffers = {};
  }

  async init() {
    // Central bearing shaft (replaces sphere)
    this.buffers.shaft = generateBearingShaft(this.device, {
      shaftRadius: 0.5,
      shaftHeight: 3.5,
      flangeRadius: 1.8,
      topRingRadius: 1.3,
      segments: 48
    });

    // Pole-banded roller (replaces smooth cylinder)
    this.buffers.roller = generatePoleBandedRoller(this.device, {
      radius: 0.75,
      height: 2.8,
      bands: 8,
      segments: 64
    });

    // Upper plate with cutouts
    const rings = this.config.rings || [
      { count: 8, radius: 2.5 },
      { count: 12, radius: 4.0 },
      { count: 16, radius: 5.5 }
    ];
    const rollerCutouts = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.count; i++) {
        rollerCutouts.push({
          angle: (i / ring.count) * Math.PI * 2,
          radius: ring.radius,
          size: 0.85
        });
      }
    }

    this.buffers.upperPlate = generatePlateWithCutouts(this.device, {
      innerRadius: 0.8,
      outerRadius: 6.5,
      thickness: 0.25,
      rollerCutouts,
      boltHoles: 16,
      hasRibs: true,
      ribCount: 8,
      segments: 96
    });

    this.buffers.lowerPlate = generatePlateWithCutouts(this.device, {
      innerRadius: 0.8,
      outerRadius: 6.5,
      thickness: 0.25,
      rollerCutouts,
      boltHoles: 16,
      hasRibs: true,
      ribCount: 8,
      segments: 96
    });

    // Support stand
    this.buffers.stand = generateSupportStand(this.device, {
      legCount: 4,
      legLength: 5.0,
      baseRadius: 3.0,
      height: 3.0,
      segments: 24
    });

    // Coil with visible windings
    this.buffers.coil = generateCoilWithWindings(this.device, {
      majorRadius: 7.5,
      minorRadius: 0.6,
      turns: 60,
      majorSegments: 96
    });

    // Wire harness between coils (8 connections)
    this.buffers.wires = [];
    const coilCount = 8;
    const coilRadius = 7.5;
    for (let i = 0; i < coilCount; i++) {
      const angle1 = (i / coilCount) * Math.PI * 2;
      const angle2 = ((i + 1) / coilCount) * Math.PI * 2;
      this.buffers.wires.push(generateWireHarness(this.device, {
        start: [Math.cos(angle1) * coilRadius, 0.8, Math.sin(angle1) * coilRadius],
        end: [Math.cos(angle2) * coilRadius, 0.8, Math.sin(angle2) * coilRadius],
        radius: 0.035,
        sag: 0.4,
        segments: 16
      }));
    }
  }

  destroy() {
    for (const key of Object.keys(this.buffers)) {
      if (key === 'wires') {
        for (const w of this.buffers.wires) {
          w.vertexBuffer?.destroy();
          w.indexBuffer?.destroy();
        }
      } else {
        this.buffers[key]?.vertexBuffer?.destroy();
        this.buffers[key]?.indexBuffer?.destroy();
      }
    }
  }
}


export default {
  SEGMaterialPresets,
  generateBearingShaft,
  generatePoleBandedRoller,
  generatePlateWithCutouts,
  generateSupportStand,
  generateWireHarness,
  generateCoilWithWindings,
  generateBandedRollerInstances,
  EnhancedSEGGeometry
};
