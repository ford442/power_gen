/**
 * Reusable WGSL snippets for Cook-Torrance / GGX PBR across SEG shaders.
 * Source of truth: `src/shaders/common/pbr-*.wgsl` (included via ?raw).
 * Generators still concatenate these strings; pass files can `#include` the same paths.
 */
import pbrSurface from '../common/pbr-surface.wgsl?raw';
import pbrBrdf from '../common/pbr-brdf.wgsl?raw';
import pbrLighting from '../common/pbr-lighting.wgsl?raw';
import pbrEval from '../common/pbr-eval.wgsl?raw';

/** Noise, normal perturbation, and surface micro-detail. */
export const PBR_SURFACE_WGSL = pbrSurface;

/** BRDF + lighting evaluation helpers. */
export const PBR_BRDF_WGSL = pbrBrdf;

/** Lighting uniform block — matches CPU upload (48 floats). */
export const PBR_LIGHTING_STRUCT_WGSL = pbrLighting;

/** Directional PBR + hemispherical IBL approximation. */
export const PBR_EVAL_WGSL = pbrEval;
