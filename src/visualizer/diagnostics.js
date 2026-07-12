// Speed test harness and GPU particle readback for debugging.

export const diagnosticsMethods = {
  /**
   * Quality/perf test harness: step through a set of speed multipliers for a
   * fixed duration, then print average frame time, FPS, and SEG effect metrics.
   * Exposed as window.runSEGSpeedTest([0.1, 1, 10, 30], 3000).
   */
  async runSpeedTest(speeds = [0.1, 1, 10, 30], durationMs = 3000) {
    const slider = document.getElementById('speedControl');
    if (!slider) {
      console.warn('[SpeedTest] #speedControl not found');
      return;
    }
    const speedToSlider = (speed) => Math.max(0, Math.min(100, 100 * Math.log(speed / 0.05) / Math.log(400)));
    const segDevice = this.devices['seg'];

    console.log('[SpeedTest] starting — speeds:', speeds, 'duration:', durationMs, 'ms');
    const results = [];

    for (const speed of speeds) {
      slider.value = speedToSlider(speed);
      await new Promise(r => setTimeout(r, 500));

      const startFps = this.fps || 0;
      const startFrame = this.profiler?.frameCount || 0;
      const startTime = performance.now();
      let minFps = 999;
      let maxFps = 0;
      let samples = 0;

      while (performance.now() - startTime < durationMs) {
        await new Promise(r => requestAnimationFrame(r));
        const f = this.fps || 0;
        if (f > 0) {
          minFps = Math.min(minFps, f);
          maxFps = Math.max(maxFps, f);
          samples++;
        }
      }

      const endFrame = this.profiler?.frameCount || startFrame;
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
  async captureParticleSubset(deviceId = 'seg', maxCount = 64) {
    const dev = this.devices?.[deviceId];
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

    const out = [];
    for (let i = 0; i < count; i++) {
      const b = i * 4;
      out.push({
        x: raw[b], y: raw[b + 1], z: raw[b + 2], phase: raw[b + 3]
      });
    }
    return { deviceId, count, particles: out, renderer: 'webgpu' };
  }
};