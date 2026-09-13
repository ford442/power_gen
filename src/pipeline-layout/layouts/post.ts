import type { LayoutRegistrar } from '../types.js';
import {
  uniform, texture, depthTexture, depthTextureMultisampled, sampler, storageTexture,
  storageTextureArray, VF, FS, CS, SSR_FORMAT
} from '../helpers.js';
import { IBL_FORMAT } from '../../ibl-prefilter.js';

/** Sky, grid, anomaly walls, bloom stack, SSR, MSAA depth resolve. */
export function registerPostLayouts(r: LayoutRegistrar): void {
  r.bgl('sky', [uniform(0, FS)]);
  r.pl('sky', ['sky']);

  r.bgl('empty', []);
  r.pl('empty', ['empty']);
  const emptyPl = r.device.createPipelineLayout({
    label: 'pl-empty-groups',
    bindGroupLayouts: []
  });
  r.setEmptyGroupsPipeline(emptyPl);

  r.bgl('anomalyWall', [
    uniform(0, VF),
    uniform(1, FS)
  ]);
  r.pl('anomalyWall', ['anomalyWall']);

  r.bgl('bloomExtract', [
    texture(0, FS),
    sampler(1, FS),
    uniform(2, FS)
  ]);
  r.pl('bloomExtract', ['bloomExtract']);

  r.bgl('bloomBlur', [
    texture(0, FS),
    sampler(1, FS),
    uniform(2, FS),
    uniform(3, FS)
  ]);
  r.pl('bloomBlur', ['bloomBlur']);

  r.bgl('bloomComposite', [
    texture(0, FS),
    texture(1, FS),
    sampler(2, FS),
    uniform(3, FS),
    depthTexture(4, FS),
    texture(5, FS),
    texture(6, FS)
  ]);
  r.pl('bloomComposite', ['bloomComposite']);

  r.bgl('ssr', [
    depthTexture(0, CS),
    texture(1, CS),
    sampler(2, CS),
    uniform(3, CS),
    storageTexture(4, CS, SSR_FORMAT),
    texture(5, CS)
  ]);
  r.pl('ssr', ['ssr']);

  // IBL GGX prefilter (ADR-0005 WS2): writes the octahedral roughness chain +
  // irradiance layer straight into the sampled array texture, one dispatch per
  // layer. See passes/ibl-prefilter-compute.wgsl.
  r.bgl('iblPrefilter', [
    uniform(0, CS),
    storageTextureArray(1, CS, IBL_FORMAT)
  ]);
  r.pl('iblPrefilter', ['iblPrefilter']);

  r.bgl('depthResolve', [
    depthTextureMultisampled(0, FS)
  ]);
  r.pl('depthResolve', ['depthResolve']);
}
