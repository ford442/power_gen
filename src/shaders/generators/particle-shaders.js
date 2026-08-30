import particleVertWgsl from '../passes/particle-vert.wgsl?raw';
import particleFragWgsl from '../passes/particle-frag.wgsl?raw';

export function getParticleVertShader() {
  return particleVertWgsl;
}

export function getParticleFragShader() {
  return particleFragWgsl;
}
