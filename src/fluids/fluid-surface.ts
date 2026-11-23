/**
 * Screen-space liquid surface — parameters, optics and CPU twins (ADR-0022,
 * docs/FLUIDS.md → The surface).
 *
 * The surface is drawn in three steps (passes/fluid-*.wgsl): the solver's
 * particles are splatted as sphere impostors into a depth and a thickness
 * target, the depth is smoothed by a narrow-range filter, and the result is
 * shaded over the scene colour. This module holds what those shaders are
 * given and, for the tests, what they should compute.
 *
 * Pure: no GPU, no DOM.
 */
import type { MpmConfig } from './mpm-params.js';

/** `FluidSurfaceParams` in common/fluid-surface.wgsl, bytes. */
export const FLUID_SURFACE_PARAMS_BYTES = 224;
/** Float offsets into that struct. */
export const FLUID_SURFACE_F = Object.freeze({
  viewProj: 0,
  camRight: 16,
  radius: 19,
  camUp: 20,
  zFar: 23,
  camBack: 24,
  thicknessScale: 27,
  origin: 28,
  metresPerUnit: 31,
  projScale: 32,
  depthAB: 34,
  targetSize: 36,
  filterDir: 38,
  filterRadius: 40,
  filterRange: 41,
  filterMaxPx: 42,
  roughness: 43,
  absorption: 44,
  refraction: 47,
  scatter: 48,
  edgeThickness: 51,
  minPixels: 52
});

/** Depth of a pixel with no liquid (`FLUID_EMPTY` in the WGSL). */
export const FLUID_EMPTY: number = Math.fround(0.9999995);
/** Taps to each side at most (`FLUID_FILTER_MAX_TAPS`). */
export const FLUID_FILTER_MAX_TAPS = 24;
/** The filter's support never exceeds this many pixels. */
export const FLUID_FILTER_MAX_PX = 16;
/** A splat is never drawn smaller than this radius on screen, pixels. */
export const FLUID_MIN_SPLAT_PX = 1.5;
/**
 * Density over rest density under which a particle is spray. A lone particle
 * reads about 0.05 and three in one kernel about 0.15; liquid a couple of
 * cells across reads 0.3 and up.
 */
export const FLUID_SPRAY_BELOW = 0.15;

/** How the liquid treats light, per look. */
export interface FluidOptics {
  /** Beer–Lambert absorption per metre of liquid, RGB. */
  absorption: readonly [number, number, number];
  /** Colour the liquid scatters back where it absorbs. */
  scatter: readonly [number, number, number];
  /** Surface roughness for the reflection and the highlight. */
  roughness: number;
  /** How far a metre of liquid bends the background, in uv at one scene unit away. */
  refraction: number;
}

/**
 * Optics per lighting look. The absorption is that of dyed water, not of
 * water: water's own (about 0.4 /m in the red) takes metres to show, and a
 * jet is centimetres thick, so with it the liquid would be visible only by
 * its reflections. A jet 3 cm thick lets through 62 % of the red and 95 % of
 * the blue under `studio`.
 */
export const FLUID_LOOK_OPTICS: Readonly<Record<'studio' | 'lab' | 'drama', FluidOptics>> = Object.freeze({
  studio: { absorption: [16, 5, 1.6], scatter: [0.04, 0.16, 0.26], roughness: 0.08, refraction: 1.0 },
  // A clinical bench: clearer liquid, a sharper surface.
  lab: { absorption: [8, 2.6, 1.0], scatter: [0.05, 0.14, 0.2], roughness: 0.05, refraction: 1.0 },
  // Deeper colour and a softer highlight under the warm key.
  drama: { absorption: [22, 8, 2.2], scatter: [0.03, 0.12, 0.3], roughness: 0.14, refraction: 1.0 }
});

export function fluidOpticsForLook(look: string | null | undefined): FluidOptics {
  return look === 'lab' || look === 'drama' ? FLUID_LOOK_OPTICS[look] : FLUID_LOOK_OPTICS.studio;
}

