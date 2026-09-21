// Facade methods that just forward to MultiDeviceVisualizer's collaborator
// objects (geometryFactory, postStack, frameLoop, materialTable, diagnostics,
// gltfProps, session) or to the free primitive-mesh generators. Split out
// purely to keep multi-device-visualizer.ts under the repo's line-count cap
// (issues #142/#143/#187) — attached in the constructor via
// `Object.assign(this, bindHostMethods(facadeMethods, this))` and merged
// into the class's public type via `VisualizerFacadeMethods` (see
// multi-device-visualizer.ts's `export interface MultiDeviceVisualizer
// extends ... VisualizerFacadeMethods {}`). No behavior change from the
// methods this replaces.
import {
  generateCylinder,
  generateCylinderWithUVs,
  generateDisc,
  generateDiscWithUVs,
  generateBoxWithUVs,
  type PrimitiveMesh
} from './primitives.js';
import type { DeviceInstance } from '../device-instance.js';
import type { GltfPropRegistry } from './setup-gltf.js';
import type { PostStack } from './scene-setup.js';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

export interface VisualizerFacadeMethods {
  generateCylinder(radius: number, height: number, segments: number): PrimitiveMesh;
  generateCylinderWithUVs(radius: number, height: number, segments: number): PrimitiveMesh;
  generateDisc(innerRadius: number, outerRadius: number, thickness: number, segments: number): PrimitiveMesh;
  generateDiscWithUVs(innerRadius: number, outerRadius: number, thickness: number, segments: number): PrimitiveMesh;
  generateBoxWithUVs(width: number, height: number, depth: number): PrimitiveMesh;

  setupSharedGeometry(): Promise<void>;
  setupDefaultPrimitiveGeometry(deviceId: string, config: { color?: unknown }): Promise<void>;
  _setupCoreSEGSharedMeshes(): Promise<void>;
  _setupAlternateDeviceSharedMeshes(): Promise<void>;

  setupFloorGrid(): Promise<void>;
  setupSkyGradient(): Promise<void>;
  setupAnomalyWallPipeline(): Promise<void>;
  setupDepthBuffer(): Promise<void>;
  setupBloomTextures(): void;
  setupBloomPipeline(): Promise<void>;
  setupTaaPipeline(): Promise<void>;
  _rebuildTaaBindGroups(): void;
  setupIblPrefilter(): ReturnType<PostStack['setupIblPrefilter']>;
  refreshIblPrefilter(): void;
  _bakeIbl(): ReturnType<PostStack['_bakeIbl']>;
  setupSsrTexture(): void;
  setupSsrPipeline(): Promise<void>;
  setupDepthResolvePipeline(): Promise<void>;
  _waitForCanvasLayout(): Promise<void>;
  _observeCanvasLayout(): void;
  _syncCanvasSize(): Promise<void>;
  _rebuildBloomBindGroups(): void;
  _rebuildSsrBindGroup(): void;
  _rebuildDepthResolveBindGroup(): void;

  render(timestamp: number): void;
  renderAnomalyWalls(
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer | null,
    segDevice: DeviceInstance | null | undefined
  ): void;
  _encodeTaaResolve(encoder: GPUCommandEncoder, msaaActive: boolean): boolean;
  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean): void;

  setupMaterialTableBuffer(): void;

  runSpeedTest(speeds?: number[], durationMs?: number): Promise<void>;
  captureParticleSubset(deviceId?: string, maxCount?: number): Promise<unknown>;
  captureOverviewCull(): Promise<unknown>;

  setupGltfAssets(embeddedGlb?: ArrayBuffer, opts?: { propBuffers?: Record<string, ArrayBuffer> }): Promise<void>;
  ensureGltfPropsForView(view: string): Promise<void>;
  updateGltfHousingState(): void;
  _loadGltfPropsForSegFocus(view?: string): Promise<void>;
  _loadGltfPropsForSegFocusInner(view: string): Promise<void>;
  _disposeFocusOnlyGltfProps(keepDeviceId?: string): void;
  _uploadGltfProp(
    prop: Parameters<GltfPropRegistry['_uploadGltfProp']>[0],
    ctx: Parameters<GltfPropRegistry['_uploadGltfProp']>[1]
  ): Promise<void>;

  _updateHardwareTwin(deltaTime: number): void;
  _updateTachometer(): void;
  _updateDeviceTelemetry(): void;

  getSEGLayoutPreset(): string;
  getHeronLayoutPreset(): string;
  /**
   * Whether a device should simulate and render this frame.
   * Overview shows all enabled devices; focused mode shows only the active device.
   */
  isDeviceActive(deviceId: string): boolean;
  isOverviewMode(): boolean;
}

