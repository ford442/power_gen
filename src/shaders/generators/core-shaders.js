import coreVertWgsl from '../passes/core-vert.wgsl?raw';
import coreFragWgsl from '../passes/core-frag.wgsl?raw';

export function getCoreVertShader() {
  return coreVertWgsl;
}

export function getCoreFragShader() {
  return coreFragWgsl;
}
