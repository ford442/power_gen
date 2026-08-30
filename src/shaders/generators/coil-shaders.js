import coilVertWgsl from '../passes/coil-vert.wgsl?raw';
import coilFragWgsl from '../passes/coil-frag.wgsl?raw';

export function getCoilVertShader() {
  return coilVertWgsl;
}

export function getCoilFragShader() {
  return coilFragWgsl;
}