/** Sizes of the splat and the filter for one solver, in scene units. */
export interface FluidSurfaceGeometry {
  /** Splat sphere radius. */
  radius: number;
  /** A particle's volume over its splat sphere's: makes summed chords a real thickness. */
  thicknessScale: number;
  /** Support of the depth filter. */
  filterRadius: number;
  /** The filter's narrow range δ. */
  filterRange: number;
  /** Liquid thinner than this fades out. */
  edgeThickness: number;
}

/** Splat radius in cells: one particle spacing at rest (8 particles a cell). */
export const FLUID_SPLAT_RADIUS_CELLS = 0.5;

/**
 * Splat and filter sizes for a solver drawn at `unitsPerMetre` scene units
 * per metre. The splat sphere is one particle spacing in radius, so
 * neighbours overlap into a closed surface; it is 4.2 times a particle's
 * volume, which `thicknessScale` takes back out.
 */
export function fluidSurfaceGeometry(config: MpmConfig, unitsPerMetre: number): FluidSurfaceGeometry {
  const h = config.cellM * unitsPerMetre;
  const radius = FLUID_SPLAT_RADIUS_CELLS * h;
  const particleVolume = (h * h * h) / config.particlesPerCell;
  const sphereVolume = (4 / 3) * Math.PI * radius * radius * radius;
  return {
    radius,
    thicknessScale: particleVolume / sphereVolume,
    filterRadius: 4 * radius,
    filterRange: 3 * radius,
    edgeThickness: 0.5 * radius
  };
}

/** What one frame of the surface passes needs. Matrices are column-major, as the camera gives them. */
export interface FluidSurfaceFrame {
  viewProj: ArrayLike<number>;
  view: ArrayLike<number>;
  proj: ArrayLike<number>;
  /** Bench position: the particle records are bench-local. */
  origin: readonly [number, number, number];
  /** Pixels of the full-resolution targets. */
  targetSize: readonly [number, number];
  /** The depth targets store distance over this (the camera's far plane). */
  zFar: number;
  metresPerUnit: number;
  geometry: FluidSurfaceGeometry;
  optics: FluidOptics;
}

/**
 * Pack `FluidSurfaceParams`. `axis` is the filter direction this copy is for
 * (0 = along x, 1 = along y); the splat and the composite ignore it.
 */
export function packFluidSurfaceParams(frame: FluidSurfaceFrame, axis: 0 | 1, out: Float32Array = new Float32Array(FLUID_SURFACE_PARAMS_BYTES / 4)): Float32Array {
  const F = FLUID_SURFACE_F;
  const { view, proj, geometry: g, optics: o } = frame;
  out.fill(0);
  for (let i = 0; i < 16; i++) out[F.viewProj + i] = frame.viewProj[i];
  // Rows of the view rotation: the camera's axes in world space.
  out[F.camRight] = view[0]; out[F.camRight + 1] = view[4]; out[F.camRight + 2] = view[8];
  out[F.camUp] = view[1]; out[F.camUp + 1] = view[5]; out[F.camUp + 2] = view[9];
  out[F.camBack] = view[2]; out[F.camBack + 1] = view[6]; out[F.camBack + 2] = view[10];
  out[F.radius] = g.radius;
  out[F.zFar] = frame.zFar;
  out[F.thicknessScale] = g.thicknessScale;
  out[F.origin] = frame.origin[0]; out[F.origin + 1] = frame.origin[1]; out[F.origin + 2] = frame.origin[2];
  out[F.metresPerUnit] = frame.metresPerUnit;
  out[F.projScale] = proj[0]; out[F.projScale + 1] = proj[5];
  out[F.depthAB] = proj[10]; out[F.depthAB + 1] = proj[14];
  out[F.targetSize] = frame.targetSize[0]; out[F.targetSize + 1] = frame.targetSize[1];
  out[F.filterDir + axis] = 1;
  out[F.filterRadius] = g.filterRadius;
  out[F.filterRange] = g.filterRange;
  out[F.filterMaxPx] = FLUID_FILTER_MAX_PX;
  out[F.roughness] = o.roughness;
  out[F.absorption] = o.absorption[0]; out[F.absorption + 1] = o.absorption[1]; out[F.absorption + 2] = o.absorption[2];
  out[F.refraction] = o.refraction;
  out[F.scatter] = o.scatter[0]; out[F.scatter + 1] = o.scatter[1]; out[F.scatter + 2] = o.scatter[2];
  out[F.edgeThickness] = g.edgeThickness;
  out[F.minPixels] = FLUID_MIN_SPLAT_PX;
  return out;
}

