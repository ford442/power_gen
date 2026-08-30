/**
 * Bloom post stack — canonical WGSL in passes/; this module only re-exports ?raw.
 */
import bloomVertWgsl from '../passes/bloom-vert.wgsl?raw';
import bloomExtractWgsl from '../passes/bloom-extract.wgsl?raw';
import bloomBlurWgsl from '../passes/bloom-blur.wgsl?raw';
import bloomCompositeWgsl from '../passes/bloom-composite.wgsl?raw';

export function getBloomVertShader() {
  return bloomVertWgsl;
}

export function getBloomExtractShader() {
  return bloomExtractWgsl;
}

export function getBloomBlurShader() {
  return bloomBlurWgsl;
}

export function getBloomCompositeShader() {
  return bloomCompositeWgsl;
}
