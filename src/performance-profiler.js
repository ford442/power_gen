export class PerformanceProfiler {
  constructor(device, canvas) {
    this.device = device;
    this.canvas = canvas;

    // GPU Timing
    this.timestampQuerySet = null;
    this.timestampResolveBuffer = null;
    this.timestampMappedBuffer = null;
    this.timingEnabled = false;
    this.queryCount = 8; // Space for multiple timestamps

    // FPS History (60 seconds at 60fps = 3600 samples, but we'll use 1 sample per frame)
    this.fpsHistory = new Float32Array(3600);
    this.fpsIndex = 0;
    this.fpsHistoryFilled = false;

    // Frame time history (ms)
    this.frameTimeHistory = new Float32Array(3600);

    // GPU time history (ms)
    this.gpuTimeHistory = new Float32Array(3600);

    // Particle count history
    this.particleHistory = new Uint32Array(3600);

    // Memory tracking
    this.bufferAllocations = [];
    this.textureAllocations = [];
    this.totalBufferMemory = 0;
    this.totalTextureMemory = 0;

    // Shader compilation times
    this.shaderCompileTimes = new Map();

    // Auto-quality settings
    this.autoQualityEnabled = true;
    this.targetFPS = 60;
    this.minAcceptableFPS = 45;
    this.qualityLevel = 1.0; // 0.0 to 1.0
    this.consecutiveLowFPSFrames = 0;
    this.consecutiveHighFPSFrames = 0;

    // Benchmark mode
    this.benchmarkMode = false;
    this.benchmarkStartTime = 0;
    this.benchmarkFrames = 0;
    this.benchmarkSamples = [];
    this.benchmarkDuration = 60; // seconds

    // GPU Info
    this.gpuTier = 'unknown';
    this.adapterInfo = null;

    this.init();
  }

  async init() {
    // Check for timestamp query support
    const adapter = await navigator.gpu.requestAdapter();
    this.adapterInfo = adapter?.info || {};

    // Detect GPU tier
    this.detectGPUTier();

    // Try to create timestamp query set
    try {
      this.timestampQuerySet = this.device.createQuerySet({
        type: 'timestamp',
        count: this.queryCount
      });

      this.timestampResolveBuffer = this.device.createBuffer({
        size: this.queryCount * 8, // 8 bytes per timestamp
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
      });

      this.timestampMappedBuffer = this.device.createBuffer({
        size: this.queryCount * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });

      this.timingEnabled = true;
      console.log('GPU timestamp queries enabled');
    } catch (e) {
      console.warn('GPU timestamp queries not supported:', e);
      this.timingEnabled = false;
    }
  }

  detectGPUTier() {
    const info = this.adapterInfo;
    const vendor = (info.vendor || '').toLowerCase();
    const architecture = (info.architecture || '').toLowerCase();

    // Heuristic GPU tier detection
    if (vendor.includes('nvidia') || vendor.includes('amd')) {
      if (architecture?.includes('ampere') || architecture?.includes('ada') ||
          architecture?.includes('rdna3') || architecture?.includes('rdna2')) {
        this.gpuTier = 'high';
      } else {
        this.gpuTier = 'medium';
      }
    } else if (vendor.includes('intel')) {
      if (architecture?.includes('xe') || architecture?.includes('arc')) {
        this.gpuTier = 'medium';
      } else {
        this.gpuTier = 'low';
      }
    } else if (vendor.includes('apple')) {
      this.gpuTier = 'medium'; // Apple Silicon
    } else {
      this.gpuTier = 'unknown';
    }

    console.log(`GPU Tier detected: ${this.gpuTier}`, info);
  }

  getOptimalSettings() {
    const settings = {
      high: { particleCount: 30000, enableFieldLines: true, enableSPH: true, targetFPS: 60 },
      medium: { particleCount: 20000, enableFieldLines: true, enableSPH: true, targetFPS: 60 },
      low: { particleCount: 10000, enableFieldLines: false, enableSPH: false, targetFPS: 45 },
      unknown: { particleCount: 15000, enableFieldLines: false, enableSPH: true, targetFPS: 60 }
    };
    return settings[this.gpuTier];
  }

  // Track buffer allocation
  trackBuffer(name, size, usage) {
    const entry = {
      name,
      size,
      usage,
      timestamp: Date.now()
    };
    this.bufferAllocations.push(entry);
    this.totalBufferMemory += size;
    return entry;
  }

  // Track texture allocation
  trackTexture(name, width, height, format) {
    const bytesPerPixel = this.getBytesPerPixel(format);
    const size = width * height * bytesPerPixel;
    const entry = {
      name,
      width,
      height,
      format,
      size,
      timestamp: Date.now()
    };
    this.textureAllocations.push(entry);
    this.totalTextureMemory += size;
    return entry;
  }

  getBytesPerPixel(format) {
    const formatSizes = {
      'r8unorm': 1, 'r8uint': 1, 'r8sint': 1,
      'r16uint': 2, 'r16sint': 2, 'r16float': 2,
      'rg8unorm': 2, 'rg8uint': 2, 'rg8sint': 2,
      'r32uint': 4, 'r32sint': 4, 'r32float': 4,
      'rg16uint': 4, 'rg16sint': 4, 'rg16float': 4,
      'rgba8unorm': 4, 'rgba8uint': 4, 'rgba8sint': 4,
      'bgra8unorm': 4,
      'rgb10a2unorm': 4,
      'rg11b10ufloat': 4,
      'rgba16uint': 8, 'rgba16sint': 8, 'rgba16float': 8,
      'rgba32uint': 16, 'rgba32sint': 16, 'rgba32float': 16,
      'depth24plus': 4, 'depth24plus-stencil8': 4,
      'depth32float': 4, 'depth32float-stencil8': 5
    };
    return formatSizes[format] || 4;
  }

  // Track shader compilation time
  async trackShaderCompile(shaderName, compileFn) {
    const start = performance.now();
    const result = await compileFn();
    const duration = performance.now() - start;
    this.shaderCompileTimes.set(shaderName, duration);
    console.log(`Shader '${shaderName}' compiled in ${duration.toFixed(2)}ms`);
    return result;
  }

  // Record frame metrics
  recordFrame(deltaTime, particleCount, encoder) {
    const fps = 1.0 / deltaTime;

    // Store in history
    this.fpsHistory[this.fpsIndex] = fps;
    this.frameTimeHistory[this.fpsIndex] = deltaTime * 1000;
    this.particleHistory[this.fpsIndex] = particleCount;
    this.gpuTimeHistory[this.fpsIndex] = 0; // Will be updated async

    this.fpsIndex = (this.fpsIndex + 1) % this.fpsHistory.length;
    if (this.fpsIndex === 0) this.fpsHistoryFilled = true;

    // Benchmark mode
    if (this.benchmarkMode) {
      this.benchmarkFrames++;
      this.benchmarkSamples.push({
        time: performance.now(),
        fps,
        particleCount
      });

      const elapsed = (performance.now() - this.benchmarkStartTime) / 1000;
      if (elapsed >= this.benchmarkDuration) {
        this.endBenchmark();
      }
    }

    // Auto quality adjustment
    if (this.autoQualityEnabled && !this.benchmarkMode) {
      this.adjustQuality(fps);
    }

    return this.fpsIndex;
  }

  adjustQuality(currentFPS) {
    if (currentFPS < this.minAcceptableFPS) {
      this.consecutiveLowFPSFrames++;
      this.consecutiveHighFPSFrames = 0;

      if (this.consecutiveLowFPSFrames > 30) { // 0.5 seconds at 60fps
        this.qualityLevel = Math.max(0.3, this.qualityLevel - 0.1);
        this.consecutiveLowFPSFrames = 0;
        console.log(`Quality reduced to ${(this.qualityLevel * 100).toFixed(0)}%`);
      }
    } else if (currentFPS > this.targetFPS - 5) {
      this.consecutiveHighFPSFrames++;
      this.consecutiveLowFPSFrames = 0;

      if (this.consecutiveHighFPSFrames > 120) { // 2 seconds sustained
        this.qualityLevel = Math.min(1.0, this.qualityLevel + 0.05);
        this.consecutiveHighFPSFrames = 0;
        console.log(`Quality increased to ${(this.qualityLevel * 100).toFixed(0)}%`);
      }
    } else {
      this.consecutiveLowFPSFrames = 0;
      this.consecutiveHighFPSFrames = 0;
    }
  }

  // Start benchmark
  startBenchmark() {
    this.benchmarkMode = true;
    this.benchmarkStartTime = performance.now();
    this.benchmarkFrames = 0;
    this.benchmarkSamples = [];
    console.log('Benchmark started...');
    return this.benchmarkDuration;
  }

  // End benchmark
  endBenchmark() {
    this.benchmarkMode = false;
    const elapsed = (performance.now() - this.benchmarkStartTime) / 1000;

    // Calculate statistics
    const fpsValues = this.benchmarkSamples.map(s => s.fps);
    const avgFPS = fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length;
    const minFPS = Math.min(...fpsValues);
    const maxFPS = Math.max(...fpsValues);

    // Calculate percentiles
    const sortedFPS = [...fpsValues].sort((a, b) => a - b);
    const p1 = sortedFPS[Math.floor(sortedFPS.length * 0.01)];
    const p99 = sortedFPS[Math.floor(sortedFPS.length * 0.99)];

    const results = {
      duration: elapsed,
      totalFrames: this.benchmarkFrames,
      averageFPS: avgFPS,
      minFPS,
      maxFPS,
      p1FPS: p1,
      p99FPS: p99,
      onePercentLow: p1,
      samples: this.benchmarkSamples
    };

    console.log('Benchmark Results:', results);
    return results;
  }

  // Get current stats
  getStats() {
    const count = this.fpsHistoryFilled ? this.fpsHistory.length : this.fpsIndex;
    const recentCount = Math.min(60, count);

    let avgFPS = 0;
    let minFPS = Infinity;
    let maxFPS = 0;

    for (let i = 0; i < recentCount; i++) {
      const idx = (this.fpsIndex - 1 - i + this.fpsHistory.length) % this.fpsHistory.length;
      const fps = this.fpsHistory[idx];
      avgFPS += fps;
      minFPS = Math.min(minFPS, fps);
      maxFPS = Math.max(maxFPS, fps);
    }
    avgFPS /= recentCount;

    return {
      currentFPS: this.fpsHistory[(this.fpsIndex - 1 + this.fpsHistory.length) % this.fpsHistory.length],
      averageFPS: avgFPS,
      minFPS: minFPS === Infinity ? 0 : minFPS,
      maxFPS,
      qualityLevel: this.qualityLevel,
      gpuTier: this.gpuTier,
      bufferMemoryMB: (this.totalBufferMemory / 1024 / 1024).toFixed(2),
      textureMemoryMB: (this.totalTextureMemory / 1024 / 1024).toFixed(2),
      totalMemoryMB: ((this.totalBufferMemory + this.totalTextureMemory) / 1024 / 1024).toFixed(2),
      bufferCount: this.bufferAllocations.length,
      textureCount: this.textureAllocations.length,
      timingEnabled: this.timingEnabled,
      benchmarkMode: this.benchmarkMode,
      autoQualityEnabled: this.autoQualityEnabled
    };
  }

  // Write timestamp to encoder
  writeTimestamp(encoder, index) {
    if (this.timingEnabled && index < this.queryCount) {
      encoder.writeTimestamp(this.timestampQuerySet, index);
    }
  }

  // Resolve timestamps
  async resolveTimestamps() {
    if (!this.timingEnabled) return;

    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.resolveQuerySet(
      this.timestampQuerySet,
      0,
      this.queryCount,
      this.timestampResolveBuffer,
      0
    );
    commandEncoder.copyBufferToBuffer(
      this.timestampResolveBuffer,
      0,
      this.timestampMappedBuffer,
      0,
      this.queryCount * 8
    );
    this.device.queue.submit([commandEncoder.finish()]);

    // Read results
    await this.timestampMappedBuffer.mapAsync(GPUMapMode.READ);
    const timestamps = new BigUint64Array(this.timestampMappedBuffer.getMappedRange());

    // Convert to milliseconds (nanoseconds to ms)
    const gpuTimeMs = Number(timestamps[1] - timestamps[0]) / 1_000_000;

    // Update history
    const idx = (this.fpsIndex - 1 + this.gpuTimeHistory.length) % this.gpuTimeHistory.length;
    this.gpuTimeHistory[idx] = gpuTimeMs;

    this.timestampMappedBuffer.unmap();
    return gpuTimeMs;
  }

  // Generate FPS graph data for canvas
  getFPSGraphData(width, height) {
    const points = [];
    const count = Math.min(width, this.fpsHistoryFilled ? this.fpsHistory.length : this.fpsIndex);

    for (let i = 0; i < count; i++) {
      const idx = (this.fpsIndex - count + i + this.fpsHistory.length) % this.fpsHistory.length;
      const fps = this.fpsHistory[idx];
      const x = (i / (count - 1)) * width;
      const y = height - (fps / 80) * height; // Scale 0-80 FPS to height
      points.push({ x, y, fps });
    }

    return points;
  }

  // Get particle vs FPS correlation data
  getParticleFPSCorrelation() {
    const data = [];
    const count = this.fpsHistoryFilled ? this.fpsHistory.length : this.fpsIndex;

    for (let i = 0; i < count; i++) {
      data.push({
        particles: this.particleHistory[i],
        fps: this.fpsHistory[i],
        frameTime: this.frameTimeHistory[i]
      });
    }

    return data;
  }
}