export const facadeMethods: ThisType<Host> & VisualizerFacadeMethods = {
  generateCylinder(radius, height, segments) {
    return generateCylinder(radius, height, segments);
  },
  generateCylinderWithUVs(radius, height, segments) {
    return generateCylinderWithUVs(radius, height, segments);
  },
  generateDisc(innerRadius, outerRadius, thickness, segments) {
    return generateDisc(innerRadius, outerRadius, thickness, segments);
  },
  generateDiscWithUVs(innerRadius, outerRadius, thickness, segments) {
    return generateDiscWithUVs(innerRadius, outerRadius, thickness, segments);
  },
  generateBoxWithUVs(width, height, depth) {
    return generateBoxWithUVs(width, height, depth);
  },

  setupSharedGeometry() { return this.geometryFactory.setupSharedGeometry(); },
  setupDefaultPrimitiveGeometry(deviceId, config) {
    return this.geometryFactory.setupDefaultPrimitiveGeometry(deviceId, config);
  },
  _setupCoreSEGSharedMeshes() { return this.geometryFactory._setupCoreSEGSharedMeshes(); },
  _setupAlternateDeviceSharedMeshes() { return this.geometryFactory._setupAlternateDeviceSharedMeshes(); },

  setupFloorGrid() { return this.postStack.setupFloorGrid(); },
  setupSkyGradient() { return this.postStack.setupSkyGradient(); },
  setupAnomalyWallPipeline() { return this.postStack.setupAnomalyWallPipeline(); },
  setupDepthBuffer() { return this.postStack.setupDepthBuffer(); },
  setupBloomTextures() { this.postStack.setupBloomTextures(); },
  setupBloomPipeline() { return this.postStack.setupBloomPipeline(); },
  setupTaaPipeline() { return this.postStack.setupTaaPipeline(); },
  _rebuildTaaBindGroups() { this.postStack._rebuildTaaBindGroups(); },
  setupIblPrefilter() { return this.postStack.setupIblPrefilter(); },
  refreshIblPrefilter() { this.postStack.refreshIblPrefilter(); },
  _bakeIbl() { return this.postStack._bakeIbl(); },
  setupSsrTexture() { this.postStack.setupSsrTexture(); },
  setupSsrPipeline() { return this.postStack.setupSsrPipeline(); },
  setupDepthResolvePipeline() { return this.postStack.setupDepthResolvePipeline(); },
  _waitForCanvasLayout() { return this.postStack._waitForCanvasLayout(); },
  _observeCanvasLayout() { this.postStack._observeCanvasLayout(); },
  _syncCanvasSize() { return this.postStack._syncCanvasSize(); },
  _rebuildBloomBindGroups() { this.postStack._rebuildBloomBindGroups(); },
  _rebuildSsrBindGroup() { this.postStack._rebuildSsrBindGroup(); },
  _rebuildDepthResolveBindGroup() { this.postStack._rebuildDepthResolveBindGroup(); },

  render(timestamp) { this.frameLoop.render(timestamp); },
  renderAnomalyWalls(renderPass, globalUniformBuffer, segDevice) {
    this.frameLoop.renderAnomalyWalls(renderPass, globalUniformBuffer, segDevice);
  },
  _encodeTaaResolve(encoder, msaaActive) {
    return this.frameLoop._encodeTaaResolve(encoder, msaaActive);
  },
  _dispatchSsr(encoder, msaaActive) {
    this.frameLoop._dispatchSsr(encoder, msaaActive);
  },

  setupMaterialTableBuffer() { this.materialTable.setupMaterialTableBuffer(); },

  runSpeedTest(speeds, durationMs) {
    return this.diagnostics.runSpeedTest(speeds, durationMs);
  },
  captureParticleSubset(deviceId, maxCount) {
    return this.diagnostics.captureParticleSubset(deviceId, maxCount);
  },
  captureOverviewCull() {
    return this.diagnostics.captureOverviewCull();
  },

  setupGltfAssets(embeddedGlb, opts) {
    return this.gltfProps.setupGltfAssets(embeddedGlb, opts);
  },
  ensureGltfPropsForView(view) { return this.gltfProps.ensureGltfPropsForView(view); },
  updateGltfHousingState() { this.gltfProps.updateGltfHousingState(); },
  _loadGltfPropsForSegFocus(view) { return this.gltfProps._loadGltfPropsForSegFocus(view); },
  _loadGltfPropsForSegFocusInner(view) { return this.gltfProps._loadGltfPropsForSegFocusInner(view); },
  _disposeFocusOnlyGltfProps(keepDeviceId) { this.gltfProps._disposeFocusOnlyGltfProps(keepDeviceId); },
  _uploadGltfProp(prop, ctx) {
    return this.gltfProps._uploadGltfProp(prop, ctx);
  },

  _updateHardwareTwin(deltaTime) { this.session.syncHardwareTwin(deltaTime); },
  _updateTachometer() { this.session.updateTachometer(); },
  _updateDeviceTelemetry() { this.session.publishModeTelemetry(); },

  getSEGLayoutPreset() { return this.segLayoutPreset; },
  getHeronLayoutPreset() { return this.heronLayoutPreset; },
  isDeviceActive(deviceId) { return this.session.isDeviceActive(deviceId); },
  isOverviewMode() { return this.session.isOverviewMode(); }
};
