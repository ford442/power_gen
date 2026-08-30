import rollerVertWgsl from '../passes/roller-vert.wgsl?raw';
import rollerFragWgsl from '../passes/roller-frag.wgsl?raw';

export function getRollerVertShader() {
  return rollerVertWgsl;
}

export function getRollerFragShader() {
  return rollerFragWgsl;
}
