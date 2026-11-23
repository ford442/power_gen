/**
 * Screen-space liquid surface — the frame-graph side (ADR-0022,
 * docs/FLUIDS.md → The surface). WebGPU only, part of the lazily loaded
 * liquid chunk (imported by heron-liquid-runtime.ts).
 *
 * One graph pass that records five GPU passes and a copy:
 *
 *   splat depth      sphere impostors → the liquid's depth target, nearest wins
 *   splat thickness  the same impostors, additive → the liquid's thickness
 *   filter x, y      narrow-range filter between the two depth targets
 *   copy             scene colour → a copy the composite refracts
 *   composite        the shaded surface over the scene colour
 *
 * It runs after the scene pass (and the MSAA depth resolve) and before TAA,
 * SSR and bloom, so they see the liquid as part of the scene.
 *
 * Its four targets are a frame-graph lifetime of their own (`fluid-surface`):
 * allocated the first frame the pass is enabled, released after the graph's
 * hysteresis. They are the size of the scene colour target and follow it
 * through a resize.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { PassResources, ResourceLifetime } from './frame-graph';
import {
  ensureFluidSurfacePipelines, FLUID_DEPTH_FORMAT, FLUID_THICKNESS_FORMAT,
  type FluidSurfacePipelines
} from '../pipeline-layout/factories/fluid-surface-pipelines.js';
import { FLUID_SURFACE_SHADERS } from '../fluids/fluid-surface-shaders';
import {
  FLUID_SURFACE_PARAMS_BYTES, fluidOpticsForLook, packFluidSurfaceParams,
  type FluidSurfaceGeometry
} from '../fluids/fluid-surface';

type Host = MultiDeviceVisualizer;

/** The camera's far plane (multi-device-camera.ts `getProjMatrix`): the depth targets store distance over it. */
const CAMERA_FAR = 200;

/** What the pass draws this frame: a solver's draw export and where it sits. */
export interface FluidSurfaceDraw {
  /** 16-byte `GpuParticle` records (mpm-export.wgsl), bench-local. */
  buffer: GPUBuffer;
  count: number;
  /** Bench position in the scene. */
  origin: readonly [number, number, number];
  geometry: FluidSurfaceGeometry;
  metresPerUnit: number;
}

interface Targets {
  width: number;
  height: number;
  depthA: GPUTexture;
  depthB: GPUTexture;
  thickness: GPUTexture;
  sceneCopy: GPUTexture;
  /** Attachment views, and depth-only views for sampling. */
  depthAView: GPUTextureView;
  depthBView: GPUTextureView;
  depthASample: GPUTextureView;
  depthBSample: GPUTextureView;
  thicknessView: GPUTextureView;
  sceneCopyView: GPUTextureView;
}

/** What `prepare` hands the encode steps: this frame's targets, pipelines and bind groups. */
export interface FluidSurfaceFrameState {
  targets: Targets;
  pipelines: FluidSurfacePipelines;
  count: number;
  splat: GPUBindGroup;
  filterX: GPUBindGroup;
  filterY: GPUBindGroup;
  composite: GPUBindGroup;
  frameGroup: GPUBindGroup;
  sceneTexture: GPUTexture;
  sceneView: GPUTextureView;
}

export class FluidSurfacePass {
  ready = false;
  /** Frames the pass has encoded (diagnostics). */
  frames = 0;
  private pipelines: FluidSurfacePipelines | null = null;
  private targets: Targets | null = null;
  /** One copy of the params per filter direction; the splat and the composite read the first. */
  private readonly paramsX: GPUBuffer;
  private readonly paramsY: GPUBuffer;
  private readonly scratch = new Float32Array(FLUID_SURFACE_PARAMS_BYTES / 4);
  private splatGroup: { buffer: GPUBuffer; group: GPUBindGroup } | null = null;
  private filterGroups: { xFromA: GPUBindGroup; yFromB: GPUBindGroup } | null = null;
  private compositeGroup: { sceneDepth: GPUTextureView; group: GPUBindGroup } | null = null;
  private sceneView: { texture: GPUTexture; view: GPUTextureView } | null = null;

