import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/** Sky, grid, anomaly walls, bloom stack, SSR, MSAA depth resolve. */
export function registerPostLayouts(r: LayoutRegistrar): void {
  r.bgl('sky', BGL.sky);
  r.pl('sky', ['sky']);

  r.bgl('empty', BGL.empty);
  r.pl('empty', ['empty']);
  const emptyPl = r.device.createPipelineLayout({
    label: 'pl-empty-groups',
    bindGroupLayouts: []
  });
  r.setEmptyGroupsPipeline(emptyPl);

  r.bgl('anomalyWall', BGL.anomalyWall);
  r.pl('anomalyWall', ['anomalyWall']);

  r.bgl('bloomExtract', BGL.bloomExtract);
  r.pl('bloomExtract', ['bloomExtract']);

  r.bgl('bloomBlur', BGL.bloomBlur);
  r.pl('bloomBlur', ['bloomBlur']);

  r.bgl('bloomComposite', BGL.bloomComposite);
  r.pl('bloomComposite', ['bloomComposite']);

  r.bgl('ssr', BGL.ssr);
  r.pl('ssr', ['ssr']);

  // IBL GGX prefilter (ADR-0005 WS2): writes the octahedral roughness chain +
  // irradiance layer straight into the sampled array texture, one dispatch per
  // layer. See passes/ibl-prefilter-compute.wgsl.
  r.bgl('iblPrefilter', BGL.iblPrefilter);
  r.pl('iblPrefilter', ['iblPrefilter']);

  // Temporal AA resolve (ADR-0005 WS2) — see passes/taa-resolve.wgsl.
  r.bgl('taaResolve', BGL.taaResolve);
  r.pl('taaResolve', ['taaResolve']);

  r.bgl('depthResolve', BGL.depthResolve);
  r.pl('depthResolve', ['depthResolve']);
}
