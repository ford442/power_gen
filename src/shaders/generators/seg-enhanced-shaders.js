import segEnhancedVertWgsl from '../passes/seg-enhanced-vert.wgsl?raw';
import segEnhancedFragWgsl from '../passes/seg-enhanced-frag.wgsl?raw';

export function getSegEnhancedVertShader() {
  return segEnhancedVertWgsl;
}

export function getSegEnhancedFragShader() {
  return segEnhancedFragWgsl;
}