  constructor(private readonly device: GPUDevice, private readonly host: Host) {
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.paramsX = device.createBuffer({ label: 'fluid-surface-params-x', size: FLUID_SURFACE_PARAMS_BYTES, usage });
    this.paramsY = device.createBuffer({ label: 'fluid-surface-params-y', size: FLUID_SURFACE_PARAMS_BYTES, usage });
  }

  async init(): Promise<boolean> {
    const cache = this.host.pipelineCache;
    if (!cache) return false;
    this.pipelines = await ensureFluidSurfacePipelines(cache, FLUID_SURFACE_SHADERS);
    this.ready = true;
    return true;
  }

  lifetime(): ResourceLifetime {
    return {
      name: 'fluid-surface',
      isAllocated: () => !!this.targets,
      ensure: () => this.allocate(),
      release: () => this.release()
    };
  }

  /** Bytes of the four targets at their current size (0 when released). */
  get bytes(): number {
    const t = this.targets;
    if (!t) return 0;
    // rgba16float is 8 bytes a pixel; rg11b10ufloat and the 8-bit legacy formats are 4.
    const sceneBpp = this.host.pipelineCache?.sceneFormat === 'rgba16float' ? 8 : 4;
    // Two depth32float, one r16float, one scene-format copy.
    return t.width * t.height * (4 * 2 + 2 + sceneBpp);
  }

  get size(): [number, number] | null {
    return this.targets ? [this.targets.width, this.targets.height] : null;
  }

  /** The targets themselves, for the GPU tests that read them back. */
  get textures(): { depth: GPUTexture; depthScratch: GPUTexture; thickness: GPUTexture; sceneCopy: GPUTexture } | null {
    const t = this.targets;
    return t ? { depth: t.depthA, depthScratch: t.depthB, thickness: t.thickness, sceneCopy: t.sceneCopy } : null;
  }

