import fieldLineVertWgsl from '../passes/field-line-vert.wgsl?raw';
import fieldLineFragWgsl from '../passes/field-line-frag.wgsl?raw';
import fluxLineTracerWgsl from '../passes/flux-line-tracer.wgsl?raw';
import fluxSegmentVertWgsl from '../passes/flux-segment-vert.wgsl?raw';
import fluxSegmentFragWgsl from '../passes/flux-segment-frag.wgsl?raw';

export function getFieldLineVertShader() {
  return fieldLineVertWgsl;
}

export function getFieldLineFragShader() {
  return fieldLineFragWgsl;
}

export function getFluxLineTracerShader() {
  return fluxLineTracerWgsl;
}

export function getFluxSegmentVertShader() {
  return fluxSegmentVertWgsl;
}

export function getFluxSegmentFragShader() {
  return fluxSegmentFragWgsl;
}
