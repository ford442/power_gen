// ============================================================================
// SEG Parameterized Layout
// ============================================================================
// Literature-grounded roller/stator geometry for the Searl Effect Generator.
//
// References:
//   - Searl documented configuration: 10 / 25 / 35 rollers (inner/middle/outer)
//     (rexresearch.com/searl4/searl4.htm)
//   - Roschin–Godin 1 m converter: single ring of 12 rollers, 1 mm air gap
//     (rexresearch.com/roschin2/roschgod.htm)
//
// Derivation rule (single gap/ratio constraint):
//   - A roller ring of count N orbiting at radius R with air gap g has roller
//     diameter d = (2πR / N) - g.
//   - The stator ring beneath each roller orbit has a square cross-section of
//     side h_s, so stator radial thickness = stator height = h_s.
//   - Starting from the central shaft and working outward, each successive
//     roller orbit sits just outside the previous stator ring plus the air gap:
//       R_i = (R_{i-1} + r_{i-1} + h_s + 1.5g) / (1 - π/N_i)
//       r_i = πR_i / N_i - g/2
//   - h_s is chosen per preset so the outermost ring lands at the documented
//     scale (Searl ~1.5 m outer radius, Roschin–Godin ~0.5 m radius).
//
// Quality scaling preserves radii and roller sizes; only rendered counts are
// decimated, so proportions never break.
// ============================================================================

export const MAX_RINGS = 3;
export const MAX_ROLLERS = 72; // next multiple of 8 above 70 (10+25+35)
export const MAX_FLUX_LINES = 168; // 3 rings × 56 lines (dense RK4 field viz)

// Canonical roller mesh dimensions (generatePoleBandedRoller reference).
export const REF_ROLLER_RADIUS = 0.75;
export const REF_ROLLER_HEIGHT = 2.8;

// Uniform buffer: 64 floats (256 bytes), see packSEGLayoutUniforms().
export const SEG_LAYOUT_UNIFORM_FLOATS = 64;
export const SEG_LAYOUT_UNIFORM_BYTES = SEG_LAYOUT_UNIFORM_FLOATS * 4;
export const SEG_LAYOUT_RING_STRIDE = 12;

export const SEG_LAYOUT_PRESETS = {
  searl: 'searl',
  roschin: 'roschin',
  legacy: 'legacy'
};

const PRESET_DEFS = {
  [SEG_LAYOUT_PRESETS.searl]: {
    // Documented Searl roller counts, inner → outer.
    counts: [10, 25, 35],
    gapM: 0.003,          // ~3 mm air gap
    shaftRadiusM: 0.15,   // central shaft radius
    targetOuterRadiusM: 1.5,
    // World-space scale: meters → current scene units.
    // Searl device is ~3 m diameter; show it a bit larger than Roschin–Godin.
    worldScale: 2.0,
    rollerHeightRatio: 1.15, // rollers stand slightly taller than stator
    fluxLinesPerRing: 56,
    name: 'Searl 10/25/35'
  },
  [SEG_LAYOUT_PRESETS.roschin]: {
    counts: [12],
    gapM: 0.001,          // 1 mm gap measured by Roschin–Godin
    shaftRadiusM: 0.10,
    targetOuterRadiusM: 0.5,
    worldScale: 4.0,      // 1 m device still visible, smaller than Searl
    rollerHeightRatio: 1.15,
    fluxLinesPerRing: 56,
    name: 'Roschin–Godin 12'
  },
  [SEG_LAYOUT_PRESETS.legacy]: {
    // Previous hard-coded layout, retained for regression testing.
    counts: [8, 12, 16],
    gapM: 0.05,
    shaftRadiusM: 0.8,
    targetOuterRadiusM: 5.5,
    worldScale: 1.0,
    rollerHeightRatio: 3.5, // legacy tall rollers
    fluxLinesPerRing: 56,
    name: 'Legacy 8/12/16'
  }
};

