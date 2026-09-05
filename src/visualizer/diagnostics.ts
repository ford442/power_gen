// Speed test harness and GPU particle readback for debugging.
import { CULL_OUTPUT_HEADER_BYTES, DRAW_ARGS_STRIDE } from '../devices/overview-cull';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { DeviceInstance } from '../device-instance.js';

type Host = MultiDeviceVisualizer;
type DiagDevice = DeviceInstance & { _prevEffectBudget?: number };

export const diagnosticsMethods: ThisType<Host> & {
  runSpeedTest(speeds?: number[], durationMs?: number): Promise<void>;
  captureParticleSubset(deviceId?: string, maxCount?: number): Promise<unknown>;
  captureOverviewCull(): Promise<unknown>;
} = {
  /**
   * Quality/perf test harness: step through a set of speed multipliers for a
   * fixed duration, then print average frame time, FPS, and SEG effect metrics.
   * Exposed as window.runSEGSpeedTest([0.1, 1, 10, 30], 3000).
   */
  async runSpeedTest(speeds: number[] = [0.1, 1, 10, 30], durationMs: number = 3000) {
    const slider = document.getElementById('speedControl') as HTMLInputElement | null;
    if (!slider) {
      console.warn('[SpeedTest] #speedControl not found');
      return;
    }
    const speedToSlider = (speed: number) => Math.max(0, Math.min(100, 100 * Math.log(speed / 0.05) / Math.log(400)));
    const segDevice = this.devices['seg'] as DiagDevice | undefined;

    console.log('[SpeedTest] starting — speeds:', speeds, 'duration:', durationMs, 'ms');
    const results: Array<{
      speed: number;
      fps: number;
      minFps: number;
      maxFps: number;
      frames: number;
      energy: number;
      effectBudget: number;
    }> = [];

    for (const speed of speeds) {
      slider.value = String(speedToSlider(speed));
      await new Promise((r) => setTimeout(r, 500));

      const startFrame = (this.profiler as { frameCount?: number } | null)?.frameCount || 0;
      const startTime = performance.now();
      let minFps = 999;
      let maxFps = 0;

      while (performance.now() - startTime < durationMs) {
        await new Promise((r) => requestAnimationFrame(r));
        const f = this.fps || 0;
        if (f > 0) {
          minFps = Math.min(minFps, f);
          maxFps = Math.max(maxFps, f);
        }
      }

      const endFrame = (this.profiler as { frameCount?: number } | null)?.frameCount || startFrame;
      results.push({
        speed,
        fps: this.fps || 0,
        minFps: minFps === 999 ? 0 : minFps,
        maxFps,
        frames: endFrame - startFrame,
        energy: segDevice?.energyLevel || 0,
        effectBudget: segDevice?._prevEffectBudget || 0
      });
      console.log(`[SpeedTest] ${speed.toFixed(2)}× — FPS ${this.fps} (min ${minFps === 999 ? 0 : minFps}, max ${maxFps}), energy ${(segDevice?.energyLevel || 0).toFixed(3)}`);
    }

    console.table(results);
    console.log('[SpeedTest] complete');
  },

  /**
   * Debug: read back first N GPU particles for WASM / CPU validation.
   * Enable via ?debugParticles=1 or window.captureParticleSubset.
   */
  async captureParticleSubset(deviceId: string = 'seg', maxCount: number = 64) {
    const dev = this.devices?.[deviceId] as DiagDevice | undefined;
    const buf = dev?.particles;
    if (!buf || !this.device) return null;

    const count = Math.min(
      maxCount,
      dev.scaledParticleCount || dev.particleCount || maxCount
    );
    const byteLen = count * 16;
    const staging = this.device.createBuffer({
      size: byteLen,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, staging, 0, byteLen);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    const out: Array<{ x: number; y: number; z: number; phase: number }> = [];
    for (let i = 0; i < count; i++) {
      const b = i * 4;
      out.push({
        x: raw[b], y: raw[b + 1], z: raw[b + 2], phase: raw[b + 3]
      });
    }
    return { deviceId, count, particles: out, renderer: 'webgpu' };
  },

  /**
   * Debug: read back the overview cull pass results (ADR-0005 WS4 acceptance).
   * Exposed as window.captureOverviewCull(). Returns null outside overview or
   * when the GPU cull path is inactive.
   */
  async captureOverviewCull() {
    const cull = this.overviewCull;
    if (!cull?.active || !cull.outputBuffer || !cull.drawArgsBuffer) return null;

    const headerBytes = CULL_OUTPUT_HEADER_BYTES + cull.deviceCount * 4;
    const argsBytes = cull.deviceCount * DRAW_ARGS_STRIDE;
    const staging = this.device.createBuffer({
      size: headerBytes + argsBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(cull.outputBuffer, 0, staging, 0, headerBytes);
    enc.copyBufferToBuffer(cull.drawArgsBuffer, 0, staging, headerBytes, argsBytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const raw = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    const argsBase = headerBytes / 4;
    const devices = cull.slots.map((slot, i) => ({
      id: slot.id,
      lodLevel: slot.lodLevel,
      baseCount: slot.baseCount,
      instanceCount: raw[argsBase + i * 4 + 1],
      visible: raw[argsBase + i * 4 + 1] > 0
    }));

    return {
      visibleCount: raw[0],
      drawnInstances: raw[1],
      deviceCount: cull.deviceCount,
      drawPrepMs: this.profiler?.drawPrepMs ?? 0,
      devices
    };
  }
};
