// ============================================================================
// SEG Material Presets
// ============================================================================
// Material definitions based on real SEG 4-layer composition.
// Export only: material preset objects for use in geometry generators.

// Material Presets - based on real SEG 4-layer composition
export const SEGMaterialPresets = {
  // Layer 1: Neodymium (rare earth magnetic core) - silver metallic
  neodymium: {
    baseColor: [0.72, 0.74, 0.76],
    metallic: 0.92,
    roughness: 0.25,
    emissive: 0.0
  },
  // Layer 2: Copper (conductor) - warm reddish with oxidation variation
  copper: {
    baseColor: [0.85, 0.48, 0.22],
    metallic: 0.95,
    roughness: 0.30,
    emissive: 0.0
  },
  // Layer 3: Brass (structural plates) - gold-yellow
  brass: {
    baseColor: [0.78, 0.58, 0.22],
    metallic: 0.90,
    roughness: 0.22,
    emissive: 0.0
  },
  // Layer 4: Insulation/nylon (separator plates) - off-white/cream
  insulation: {
    baseColor: [0.92, 0.90, 0.82],
    metallic: 0.0,
    roughness: 0.85,
    emissive: 0.0
  },
  // Steel shaft - cold metallic
  steel: {
    baseColor: [0.65, 0.67, 0.70],
    metallic: 0.95,
    roughness: 0.18,
    emissive: 0.0
  },
  // Winding copper (for electromagnets) - brighter, fresher copper
  windingCopper: {
    baseColor: [0.90, 0.52, 0.18],
    metallic: 0.88,
    roughness: 0.40,
    emissive: 0.0
  },
  // Copper oxide (darker patina bands on aged rollers)
  copperOxide: {
    baseColor: [0.55, 0.30, 0.15],
    metallic: 0.70,
    roughness: 0.55,
    emissive: 0.0
  },
  // Plastic/nylon spacer (cream colored, seen in prototypes)
  nylonSpacer: {
    baseColor: [0.95, 0.93, 0.85],
    metallic: 0.0,
    roughness: 0.75,
    emissive: 0.0
  },
  // PCB/electronics (green circuit boards visible in prototypes)
  pcbGreen: {
    baseColor: [0.15, 0.55, 0.20],
    metallic: 0.1,
    roughness: 0.60,
    emissive: 0.05
  },
  // Bolt/fastener steel
  boltSteel: {
    baseColor: [0.70, 0.72, 0.74],
    metallic: 0.98,
    roughness: 0.15,
    emissive: 0.0
  }
};
