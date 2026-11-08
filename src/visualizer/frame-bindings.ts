/**
 * The scene pass's shared `@group(0)` (#225 §3) — schema layout `frame`.
 *
 *   0  Uniforms           camera viewProj / time / cameraPos (+ lighting packs)
 *   4  SEGLayoutUniforms  ring layout for seg-enhanced-vert
 *   5  LightingConfig     key / fill / rim / ground, ambient, IBL levels
 *   6  MaterialEntry[]    material table
 *   7  IBL env array      prefiltered GGX + irradiance
 *   8  IBL sampler
 *   9  shadow map         key-light depth (1×1 placeholder while released)
 *   10 comparison sampler
 *   11 ShadowUniforms     light matrix + enabled / bias / strength
 *
 * Two groups share the layout: the scene group, and the shadow-pass group —
 * same resources except binding 0 is the light's `Uniforms` (so caster
 * vertex shaders project into light space) and 9 is the placeholder (the map
 * is the pass's depth attachment; sampling it there is a usage conflict).
 *
 * Built lazily: every resource exists only after `_bootGpuState` finishes.
 * `invalidate()` (shadow map allocated / released) rebuilds both on next use
 * and bumps `generation`, which render bundles key on.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

export class FrameBindings {
  private scene: GPUBindGroup | null = null;
  private shadowPass: GPUBindGroup | null = null;
  /** Bumps on every rebuild — a bundle recorded against an older group is stale. */
  generation = 0;

  constructor(private readonly host: Host) {}

  invalidate(): void {
    if (!this.scene && !this.shadowPass) return;
    this.scene = null;
    this.shadowPass = null;
    this.generation++;
  }

  /** Scene pass group, or null while a frame resource is still missing (boot). */
  sceneGroup(): GPUBindGroup | null {
    if (!this.scene) this.scene = this.build('frame-scene', false);
    return this.scene;
  }

  /** Shadow pass group: light-space `Uniforms`, placeholder map. */
  shadowGroup(): GPUBindGroup | null {
    if (!this.shadowPass) this.shadowPass = this.build('frame-shadow', true);
    return this.shadowPass;
  }

  private build(label: string, forShadowPass: boolean): GPUBindGroup | null {
    const h = this.host;
    const cache = h.pipelineCache;
    const shadow = h.shadowMap;
    const ibl = h.iblResources;
    const globals = forShadowPass ? shadow?.casterUniformBuffer : h.globalUniformBuffer;
    if (!cache || !shadow || !ibl || !globals || !h.segLayoutUniformBuffer
        || !h.lightingUniformBuffer || !h.materialTableBuffer) {
      return null;
    }
    return cache.createBindGroup('frame', [
      { binding: 0, resource: { buffer: globals } },
      { binding: 4, resource: { buffer: h.segLayoutUniformBuffer } },
      { binding: 5, resource: { buffer: h.lightingUniformBuffer } },
      { binding: 6, resource: { buffer: h.materialTableBuffer } },
      { binding: 7, resource: ibl.view },
      { binding: 8, resource: ibl.sampler },
      { binding: 9, resource: forShadowPass ? shadow.placeholderSampleView() : shadow.sampleView() },
      { binding: 10, resource: shadow.sampler },
      { binding: 11, resource: { buffer: shadow.uniformBuffer } }
    ], label);
  }
}