function solveStatorHeight(def) {
  const { counts, gapM, shaftRadiusM, targetOuterRadiusM } = def;
  // Binary search for h_s that makes the outermost orbit radius match target.
  let lo = 0.001;
  let hi = targetOuterRadiusM;
  for (let iter = 0; iter < 48; iter++) {
    const mid = (lo + hi) * 0.5;
    const rings = deriveRingsFromShaft(shaftRadiusM, mid, gapM, counts);
    const outerR = rings[rings.length - 1].orbitRadiusM;
    if (outerR < targetOuterRadiusM) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

function deriveRingsFromShaft(shaftR, h_s, gap, counts) {
  const rings = [];
  let prevR = shaftR;
  let prevRollerR = 0;
  for (let i = 0; i < counts.length; i++) {
    const N = counts[i];
    const denom = 1 - Math.PI / N;
    const R = (prevR + prevRollerR + h_s + 1.5 * gap) / denom;
    const rollerR = (Math.PI * R) / N - gap * 0.5;
    const rollerD = rollerR * 2;
    rings.push({
      index: i,
      count: N,
      orbitRadiusM: R,
      rollerRadiusM: rollerR,
      rollerDiameterM: rollerD,
      gapM: gap
    });
    prevR = R;
    prevRollerR = rollerR;
  }
  return rings;
}

function decimateCount(count, qualityScale) {
  // Monotonic decimation: full counts → ~50% → ~60% of half → minimal.
  // Searl 10/25/35 lands at 70 → 36 → 21 → 9 rollers.
  if (qualityScale >= 0.75) return count;
  if (qualityScale >= 0.45) return Math.max(3, Math.round(count * 0.5));
  if (qualityScale >= 0.25) return Math.max(2, Math.round(count * 0.6));
  return Math.max(1, Math.round(count * 0.15));
}

/**
 * Compute the full SEG layout for a preset and quality level.
 *
 * @param {string} presetName - 'searl', 'roschin', or 'legacy'
 * @param {number} qualityScale - 0..1; lower values decimate roller counts
 * @returns {object} layout
 */
export function computeSEGLayout(presetName = SEG_LAYOUT_PRESETS.searl, qualityScale = 1.0) {
  const def = PRESET_DEFS[presetName] || PRESET_DEFS[SEG_LAYOUT_PRESETS.searl];
  const h_s = solveStatorHeight(def);
  const fullRings = deriveRingsFromShaft(def.shaftRadiusM, h_s, def.gapM, def.counts);

  const quality = Math.max(0, Math.min(1, qualityScale));
  const rings = fullRings.map((r, i) => {
    const effectiveCount = decimateCount(r.count, quality);
    const rollerHeightM = r.rollerDiameterM * def.rollerHeightRatio;
    const statorOuterM = r.orbitRadiusM - r.rollerRadiusM - def.gapM;
    const statorInnerM = i === 0
      ? def.shaftRadiusM
      : fullRings[i - 1].orbitRadiusM + fullRings[i - 1].rollerRadiusM + def.gapM;

    // Speed ratio: angular velocity falls with radius so tangential speeds are
    // roughly comparable, inner ring still fastest (matches documented behaviour).
    const baseSpeed = 2.0;
    const speed = baseSpeed * (fullRings[0].orbitRadiusM / r.orbitRadiusM);

    return {
      index: i,
      fullCount: r.count,
      count: effectiveCount,
      orbitRadiusM: r.orbitRadiusM,
      rollerRadiusM: r.rollerRadiusM,
      rollerDiameterM: r.rollerDiameterM,
      rollerHeightM,
      statorInnerM,
      statorOuterM,
      statorHeightM: h_s,
      statorY: 0.0,
      gapM: def.gapM,
      speed
    };
  });

  const totalRollers = rings.reduce((s, r) => s + r.count, 0);
  const outerRadiusM = fullRings[fullRings.length - 1].orbitRadiusM;
  const innerRadiusM = fullRings[0].orbitRadiusM;

  // Camera framing derived from actual outer radius.
  const cameraOffset = [
    0,
    outerRadiusM * def.worldScale * 1.6,
    outerRadiusM * def.worldScale * 4.0
  ];

  // Base plate is 1.5× the outer roller orbit in radius.
  const basePlateRadiusM = outerRadiusM * 1.55;

  // Shaft dimensions scale with inner stator geometry.
  const shaftHeightM = h_s * 12;
  const shaftRadiusM = def.shaftRadiusM;

  return {
    name: def.name,
    preset: presetName,
    worldScale: def.worldScale,
    gapM: def.gapM,
    shaftRadiusM,
    shaftHeightM,
    statorHeightM: h_s,
    basePlateRadiusM,
    cameraOffset,
    rings,
    ringCount: rings.length,
    totalRollers,
    maxRollers: MAX_ROLLERS,
    maxRings: MAX_RINGS,
    fluxLinesPerRing: def.fluxLinesPerRing,
    totalFluxLines: def.fluxLinesPerRing * rings.length,
    outerRadiusM,
    innerRadiusM,
    rollerHeightRatio: def.rollerHeightRatio
  };
}

/**
 * Map a flat roller index to its ring and local index using the current layout.
 */
export function rollerIndexToRing(layout, flatIndex) {
  let offset = 0;
  for (const ring of layout.rings) {
    if (flatIndex < offset + ring.count) {
      return { ring, localIndex: flatIndex - offset };
    }
    offset += ring.count;
  }
  return null;
}

/**
 * Build a compact Float32Array of roller (x,z) positions for CPU-side energy
 * calculations. Size is maxRollers * 2; inactive entries are zero.
 */
/**
 * World-space orbit radius for a ring.
 */
export function worldOrbitRadius(ring, layout) {
  return ring.orbitRadiusM * layout.worldScale;
}

/**
 * Pack layout parameters into the GPU uniform buffer consumed by SEG shaders.
 * Layout: header(8) + 3 × ringStride(12) floats — see multi-device-shaders.js.
 */
export function packSEGLayoutUniforms(layout) {
  const data = new Float32Array(SEG_LAYOUT_UNIFORM_FLOATS);
  data[0] = layout.worldScale;
  data[1] = layout.ringCount;
  data[2] = layout.totalRollers;
  data[3] = layout.maxRollers;
  data[4] = REF_ROLLER_RADIUS;
  data[5] = REF_ROLLER_HEIGHT;
  data[6] = layout.statorHeightM * layout.worldScale;
  data[7] = layout.fluxLinesPerRing;

  let rollerOffset = 0;
  for (let i = 0; i < MAX_RINGS; i++) {
    const base = 8 + i * SEG_LAYOUT_RING_STRIDE;
    const ring = layout.rings[i];
    if (!ring) {
      data[base + 8] = rollerOffset;
      continue;
    }
    const ws = layout.worldScale;
    data[base + 0] = ring.count;
    data[base + 1] = ring.fullCount;
    data[base + 2] = ring.orbitRadiusM * ws;
    data[base + 3] = ring.rollerRadiusM * ws;
    data[base + 4] = ring.rollerHeightM * ws;
    data[base + 5] = ring.speed;
    data[base + 6] = ring.statorInnerM * ws;
    data[base + 7] = ring.statorOuterM * ws;
    data[base + 8] = rollerOffset;
    rollerOffset += ring.count;
  }
  return data;
}

/**
 * Build roller cutout descriptors for core plates from full (undecimated) counts.
 */
export function buildRollerCutouts(layout) {
  const cutouts = [];
  const ws = layout.worldScale;
  for (const ring of layout.rings) {
    const n = ring.fullCount ?? ring.count;
    const r = ring.orbitRadiusM * ws;
    const size = ring.rollerRadiusM * ws * 2.1;
    for (let i = 0; i < n; i++) {
      cutouts.push({
        angle: (i / n) * Math.PI * 2,
        radius: r,
        size
      });
    }
  }
  return cutouts;
}

export function computeRollerPositionsXZ(time, layout, options = {}) {
  const { useHardware = false, hardwarePhaseRad = 0, speedMult = 1.0 } = options;
  const positions = new Float32Array(MAX_ROLLERS * 2);
  let flat = 0;
  for (const ring of layout.rings) {
    const startupRamp = Math.min(time * (0.25 + ring.index * 0.1), 1.0);
    for (let i = 0; i < ring.count; i++) {
      const jitterNoise = Math.sin(flat * 127.3 + ring.index * 53.7);
      const speedJitter = 1.0 + 0.04 * Math.sin(time * 1.3 + jitterNoise * 12.7);
      const baseAngle = (i / ring.count) * Math.PI * 2 + ring.index * 0.22;
      const angle = useHardware
        ? baseAngle + hardwarePhaseRad * ring.speed
        : baseAngle + time * 0.5 * ring.speed * speedJitter * startupRamp;
      const r = ring.orbitRadiusM * layout.worldScale;
      positions[flat * 2] = Math.cos(angle) * r;
      positions[flat * 2 + 1] = Math.sin(angle) * r;
      flat++;
    }
  }
  return positions;
}
