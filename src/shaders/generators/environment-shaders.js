/**
 * Environment sky + grid passes — canonical WGSL in passes/; thin ?raw re-exports.
 */
import skyVertWgsl from '../passes/sky-vert.wgsl?raw';
import skyFragWgsl from '../passes/sky-frag.wgsl?raw';
import gridVertWgsl from '../passes/grid-vert.wgsl?raw';
import gridFragWgsl from '../passes/grid-frag.wgsl?raw';

export function getSkyVertShader() {
  return skyVertWgsl;
}

export function getSkyFragShader() {
  return skyFragWgsl;
}

export function getGridVertShader() {
  return gridVertWgsl;
}

export function getGridFragShader() {
  return gridFragWgsl;
}