/** Distance along the view axis for a scene depth-buffer value — `sceneDistance` in fluid-composite.wgsl. */
export function fluidSceneDistance(depth: number, proj: ArrayLike<number>): number {
  return proj[14] / (depth + proj[10]);
}

/** Scene depth-buffer value for a distance along the view axis (the inverse). */
export function fluidSceneDepth(distance: number, proj: ArrayLike<number>): number {
  return proj[14] / distance - proj[10];
}

/** The radius a splat is drawn at for a centre `distance` away — `vsSplat`. */
export function fluidSplatRadius(radius: number, distance: number, targetHeight: number, projScaleY: number): number {
  const unitsPerPixel = Math.max(distance, 1e-4) / (0.5 * targetHeight * projScaleY);
  return Math.max(radius, FLUID_MIN_SPLAT_PX * unitsPerPixel);
}

/** What the filter needs of the params. */
export interface FluidFilterParams {
  zFar: number;
  filterRadius: number;
  filterRange: number;
  filterMaxPx: number;
  projScaleY: number;
}

/**
 * One pixel of one direction of the narrow-range filter — the CPU twin of
 * `fsFilter`. `depth` is a `width × height` target (distance over zFar, 1 =
 * no liquid). Float32 throughout, as the shader.
 */
export function fluidFilterPixel(depth: Float32Array, width: number, height: number, x: number, y: number, axis: 0 | 1, p: FluidFilterParams): number {
  const F = Math.fround;
  const d0 = depth[y * width + x];
  if (d0 >= FLUID_EMPTY) return 1;
  const zFar = F(p.zFar);
  const z0 = F(d0 * zFar);
  const pxPerUnit = F(F(F(0.5 * height) * F(p.projScaleY)) / Math.max(z0, F(1e-4)));
  const support = Math.min(Math.max(F(F(p.filterRadius) * pxPerUnit), 1), Math.min(p.filterMaxPx, FLUID_FILTER_MAX_TAPS));
  const sigma = F(0.5 * support);
  const taps = Math.ceil(support);
  const range = F(p.filterRange);
  let sum = z0;
  let weight = 1;
  for (let i = 1; i <= FLUID_FILTER_MAX_TAPS && i <= taps; i++) {
    const t = F(i / sigma);
    const w = F(Math.exp(F(-0.5 * F(t * t))));
    for (let side = -1; side <= 1; side += 2) {
      const qx = axis === 0 ? x + i * side : x;
      const qy = axis === 1 ? y + i * side : y;
      let z = F(z0 + range);
      if (qx >= 0 && qy >= 0 && qx < width && qy < height) {
        const d = depth[qy * width + qx];
        if (d < FLUID_EMPTY) z = F(d * zFar);
      }
      if (z < F(z0 - range)) continue;
      sum = F(sum + F(w * Math.min(z, F(z0 + range))));
      weight = F(weight + w);
    }
  }
  return Math.min(Math.max(F(F(sum / weight) / zFar), 0), F(FLUID_EMPTY - 1e-6));
}

/** A whole target through one direction of the filter. */
export function fluidFilterImage(depth: Float32Array, width: number, height: number, axis: 0 | 1, p: FluidFilterParams): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = fluidFilterPixel(depth, width, height, x, y, axis, p);
  }
  return out;
}