  private allocate(): void {
    const cache = this.host.pipelineCache;
    const scene = this.host.bloomSceneTexture;
    if (this.targets || !cache || !scene) return;
    const { width, height } = scene;
    const device = this.device;
    const depth = (label: string): GPUTexture => device.createTexture({
      label,
      size: [width, height],
      format: FLUID_DEPTH_FORMAT,
      // COPY_SRC: the GPU tests read the targets back.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    });
    const depthA = depth('fluid-depth-a');
    const depthB = depth('fluid-depth-b');
    const thickness = device.createTexture({
      label: 'fluid-thickness',
      size: [width, height],
      format: FLUID_THICKNESS_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    });
    const sceneCopy = device.createTexture({
      label: 'fluid-scene-copy',
      size: [width, height],
      format: cache.sceneFormat,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
    });
    this.targets = {
      width, height, depthA, depthB, thickness, sceneCopy,
      depthAView: depthA.createView({ label: 'fluid-depth-a' }),
      depthBView: depthB.createView({ label: 'fluid-depth-b' }),
      depthASample: depthA.createView({ label: 'fluid-depth-a-sample', aspect: 'depth-only' }),
      depthBSample: depthB.createView({ label: 'fluid-depth-b-sample', aspect: 'depth-only' }),
      thicknessView: thickness.createView({ label: 'fluid-thickness' }),
      sceneCopyView: sceneCopy.createView({ label: 'fluid-scene-copy' })
    };
    this.filterGroups = null;
    this.compositeGroup = null;
    const profiler = this.host.profiler;
    profiler?.trackTexture?.('fluidDepthA', width, height, FLUID_DEPTH_FORMAT);
    profiler?.trackTexture?.('fluidDepthB', width, height, FLUID_DEPTH_FORMAT);
    profiler?.trackTexture?.('fluidThickness', width, height, FLUID_THICKNESS_FORMAT);
    profiler?.trackTexture?.('fluidSceneCopy', width, height, cache.sceneFormat);
  }

  private release(): void {
    const t = this.targets;
    if (!t) return;
    t.depthA.destroy();
    t.depthB.destroy();
    t.thickness.destroy();
    t.sceneCopy.destroy();
    this.targets = null;
    this.filterGroups = null;
    this.compositeGroup = null;
    this.host.profiler?.untrackTextures?.(['fluidDepthA', 'fluidDepthB', 'fluidThickness', 'fluidSceneCopy']);
  }

  /**
   * True when everything the pass reads from the host exists, so a frame that
   * exports the liquid for the surface will also get the surface drawn.
   */
  canRun(): boolean {
    const h = this.host;
    return this.ready && !!this.pipelines && !!h.pipelineCache && !!h.cameraController
      && !!h.bloomSceneTexture && !!h.bloomSampler && !!h.depthSampleView && !!h.frameBindings?.sceneGroup();
  }

  /**
   * The frame-graph pass body: all five passes and the copy.
   * @param msaa the scene pass was multisampled: read the resolved depth
   * @returns false when it bailed without drawing
   */
  encode(encoder: GPUCommandEncoder, draw: FluidSurfaceDraw, msaa: boolean, res?: PassResources): boolean {
    const frame = this.prepare(draw, msaa);
    if (!frame) return false;
    this.encodeSplat(encoder, frame, res?.timestamps('begin'));
    this.encodeFilter(encoder, frame);
    this.encodeComposite(encoder, frame, res?.timestamps('end'));
    this.frames++;
    return true;
  }

  /**
   * Upload this frame's params and make sure the targets and bind groups
   * match what the host has now. Null when something the pass reads is
   * missing. The three `encode*` steps take what this returns; the frame
   * graph runs them through `encode`, the GPU tests one at a time.
   */
  prepare(draw: FluidSurfaceDraw, msaa: boolean): FluidSurfaceFrameState | null {
    const h = this.host;
    const cache = h.pipelineCache;
    const pipelines = this.pipelines;
    const camera = h.cameraController;
    const sceneTexture = h.bloomSceneTexture;
    const sceneDepth = msaa ? h.depthResolvedSampleView : h.depthSampleView;
    const frameGroup = h.frameBindings?.sceneGroup();
    const sampler = h.bloomSampler;
    if (!cache || !pipelines || !camera || !sceneTexture || !sceneDepth || !frameGroup || !sampler || draw.count <= 0) return null;

    // A resize replaced the scene targets: follow them.
    if (this.targets && (this.targets.width !== sceneTexture.width || this.targets.height !== sceneTexture.height)) this.release();
    if (!this.targets) this.allocate();
    const t = this.targets;
    if (!t) return null;

    // Params: one copy per filter direction.
    const frameParams = {
      viewProj: camera.getViewProjMatrix(),
      view: camera.getViewMatrix(),
      proj: camera.getProjMatrix(),
      origin: draw.origin,
      targetSize: [t.width, t.height] as const,
      zFar: CAMERA_FAR,
      metresPerUnit: draw.metresPerUnit,
      geometry: draw.geometry,
      optics: fluidOpticsForLook(h.lightingLook)
    };
    this.device.queue.writeBuffer(this.paramsX, 0, packFluidSurfaceParams(frameParams, 0, this.scratch));
    this.device.queue.writeBuffer(this.paramsY, 0, packFluidSurfaceParams(frameParams, 1, this.scratch));

    if (this.splatGroup?.buffer !== draw.buffer) {
      this.splatGroup = {
        buffer: draw.buffer,
        group: cache.createBindGroup('fluidSplat', [
          { binding: 0, resource: { buffer: this.paramsX } },
          { binding: 1, resource: { buffer: draw.buffer } }
        ], 'fluid-splat-bg')
      };
    }
    this.filterGroups ??= {
      xFromA: cache.createBindGroup('fluidFilter', [
        { binding: 0, resource: { buffer: this.paramsX } },
        { binding: 1, resource: t.depthASample }
      ], 'fluid-filter-x-bg'),
      yFromB: cache.createBindGroup('fluidFilter', [
        { binding: 0, resource: { buffer: this.paramsY } },
        { binding: 1, resource: t.depthBSample }
      ], 'fluid-filter-y-bg')
    };
    if (this.compositeGroup?.sceneDepth !== sceneDepth) {
      this.compositeGroup = {
        sceneDepth,
        group: cache.createBindGroup('fluidComposite', [
          { binding: 0, resource: { buffer: this.paramsX } },
          { binding: 1, resource: t.depthASample },
          { binding: 2, resource: t.thicknessView },
          { binding: 3, resource: t.sceneCopyView },
          { binding: 4, resource: sceneDepth },
          { binding: 5, resource: sampler }
        ], 'fluid-composite-bg')
      };
    }
    if (this.sceneView?.texture !== sceneTexture) {
      this.sceneView = { texture: sceneTexture, view: sceneTexture.createView({ label: 'scene-color' }) };
    }
    return {
      targets: t,
      pipelines,
      count: draw.count,
      splat: this.splatGroup.group,
      filterX: this.filterGroups.xFromA,
      filterY: this.filterGroups.yFromB,
      composite: this.compositeGroup.group,
      frameGroup,
      sceneTexture,
      sceneView: this.sceneView.view
    };
  }

  /** Steps 1 and 2: the liquid's front surface, and how much liquid lies along each view ray. */
  encodeSplat(encoder: GPUCommandEncoder, f: FluidSurfaceFrameState, timestampWrites?: GPURenderPassTimestampWrites): void {
    const depthPass = encoder.beginRenderPass({
      label: 'fluid-splat-depth',
      colorAttachments: [],
      depthStencilAttachment: { view: f.targets.depthAView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites
    });
    depthPass.setPipeline(f.pipelines.depth);
    depthPass.setBindGroup(0, f.splat);
    depthPass.draw(4, f.count);
    depthPass.end();

    const thicknessPass = encoder.beginRenderPass({
      label: 'fluid-splat-thickness',
      colorAttachments: [{ view: f.targets.thicknessView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
    });
    thicknessPass.setPipeline(f.pipelines.thickness);
    thicknessPass.setBindGroup(0, f.splat);
    thicknessPass.draw(4, f.count);
    thicknessPass.end();
  }

  /** Step 3: the narrow-range filter, depth target A → B along x, B → A along y. */
  encodeFilter(encoder: GPUCommandEncoder, f: FluidSurfaceFrameState): void {
    const run = (label: string, target: GPUTextureView, group: GPUBindGroup): void => {
      const pass = encoder.beginRenderPass({
        label,
        colorAttachments: [],
        depthStencilAttachment: { view: target, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }
      });
      pass.setPipeline(f.pipelines.filter);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    };
    run('fluid-filter-x', f.targets.depthBView, f.filterX);
    run('fluid-filter-y', f.targets.depthAView, f.filterY);
  }

  /** Steps 4 and 5: copy the scene as it stands (what the liquid refracts), then the surface over it. */
  encodeComposite(encoder: GPUCommandEncoder, f: FluidSurfaceFrameState, timestampWrites?: GPURenderPassTimestampWrites): void {
    const t = f.targets;
    encoder.copyTextureToTexture({ texture: f.sceneTexture }, { texture: t.sceneCopy }, [t.width, t.height, 1]);
    const composite = encoder.beginRenderPass({
      label: 'fluid-composite',
      colorAttachments: [{ view: f.sceneView, loadOp: 'load', storeOp: 'store' }],
      timestampWrites
    });
    composite.setPipeline(f.pipelines.composite);
    composite.setBindGroup(0, f.frameGroup);
    composite.setBindGroup(1, f.composite);
    composite.draw(3);
    composite.end();
  }

  destroy(): void {
    this.release();
    this.paramsX.destroy();
    this.paramsY.destroy();
    this.splatGroup = null;
    this.sceneView = null;
    this.ready = false;
  }
}
