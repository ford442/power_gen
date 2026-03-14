// CacheBust: v5 - Fixed depthStencil
import RAPIER from '@dimforge/rapier3d';
import {
  PHYSICAL_CONSTANTS,
  SEG_DATA,
  KELVIN_DATA,
  HERON_DATA,
  MICROVOLT_DATA,
  UNIFIED_PHYSICS_WGSL
} from './scientific-data.js';

// Log scientific data sources
console.log('=== SCIENTIFIC DATA LOADED (Wolfram Sources) ===');
console.log('SEG Magnetic Moment:', SEG_DATA.MAGNETIC_MOMENT, 'A·m²');
console.log('Kelvin Bucket Capacitance:', KELVIN_DATA.BUCKET.capacitance * 1e12, 'pF');
console.log('Heron SPH Gas Constant:', HERON_DATA.SPH.gasConstant, 'Pa');
console.log('Microvolt Thermal Noise (1Hz):', MICROVOLT_DATA.THERMAL_NOISE.at1Hz_1MOhm * 1e6, 'μV');
console.log('================================================');

// ============================================
// PERFORMANCE PROFILER MODULE
// ============================================
class PerformanceProfiler {
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

// ============================================
// DEBUG PANEL OVERLAY
// ============================================
class DebugPanel {
  constructor(profiler) {
    this.profiler = profiler;
    this.visible = false;
    this.canvas = null;
    this.ctx = null;
    this.animationId = null;
    this.createPanel();
  }
  
  createPanel() {
    // Container
    const container = document.createElement('div');
    container.id = 'debugPanel';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 400px;
      background: rgba(0, 10, 20, 0.95);
      border: 1px solid #0ff;
      border-radius: 8px;
      padding: 15px;
      color: #0ff;
      font-family: 'Segoe UI', monospace;
      font-size: 12px;
      z-index: 1000;
      display: none;
      box-shadow: 0 0 20px rgba(0, 255, 255, 0.3);
      max-height: 80vh;
      overflow-y: auto;
    `;
    
    // Header
    const header = document.createElement('div');
    header.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #0ff; padding-bottom: 10px;">
        <span style="font-weight: bold; font-size: 14px;">🔧 Performance Debug</span>
        <button id="closeDebug" style="background: #111; border: 1px solid #0ff; color: #0ff; cursor: pointer; padding: 4px 8px; border-radius: 4px;">✕</button>
      </div>
    `;
    container.appendChild(header);
    
    // Stats grid
    const statsDiv = document.createElement('div');
    statsDiv.id = 'debugStats';
    statsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 15px;';
    container.appendChild(statsDiv);
    
    // FPS Graph
    const graphContainer = document.createElement('div');
    graphContainer.innerHTML = `
      <div style="margin: 15px 0; font-size: 11px; color: #888;">FPS History (60s)</div>
      <canvas id="fpsGraph" width="370" height="80" style="background: rgba(0,20,40,0.8); border: 1px solid #0ff; border-radius: 4px;"></canvas>
    `;
    container.appendChild(graphContainer);
    
    // Particle vs FPS
    const correlationContainer = document.createElement('div');
    correlationContainer.innerHTML = `
      <div style="margin: 15px 0; font-size: 11px; color: #888;">Particle Count vs FPS</div>
      <canvas id="correlationGraph" width="370" height="80" style="background: rgba(0,20,40,0.8); border: 1px solid #0ff; border-radius: 4px;"></canvas>
    `;
    container.appendChild(correlationContainer);
    
    // Controls
    const controlsDiv = document.createElement('div');
    controlsDiv.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #333;';
    controlsDiv.innerHTML = `
      <div style="margin-bottom: 10px;">
        <label style="display: flex; align-items: center; cursor: pointer;">
          <input type="checkbox" id="autoQualityToggle" checked style="margin-right: 8px;">
          <span>Auto Quality Scaling</span>
        </label>
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: flex; align-items: center; cursor: pointer;">
          <input type="checkbox" id="gpuTimingToggle" style="margin-right: 8px;">
          <span>GPU Timing Queries</span>
        </label>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 15px;">
        <button id="startBenchmark" style="flex: 1; padding: 8px; background: #0ff; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Start Benchmark</button>
        <button id="applyOptimal" style="flex: 1; padding: 8px; background: #111; color: #0ff; border: 1px solid #0ff; border-radius: 4px; cursor: pointer;">Apply Optimal</button>
      </div>
      <div id="benchmarkResults" style="margin-top: 10px; padding: 10px; background: rgba(0,50,50,0.5); border-radius: 4px; display: none; font-size: 11px;"></div>
    `;
    container.appendChild(controlsDiv);
    
    // Scientific Data Section (Wolfram Sources)
    const scientificDiv = document.createElement('div');
    scientificDiv.id = 'scientificData';
    scientificDiv.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #0ff; font-size: 11px;';
    scientificDiv.innerHTML = `
      <div style="color: #0ff; margin-bottom: 8px; font-weight: bold;">📊 Wolfram Scientific Data</div>
      <div id="wolframData" style="max-height: 200px; overflow-y: auto;"></div>
    `;
    container.appendChild(scientificDiv);
    
    // Memory details
    const memoryDiv = document.createElement('div');
    memoryDiv.id = 'memoryDetails';
    memoryDiv.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #333; font-size: 11px;';
    container.appendChild(memoryDiv);
    
    document.body.appendChild(container);
    
    // Get canvas contexts
    this.canvas = document.getElementById('fpsGraph');
    this.ctx = this.canvas.getContext('2d');
    this.correlationCanvas = document.getElementById('correlationGraph');
    this.correlationCtx = this.correlationCanvas.getContext('2d');
    
    // Event listeners
    document.getElementById('closeDebug').addEventListener('click', () => this.hide());
    document.getElementById('autoQualityToggle').addEventListener('change', (e) => {
      this.profiler.autoQualityEnabled = e.target.checked;
    });
    document.getElementById('gpuTimingToggle').addEventListener('change', (e) => {
      this.profiler.timingEnabled = e.target.checked;
    });
    document.getElementById('startBenchmark').addEventListener('click', () => this.startBenchmark());
    document.getElementById('applyOptimal').addEventListener('click', () => this.applyOptimalSettings());
    
    this.panel = container;
  }
  
  show() {
    this.visible = true;
    this.panel.style.display = 'block';
    this.startUpdateLoop();
  }
  
  hide() {
    this.visible = false;
    this.panel.style.display = 'none';
    this.stopUpdateLoop();
  }
  
  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }
  
  startUpdateLoop() {
    const update = () => {
      if (!this.visible) return;
      this.update();
      this.animationId = requestAnimationFrame(update);
    };
    update();
  }
  
  stopUpdateLoop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
  
  update() {
    const stats = this.profiler.getStats();
    
    // Update quality indicator in main UI
    const qualityEl = document.getElementById('qualityLevel');
    if (qualityEl) {
      qualityEl.textContent = (stats.qualityLevel * 100).toFixed(0) + '%';
      const modeDiv = document.getElementById('performanceMode');
      if (modeDiv) {
        const indicator = modeDiv.querySelector('span');
        if (stats.qualityLevel < 0.5) {
          modeDiv.style.background = 'rgba(50,0,0,0.5)';
          if (indicator) indicator.style.color = '#f44';
        } else if (stats.qualityLevel < 0.8) {
          modeDiv.style.background = 'rgba(50,30,0,0.5)';
          if (indicator) indicator.style.color = '#ff4';
        } else {
          modeDiv.style.background = 'rgba(0,50,0,0.5)';
          if (indicator) indicator.style.color = '#4f4';
        }
      }
    }
    
    // Update GPU tier display
    const gpuTierEl = document.getElementById('gpuTierDisplay');
    if (gpuTierEl) {
      gpuTierEl.textContent = stats.gpuTier.toUpperCase();
      gpuTierEl.style.color = stats.gpuTier === 'high' ? '#4f4' : (stats.gpuTier === 'medium' ? '#ff4' : '#f44');
    }
    
    // Update particle count
    const particleEl = document.getElementById('particleCount');
    if (particleEl) {
      const count = Math.floor(parseInt(particleEl.textContent) * stats.qualityLevel);
      particleEl.textContent = (count / 1000).toFixed(1) + 'K';
    }
    
    // Update stats grid
    const statsDiv = document.getElementById('debugStats');
    statsDiv.innerHTML = `
      <div style="color: #888;">Current FPS:</div>
      <div style="color: ${stats.currentFPS < 45 ? '#f44' : (stats.currentFPS < 55 ? '#ff4' : '#4f4')}; font-weight: bold;">${stats.currentFPS.toFixed(1)}</div>
      
      <div style="color: #888;">Average FPS:</div>
      <div style="color: #0ff;">${stats.averageFPS.toFixed(1)}</div>
      
      <div style="color: #888;">Min/Max FPS:</div>
      <div style="color: #0ff;">${stats.minFPS.toFixed(0)} / ${stats.maxFPS.toFixed(0)}</div>
      
      <div style="color: #888;">Quality Level:</div>
      <div style="color: ${stats.qualityLevel < 0.8 ? '#ff4' : '#4f4'};">${(stats.qualityLevel * 100).toFixed(0)}%</div>
      
      <div style="color: #888;">GPU Tier:</div>
      <div style="color: ${stats.gpuTier === 'high' ? '#4f4' : (stats.gpuTier === 'medium' ? '#ff4' : '#f44')}; text-transform: uppercase;">${stats.gpuTier}</div>
      
      <div style="color: #888;">GPU Timing:</div>
      <div style="color: ${stats.timingEnabled ? '#4f4' : '#888'};">${stats.timingEnabled ? 'Enabled' : 'Disabled'}</div>
      
      <div style="color: #888;">Buffer Memory:</div>
      <div style="color: #0ff;">${stats.bufferMemoryMB} MB (${stats.bufferCount} buffers)</div>
      
      <div style="color: #888;">Texture Memory:</div>
      <div style="color: #0ff;">${stats.textureMemoryMB} MB (${stats.textureCount} textures)</div>
    `;
    
    // Draw FPS graph
    this.drawFPSGraph();
    
    // Draw correlation graph
    this.drawCorrelationGraph();
    
    // Update memory details
    this.updateMemoryDetails();
    
    // Update scientific data
    this.updateScientificData();
  }
  
  drawFPSGraph() {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const points = this.profiler.getFPSGraphData(width, height);
    
    ctx.fillStyle = 'rgba(0, 20, 40, 1)';
    ctx.fillRect(0, 0, width, height);
    
    // Grid lines
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (i / 4) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    
    // FPS line
    ctx.strokeStyle = '#0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) ctx.moveTo(p.x, Math.max(0, Math.min(height, p.y)));
      else ctx.lineTo(p.x, Math.max(0, Math.min(height, p.y)));
    }
    ctx.stroke();
    
    // Target FPS line (60fps)
    const targetY = height - (60 / 80) * height;
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(width, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('80 FPS', 4, 12);
    ctx.fillText('40 FPS', 4, height / 2);
    ctx.fillText('0 FPS', 4, height - 4);
  }
  
  drawCorrelationGraph() {
    const ctx = this.correlationCtx;
    const width = this.correlationCanvas.width;
    const height = this.correlationCanvas.height;
    const data = this.profiler.getParticleFPSCorrelation();
    
    ctx.fillStyle = 'rgba(0, 20, 40, 1)';
    ctx.fillRect(0, 0, width, height);
    
    if (data.length === 0) return;
    
    // Find ranges
    const maxParticles = Math.max(...data.map(d => d.particles));
    const maxFPS = 80;
    
    // Draw points
    for (const point of data) {
      const x = (point.particles / maxParticles) * width;
      const y = height - (point.fps / maxFPS) * height;
      
      const intensity = point.fps / 60;
      const r = Math.floor((1 - intensity) * 255);
      const g = Math.floor(intensity * 255);
      
      ctx.fillStyle = `rgba(${r}, ${g}, 100, 0.6)`;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
    
    // Labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('0', 4, height - 4);
    ctx.fillText(maxParticles.toLocaleString(), width - 40, height - 4);
    ctx.fillText('80 FPS', 4, 12);
    ctx.fillText('Part', width / 2 - 15, height - 4);
  }
  
  updateMemoryDetails() {
    const memoryDiv = document.getElementById('memoryDetails');
    const recentBuffers = this.profiler.bufferAllocations.slice(-5);
    const recentTextures = this.profiler.textureAllocations.slice(-5);
    
    let html = '<div style="color: #888; margin-bottom: 8px;">Recent Allocations:</div>';
    
    html += '<div style="color: #0aa;">Buffers:</div>';
    for (const buf of recentBuffers) {
      const size = (buf.size / 1024 / 1024).toFixed(2);
      html += `<div style="margin-left: 8px; color: #888;">${buf.name}: ${size}MB</div>`;
    }
    
    html += '<div style="color: #0aa; margin-top: 8px;">Textures:</div>';
    for (const tex of recentTextures) {
      const size = (tex.size / 1024 / 1024).toFixed(2);
      html += `<div style="margin-left: 8px; color: #888;">${tex.name}: ${tex.width}x${tex.height} (${size}MB)</div>`;
    }
    
    memoryDiv.innerHTML = html;
  }
  
  updateScientificData() {
    const wolframDiv = document.getElementById('wolframData');
    if (!wolframDiv) return;
    
    let html = '';
    
    // SEG Data
    html += '<div style="color: #0ff; margin-top: 8px;">SEG (Magnetic):</div>';
    html += `<div style="margin-left: 8px; color: #888;">B-field @ surface: <span style="color: #0ff">${SEG_DATA.B_FIELD.surface.toFixed(3)} T</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Magnetic moment: <span style="color: #0ff">${(SEG_DATA.MAGNETIC_MOMENT / 1e6).toFixed(2)} MA·m²</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Energy density: <span style="color: #0ff">${(SEG_DATA.ENERGY_DENSITY.surface / 1e6).toFixed(2)} MJ/m³</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Adjacent force: <span style="color: #0ff">${(SEG_DATA.ADJACENT_FORCE / 1e6).toFixed(1)} MN</span></div>`;
    
    // Kelvin Data
    html += '<div style="color: #f0f; margin-top: 8px;">Kelvin (Electrostatic):</div>';
    html += `<div style="margin-left: 8px; color: #888;">Bucket capacitance: <span style="color: #f0f">${(KELVIN_DATA.BUCKET.capacitance * 1e12).toFixed(1)} pF</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Droplet charge: <span style="color: #f0f">${(KELVIN_DATA.DROPLET.charge * 1e9).toFixed(0)} nC</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">V @ 1s: <span style="color: #f0f">${(KELVIN_DATA.VOLTAGE_BUILDUP.at1s / 1e3).toFixed(0)} kV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Spark gap @ 10kV: <span style="color: #f0f">${(KELVIN_DATA.SPARK_GAPS.at10kV * 1e3).toFixed(2)} mm</span></div>`;
    
    // Heron Data
    html += '<div style="color: #08f; margin-top: 8px;">Heron (SPH Fluid):</div>';
    html += `<div style="margin-left: 8px; color: #888;">Smoothing length: <span style="color: #08f">${(HERON_DATA.SPH.smoothingLength * 1e3).toFixed(1)} mm</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Gas constant: <span style="color: #08f">${(HERON_DATA.SPH.gasConstant / 1e3).toFixed(0)} kPa</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Siphon velocity (1m): <span style="color: #08f">${HERON_DATA.SIPHON_VELOCITY.at1m.toFixed(2)} m/s</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Pressure @ 2m: <span style="color: #08f">${(HERON_DATA.PRESSURE.at2m / 1e3).toFixed(1)} kPa</span></div>`;
    
    // Microvolt Data
    html += '<div style="color: #ff4; margin-top: 8px;">Microvolt Precision:</div>';
    html += `<div style="margin-left: 8px; color: #888;">Thermal noise (1Hz): <span style="color: #ff4">${(MICROVOLT_DATA.THERMAL_NOISE.at1Hz_1MOhm * 1e6).toFixed(3)} μV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Single e- on 1pF: <span style="color: #ff4">${(MICROVOLT_DATA.SINGLE_ELECTRON.at1pF * 1e6).toFixed(0)} nV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Min detectable: <span style="color: #ff4">${(MICROVOLT_DATA.SIMULATION.minVoltageStep * 1e6).toFixed(1)} μV</span></div>`;
    
    wolframDiv.innerHTML = html;
  }
  
  startBenchmark() {
    const duration = this.profiler.startBenchmark();
    const resultsDiv = document.getElementById('benchmarkResults');
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = `Benchmark running... ${duration}s remaining`;
    
    // Update countdown
    let remaining = duration;
    const countdown = setInterval(() => {
      remaining--;
      if (remaining > 0 && this.profiler.benchmarkMode) {
        resultsDiv.innerHTML = `Benchmark running... ${remaining}s remaining`;
      } else {
        clearInterval(countdown);
      }
    }, 1000);
    
    // Wait for benchmark to complete
    setTimeout(() => {
      this.showBenchmarkResults();
    }, (duration + 1) * 1000);
  }
  
  showBenchmarkResults() {
    const results = this.profiler.endBenchmark();
    const resultsDiv = document.getElementById('benchmarkResults');
    
    resultsDiv.innerHTML = `
      <div style="color: #0ff; font-weight: bold; margin-bottom: 8px;">Benchmark Complete!</div>
      <div>Duration: ${results.duration.toFixed(1)}s</div>
      <div>Frames: ${results.totalFrames.toLocaleString()}</div>
      <div style="color: #4f4;">Average FPS: ${results.averageFPS.toFixed(1)}</div>
      <div>Min/Max: ${results.minFPS.toFixed(0)} / ${results.maxFPS.toFixed(0)}</div>
      <div>1% Low: ${results.onePercentLow.toFixed(1)} FPS</div>
      <div style="margin-top: 8px; color: ${results.averageFPS > 55 ? '#4f4' : (results.averageFPS > 40 ? '#ff4' : '#f44')};">
        ${results.averageFPS > 55 ? '✓ Excellent performance' : (results.averageFPS > 40 ? '⚠ Acceptable performance' : '✗ Poor performance')}
      </div>
    `;
  }
  
  applyOptimalSettings() {
    const settings = this.profiler.getOptimalSettings();
    
    // Update sliders
    const particleSlider = document.getElementById('particleSlider');
    if (particleSlider) {
      particleSlider.value = settings.particleCount;
      document.getElementById('particleVal').textContent = settings.particleCount.toLocaleString();
    }
    
    // Show confirmation
    alert(`Optimal settings applied for ${this.profiler.gpuTier} GPU:\n` +
          `• Particles: ${settings.particleCount.toLocaleString()}\n` +
          `• Field Lines: ${settings.enableFieldLines ? 'Enabled' : 'Disabled'}\n` +
          `• SPH: ${settings.enableSPH ? 'Enabled' : 'Disabled'}\n` +
          `• Target FPS: ${settings.targetFPS}`);
  }
}

// ============================================
// DEVICE CONFIGURATION
// ============================================
const DEVICE_CONFIG = {
  seg: {
    position: [0, 0, -8],
    rotation: [0, 0, 0, 1],
    cameraOffset: [0, 3, 8],
    particleCount: 10000,
    color: [0.0, 0.9, 1.0],
    core: {
      shaftRadius: 0.5,
      shaftHeight: 6.0,
      coreRadius: 1.2,
      coreHeight: 3.0,
      plateRadius: 3.0,
      plateThickness: 0.3,
      plateY: 2.5,
      boltCount: 24,
      boltRadius: 0.08,
      boltHeight: 0.25,
      baseColor: [0.53, 0.6, 0.67], // Steel gray #8899aa
      coreColor: [0.0, 0.8, 0.9],   // Cyan-tinted NdFeB
      glowColor: [0.0, 0.9, 1.0]    // Magnetic glow
    }
  },
  heron: {
    position: [-7, 0, 4],
    rotation: [0, Math.PI / 6, 0],
    cameraOffset: [0, 4, 8],
    particleCount: 10000,
    color: [0.0, 0.6, 1.0]
  },
  kelvin: {
    position: [7, 0, 4],
    rotation: [0, -Math.PI / 6, 0],
    cameraOffset: [0, 4, 8],
    particleCount: 10000,
    color: [0.8, 0.5, 1.0]
  }
};

// ============================================
// MAIN VISUALIZER
// ============================================
class MultiDeviceVisualizer {
  constructor() {
    console.log('MultiDeviceVisualizer v5 starting - depthStencil fix applied');
    this.canvas = document.getElementById('gpuCanvas');
    this.device = null;
    this.context = null;
    this.profiler = null;
    this.debugPanel = null;
    
    // Camera system
    this.camera = {
      position: [0, 8, 18],
      target: [0, 0, 0],
      fov: 45,
      transitionActive: false,
      transitionStart: null,
      transitionDuration: 1.5,
      startPos: null,
      startTarget: null,
      endPos: null,
      endTarget: null
    };
    
    this.currentView = 'overview';
    this.devicesEnabled = { seg: true, heron: true, kelvin: true };
    this.devices = {};
    this.energyPipes = [];
    
    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    
    this.init();
  }
  
  async init() {
    if (!navigator.gpu) {
      alert("WebGPU not supported. Use Chrome 113+ or Edge 113+.");
      throw new Error("WebGPU not supported");
    }
    
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No adapter");
      
      // Log adapter info for debugging
      console.log('WebGPU Adapter:', adapter.info);
      
      this.device = await adapter.requestDevice({
        requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : []
      });
      
      // Initialize profiler
      this.profiler = new PerformanceProfiler(this.device, this.canvas);
      await this.profiler.init();
      
      // Initialize debug panel
      this.debugPanel = new DebugPanel(this.profiler);
      
      this.context = this.canvas.getContext('webgpu');
      
      this.context.configure({
        device: this.device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });
      
      this.resize();
      await this.setupDepthBuffer();
      
      await this.setupGlobalResources();
      await this.setupDevices();
      await this.setupEnergyPipes();
      await this.setupFloorGrid();
      
      this.setupInteraction();
      
      // Track initial allocations
      this.profiler.trackBuffer('globalUniforms', 256, GPUBufferUsage.UNIFORM);
      
      this.render(0);
      
      window.addEventListener('resize', () => this.resize());
      
      // Show optimal settings hint
      this.showOptimalSettingsHint();
      
    } catch (e) {
      console.error(e);
      alert("Init failed: " + e.message);
    }
  }
  
  showOptimalSettingsHint() {
    const settings = this.profiler.getOptimalSettings();
    console.log('Detected GPU Tier:', this.profiler.gpuTier);
    console.log('Recommended settings:', settings);
    
    // Could show a UI notification here
  }
  
  // ... [Rest of the MultiDeviceVisualizer methods remain the same]
  // Setup methods, camera methods, rendering loop, etc.
  
  async setupGlobalResources() {
    const startTime = performance.now();
    
    // Extended global uniform buffer for professional lighting system
    // Size: 512 bytes to accommodate extended GlobalUniforms struct with lights
    this.globalUniformBuffer = this.device.createBuffer({
      size: 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.profiler.trackBuffer('globalUniforms', 512, GPUBufferUsage.UNIFORM);
    
    // Studio lighting configuration
    this.lightingConfig = {
      key: {
        position: [10, 15, 10],
        color: [1.0, 0.95, 0.9],
        intensity: 1.2,
        size: [2.0, 2.0]
      },
      fill: {
        position: [-8, 10, 5],
        color: [0.7, 0.8, 0.9],
        intensity: 0.6,
        size: [4.0, 4.0]
      },
      rim: {
        position: [0, 8, -12],
        color: [0.9, 0.95, 1.0],
        intensity: 0.8,
        size: [1.0, 3.0]
      },
      ground: {
        position: [0, -5, 0],
        color: [0.3, 0.35, 0.4],
        intensity: 0.3,
        size: [20.0, 20.0]
      }
    };
    
    this.cylinderBuffer = this.createCylinderBuffer(0.8, 2.5, 32);
    
    // Create core geometry buffers for SEG device
    this.setupCoreGeometryBuffers();
    
    // Create pickup coil geometry for SEG device
    this.setupPickupCoilBuffers();
    
    this.setupGlobalShaders();
    this.setupCoilShaders();
    
    console.log(`Global resources setup in ${(performance.now() - startTime).toFixed(2)}ms`);
  }
  
  setupPickupCoilBuffers() {
    // Create rectangular coil bobbin geometry
    // Dimensions: width 0.8m, depth 0.4m, height 4m
    this.coilBuffer = this.createCoilBuffer();
    
    // Create connection rings (top and bottom) - torus at radius 7.0m
    this.connectionRingBuffer = this.createTorusBuffer(7.0, 0.15, 48, 16);
  }
  
  createCoilBuffer() {
    const w = 0.4;  // half-width
    const d = 0.2;  // half-depth
    const h = 2.0;  // half-height
    
    // Interleaved vertex data: pos(3) + normal(3) + uv(2) = 8 floats per vertex = 32 bytes
    const vertexData = [];
    
    // Helper to add a face (2 triangles)
    const addFace = (v1, v2, v3, v4, n, uvBase) => {
      // Triangle 1: v1, v2, v3
      // Vertex 1
      vertexData.push(...v1, ...n, uvBase[0], uvBase[1]);
      // Vertex 2
      vertexData.push(...v2, ...n, uvBase[2], uvBase[1]);
      // Vertex 3
      vertexData.push(...v3, ...n, uvBase[0], uvBase[3]);
      
      // Triangle 2: v3, v2, v4
      // Vertex 3 (again)
      vertexData.push(...v3, ...n, uvBase[0], uvBase[3]);
      // Vertex 2 (again)
      vertexData.push(...v2, ...n, uvBase[2], uvBase[1]);
      // Vertex 4
      vertexData.push(...v4, ...n, uvBase[2], uvBase[3]);
    };
    
    // Front face (+Z) - outward facing
    addFace(
      [-w, -h, d], [w, -h, d], [-w, h, d], [w, h, d],
      [0, 0, 1], [0, 0, 1, 1]
    );
    // Back face (-Z) - inward facing
    addFace(
      [w, -h, -d], [-w, -h, -d], [w, h, -d], [-w, h, -d],
      [0, 0, -1], [0, 0, 1, 1]
    );
    // Right face (+X)
    addFace(
      [w, -h, d], [w, -h, -d], [w, h, d], [w, h, -d],
      [1, 0, 0], [0, 0, 1, 1]
    );
    // Left face (-X)
    addFace(
      [-w, -h, -d], [-w, -h, d], [-w, h, -d], [-w, h, d],
      [-1, 0, 0], [0, 0, 1, 1]
    );
    // Top face (+Y)
    addFace(
      [-w, h, d], [w, h, d], [-w, h, -d], [w, h, -d],
      [0, 1, 0], [0, 0, 1, 1]
    );
    // Bottom face (-Y)
    addFace(
      [-w, -h, -d], [w, -h, -d], [-w, -h, d], [w, -h, d],
      [0, -1, 0], [0, 0, 1, 1]
    );
    
    const vertexArray = new Float32Array(vertexData);
    
    const vertexBuffer = this.device.createBuffer({
      size: vertexArray.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    
    this.device.queue.writeBuffer(vertexBuffer, 0, vertexArray);
    this.profiler.trackBuffer('coilVertices', vertexBuffer.size, GPUBufferUsage.VERTEX);
    
    return {
      vertexBuffer,
      vertexCount: vertexData.length / 8  // 8 floats per vertex
    };
  }
  
  createTorusBuffer(majorRadius, minorRadius, majorSegments, minorSegments) {
    const vertices = [];
    const normals = [];
    const indices = [];
    
    for (let i = 0; i <= majorSegments; i++) {
      const theta = (i / majorSegments) * Math.PI * 2;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);
      
      for (let j = 0; j <= minorSegments; j++) {
        const phi = (j / minorSegments) * Math.PI * 2;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);
        
        const x = (majorRadius + minorRadius * cosPhi) * cosTheta;
        const y = minorRadius * sinPhi;
        const z = (majorRadius + minorRadius * cosPhi) * sinTheta;
        
        const nx = cosPhi * cosTheta;
        const ny = sinPhi;
        const nz = cosPhi * sinTheta;
        
        // Interleaved: position(3) + normal(3) = 6 floats per vertex = 24 bytes
        vertices.push(x, y, z, nx, ny, nz);
      }
    }
    
    for (let i = 0; i < majorSegments; i++) {
      for (let j = 0; j < minorSegments; j++) {
        const a = i * (minorSegments + 1) + j;
        const b = a + minorSegments + 1;
        
        indices.push(a, b, a + 1);
        indices.push(b, b + 1, a + 1);
      }
    }
    
    const vertexData = new Float32Array(vertices);
    
    const vertexBuffer = this.device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    
    this.device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    
    const indexBuffer = this.device.createBuffer({
      size: new Uint16Array(indices).byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(indexBuffer, 0, new Uint16Array(indices));
    
    this.profiler.trackBuffer('torusVertices', vertexBuffer.size, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('torusIndices', indexBuffer.size, GPUBufferUsage.INDEX);
    
    return {
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length
    };
  }
  
  setupCoreGeometryBuffers() {
    const segConfig = DEVICE_CONFIG.seg;
    if (!segConfig.core) return;
    
    const core = segConfig.core;
    
    // Central shaft cylinder (radius 0.5, height 6)
    this.coreShaftBuffer = this.createCylinderBuffer(core.shaftRadius, core.shaftHeight, 24);
    
    // Magnetic core cylinder (radius 1.2, height 3)
    this.coreMagnetBuffer = this.createCylinderBuffer(core.coreRadius, core.coreHeight, 32);
    
    // Top and bottom plates (radius 3, thickness 0.3)
    this.corePlateBuffer = this.createCylinderBuffer(core.plateRadius, core.plateThickness, 48);
    
    // Bolt cylinders (small, instanced)
    this.coreBoltBuffer = this.createCylinderBuffer(core.boltRadius, core.boltHeight, 8);
    
    // Bolt instance positions (24 bolts per plate, arranged in circle)
    const boltPositions = [];
    const boltRadius = core.plateRadius * 0.85; // Position at 85% of plate radius
    for (let i = 0; i < core.boltCount; i++) {
      const angle = (i / core.boltCount) * Math.PI * 2;
      boltPositions.push(
        Math.cos(angle) * boltRadius,
        core.plateY + core.plateThickness / 2 + core.boltHeight / 2,
        Math.sin(angle) * boltRadius
      );
      boltPositions.push(
        Math.cos(angle) * boltRadius,
        -(core.plateY + core.plateThickness / 2 + core.boltHeight / 2),
        Math.sin(angle) * boltRadius
      );
    }
    this.coreBoltPositions = new Float32Array(boltPositions);
    
    this.coreBoltInstanceBuffer = this.device.createBuffer({
      size: this.coreBoltPositions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coreBoltInstanceBuffer, 0, this.coreBoltPositions);
    this.profiler.trackBuffer('coreBoltInstances', this.coreBoltPositions.byteLength, GPUBufferUsage.VERTEX);
  }
  
  createCylinderBuffer(radius, height, segments) {
    const vertices = [], indices = [], normals = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      vertices.push(x, height/2, z); normals.push(0, 1, 0);
      vertices.push(x, -height/2, z); normals.push(0, -1, 0);
      vertices.push(x, height/2, z); normals.push(Math.cos(theta), 0, Math.sin(theta));
      vertices.push(x, -height/2, z); normals.push(Math.cos(theta), 0, Math.sin(theta));
    }
    for (let i = 0; i < segments; i++) {
      const base = i * 4, next = ((i + 1) % (segments + 1)) * 4;
      indices.push(base, next, base + 2, base + 2, next, next + 2);
      indices.push(base + 1, base + 3, next + 1, next + 1, base + 3, next + 3);
      indices.push(base + 2, next + 2, base + 3, base + 3, next + 2, next + 3);
    }
    const vertexData = new Float32Array(vertices.length / 3 * 6);
    for (let i = 0; i < vertices.length / 3; i++) {
      vertexData[i * 6] = vertices[i * 3];
      vertexData[i * 6 + 1] = vertices[i * 3 + 1];
      vertexData[i * 6 + 2] = vertices[i * 3 + 2];
      vertexData[i * 6 + 3] = normals[i * 3];
      vertexData[i * 6 + 4] = normals[i * 3 + 1];
      vertexData[i * 6 + 5] = normals[i * 3 + 2];
    }
    
    const vertexBuffer = this.device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    this.profiler.trackBuffer('cylinderVertices', vertexData.byteLength, GPUBufferUsage.VERTEX);
    
    const indexBuffer = this.device.createBuffer({
      size: new Uint16Array(indices).byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(indexBuffer, 0, new Uint16Array(indices));
    this.profiler.trackBuffer('cylinderIndices', new Uint16Array(indices).byteLength, GPUBufferUsage.INDEX);
    
    return {
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length
    };
  }
  
  setupCoilShaders() {
    // Pickup coil vertex shader
    this.coilVertShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - IBL + Area Lights
// ============================================

// Spherical harmonics coefficients for ambient lighting
const SH_COEFFS_0: vec3f = vec3f(0.2, 0.25, 0.3);    // Ambient
const SH_COEFFS_1: vec3f = vec3f(0.1, 0.12, 0.15);   // Directional X
const SH_COEFFS_2: vec3f = vec3f(0.15, 0.18, 0.2);   // Directional Y
const SH_COEFFS_3: vec3f = vec3f(0.3, 0.35, 0.4);    // Directional Z (sky)

fn evaluateSH(normal: vec3f) -> vec3f {
  return SH_COEFFS_0 
       + SH_COEFFS_1 * normal.x
       + SH_COEFFS_2 * normal.y
       + SH_COEFFS_3 * normal.z;
}

// Specular reflection approximation (IBL)
fn approximateSpecularIBL(viewDir: vec3f, normal: vec3f, roughness: f32) -> vec3f {
  let R = reflect(-viewDir, normal);
  let envColor = vec3f(0.5, 0.6, 0.7) * (1.0 - roughness * 0.5);
  return envColor * (1.0 - roughness);
}

// Extended GlobalUniforms with lighting data
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
// Coil data packed as: position(3), rotation(4), energy(1) - using 8 floats, last is energy
@binding(2) @group(0) var<storage> coils: array<vec4f>;
struct VertexOutput { 
  @builtin(position) position: vec4f, 
  @location(0) normal: vec3f, 
  @location(1) worldPos: vec3f, 
  @location(2) energy: f32,
  @location(3) coilIndex: f32,
  @location(4) uv: vec2f
}
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { 
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); 
}
@vertex fn main(
  @location(0) position: vec3f, 
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
  var output: VertexOutput;
  
  // Read coil data from storage buffer
  // coils[instanceIdx * 2] = vec4f(position.xyz, rotation.x)
  // coils[instanceIdx * 2 + 1] = vec4f(rotation.yzw, energy)
  let data0 = coils[instanceIdx * 2];
  let data1 = coils[instanceIdx * 2 + 1];
  
  let coilPos = data0.xyz;
  let coilRot = vec4f(data0.w, data1.xyz);
  let coilEnergy = data1.w;
  
  // Rotate coil to face center, then apply device rotation
  let localPos = quatRotate(coilRot, position) + coilPos;
  let worldPos = quatRotate(device.deviceRot, localPos * device.deviceScale) + device.devicePos;
  
  output.position = globals.viewProj * vec4f(worldPos, 1.0);
  output.normal = quatRotate(device.deviceRot, quatRotate(coilRot, normal));
  output.worldPos = worldPos;
  output.energy = coilEnergy;
  output.coilIndex = f32(instanceIdx);
  output.uv = uv;
  return output;
}`;

    // Pickup coil fragment shader with copper material and energy glow
    this.coilFragShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct CoilMaterialUniforms { 
  copperColor: vec3f, 
  _pad1: f32, 
  glowColor: vec3f, 
  emission: f32 
}
@binding(3) @group(0) var<uniform> material: CoilMaterialUniforms;

// ============================================
// PROFESSIONAL LIGHTING FUNCTIONS - Coil Material
// ============================================

// Spherical harmonics for IBL
const COIL_SH_0: vec3f = vec3f(0.15, 0.12, 0.10);    // Warm ambient for copper
const COIL_SH_1: vec3f = vec3f(0.08, 0.06, 0.05);   // Directional X
const COIL_SH_2: vec3f = vec3f(0.10, 0.08, 0.07);   // Directional Y
const COIL_SH_3: vec3f = vec3f(0.20, 0.18, 0.15);   // Directional Z

fn evaluateCoilSH(normal: vec3f) -> vec3f {
  return COIL_SH_0 + COIL_SH_1 * normal.x + COIL_SH_2 * normal.y + COIL_SH_3 * normal.z;
}

// Area light with soft shadows for copper
fn coilAreaLight(lightPos: vec3f, lightColor: vec3f, intensity: f32,
                 normal: vec3f, worldPos: vec3f, viewDir: vec3f) -> vec3f {
  let lightDir = normalize(lightPos - worldPos);
  let dist = length(lightPos - worldPos);
  let distAtten = 1.0 / (1.0 + dist * 0.08 + dist * dist * 0.003);
  
  // Soft area light sampling (4 samples)
  var NdotL_accum = 0.0;
  var specAccum = 0.0;
  
  for (var i = 0; i < 4; i = i + 1) {
    let offset = vec3f(
      (f32(i % 2) - 0.5) * 1.5,
      (f32(i / 2) - 0.5) * 1.5,
      0.0
    );
    let sampleDir = normalize(lightPos + offset - worldPos);
    let NdotL = max(dot(normal, sampleDir), 0.0);
    NdotL_accum += NdotL;
    
    // Copper-specific specular (softer, warmer)
    let halfDir = normalize(viewDir + sampleDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    specAccum += pow(NdotH, 24.0);
  }
  
  return lightColor * intensity * distAtten * (NdotL_accum / 4.0 + specAccum / 4.0 * 0.4);
}

// ============================================
// PROCEDURAL SURFACE DETAIL FOR COILS (COPPER)
// ============================================

// 3D Hash function
fn coilHash3(p: vec3f) -> vec3f {
  let q = vec3f(dot(p, vec3f(127.1, 311.7, 74.7)),
                dot(p, vec3f(269.5, 183.3, 246.1)),
                dot(p, vec3f(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453);
}

// 3D Value noise
fn coilValueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let n = i.x + i.y * 157.0 + 113.0 * i.z;
  return mix(mix(mix(coilHash3(vec3f(n + 0.0)).x, coilHash3(vec3f(n + 1.0)).x, f.x),
                 mix(coilHash3(vec3f(n + 157.0)).x, coilHash3(vec3f(n + 158.0)).x, f.x), f.y),
             mix(mix(coilHash3(vec3f(n + 113.0)).x, coilHash3(vec3f(n + 114.0)).x, f.x),
                 mix(coilHash3(vec3f(n + 270.0)).x, coilHash3(vec3f(n + 271.0)).x, f.x), f.y), f.z);
}

// FBM for copper detail
fn coilFbm(p: vec3f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  for (var i = 0; i < octaves; i = i + 1) {
    value += amplitude * coilValueNoise(p * frequency);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return value;
}

// Normal perturbation for copper
fn coilPerturbNormal(N: vec3f, worldPos: vec3f, strength: f32) -> vec3f {
  let noise1 = coilFbm(worldPos * 200.0, 3);
  let noise2 = coilFbm(worldPos * 150.0 + 100.0, 3);
  let noise3 = coilFbm(worldPos * 180.0 + 200.0, 3);
  let perturb = vec3f(noise1 - 0.5, noise2 - 0.5, noise3 - 0.5) * strength;
  return normalize(N + perturb);
}

// 2D noise functions for UV-based patterns (legacy)
fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash(i);
  let b = hash(i + vec2f(1.0, 0.0));
  let c = hash(i + vec2f(0.0, 1.0));
  let d = hash(i + vec2f(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@fragment fn main(
  @location(0) normal: vec3f, 
  @location(1) worldPos: vec3f, 
  @location(2) energy: f32,
  @location(3) coilIndex: f32,
  @location(4) uv: vec2f
) -> @location(0) vec4f {
  // ============================================
  // SURFACE DETAIL LAYERS FOR PICKUP COILS (COPPER)
  // ============================================
  
  // Layer 1: Winding pattern - normal map effect using sine waves
  let windingFreqX = 50.0;
  let windingPattern = sin(uv.x * windingFreqX) * 0.5 + 0.5;
  let windingBump = sin(uv.x * windingFreqX) * 0.025;
  
  // Layer 2: Oxidation - greenish tint (verdigris) in crevices
  let oxidationMask = 1.0 - windingPattern;
  let oxidationGreen = vec3f(0.4, 0.6, 0.3);
  let oxidationAmount = oxidationMask * 0.2;
  
  // Layer 3: Scratch marks from winding process
  let scratchNoise = coilFbm(worldPos * 300.0 + vec3f(coilIndex * 10.0), 3);
  let scratches = smoothstep(0.6, 0.8, scratchNoise);
  let scratchBrightness = 1.0 + scratches * 0.12;
  
  // Layer 4: Copper variation using 3D noise
  let copperNoise3D = coilFbm(worldPos * 80.0, 3) * 0.15 + 0.92;
  
  // Layer 5: Coil edge wear (darker at top and bottom of coil)
  let edgeY = abs(uv.y - 0.5) * 2.0;
  let edgeDarkening = 1.0 - smoothstep(0.7, 1.0, edgeY) * 0.12;
  
  // Apply perturbed normal with winding pattern
  let perturbedPos = worldPos + vec3f(windingBump, 0.0, 0.0);
  let n = coilPerturbNormal(normalize(normal), perturbedPos, 0.02);
  let viewDir = normalize(globals.cameraPos - worldPos);
  
  // Base copper color with winding variation, oxidation, scratches, and edge wear
  let rawCopper = material.copperColor * (0.75 + windingPattern * 0.25) * copperNoise3D * scratchBrightness * edgeDarkening;
  
  // Add oxidation tint in crevices
  let baseCopper = mix(rawCopper, rawCopper * 0.75 + oxidationGreen * 0.25, oxidationAmount);
  
  // Professional area light lighting
  let keyLight = coilAreaLight(globals.keyLightPos, globals.keyLightColor, globals.keyLightIntensity, n, worldPos, viewDir);
  let fillLight = coilAreaLight(globals.fillLightPos, globals.fillLightColor, globals.fillLightIntensity * 0.5, n, worldPos, viewDir);
  let rimFresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  let rimLight = globals.rimLightColor * globals.rimLightIntensity * rimFresnel;
  
  // IBL ambient for copper
  let ambientIBL = evaluateCoilSH(n) * 0.8;
  
  // Combined lighting
  let litCopper = baseCopper * (ambientIBL + keyLight + fillLight + rimLight);
  
  // Specular highlight for metallic sheen (additive) - affected by winding pattern
  let halfDir = normalize(viewDir + normalize(globals.keyLightPos - worldPos));
  let specAngle = max(dot(n, halfDir), 0.0);
  let specularPower = 32.0 - windingPattern * 8.0;
  let specular = pow(specAngle, specularPower) * (0.5 + windingPattern * 0.15) * globals.keyLightIntensity;
  
  // Fresnel effect for metallic rim lighting
  let fresnel = pow(1.0 - abs(dot(n, viewDir)), 3.0);
  
  // Energy glow effect - time-based wave propagation
  let wavePhase = globals.time * 3.0 + coilIndex * 0.26;
  let waveGlow = sin(wavePhase) * 0.5 + 0.5;
  let energyPulse = energy * (0.7 + waveGlow * 0.3);
  
  // Glow color with energy level
  let glow = material.glowColor * energyPulse * material.emission;
  
  // Energy arcs between windings (vertical lines)
  let arcPattern = sin(uv.y * 40.0 + globals.time * 5.0) * 0.5 + 0.5;
  let arcGlow = material.glowColor * arcPattern * energyPulse * 0.5 * fresnel;
  
  // Combine all effects with professional lighting
  let finalColor = litCopper + vec3f(specular) + glow + arcGlow;
  
  // Add energy bloom when coil is highly energized
  let bloom = material.glowColor * pow(energyPulse, 2.0) * 0.3;
  
  var finalColorPP = finalColor + bloom;
  
  // === POST-PROCESSING PIPELINE ===
  
  // 1. ACES Filmic Tone Mapping
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  finalColorPP = clamp((finalColorPP * (a * finalColorPP + b)) / (finalColorPP * (c * finalColorPP + d) + e), vec3f(0.0), vec3f(1.0));
  
  // 2. Color Grading - Contrast
  finalColorPP = (finalColorPP - 0.5) * 1.15 + 0.5;
  
  // 3. Color Grading - Saturation boost
  let luma = dot(finalColorPP, vec3f(0.299, 0.587, 0.114));
  finalColorPP = mix(vec3f(luma), finalColorPP, 1.1);
  
  // 4. Color tint - Cool shadows, warm highlights
  let shadows = smoothstep(0.0, 0.3, luma);
  let highlights = smoothstep(0.7, 1.0, luma);
  let shadowTint = vec3f(0.9, 0.95, 1.0);
  let highlightTint = vec3f(1.05, 1.02, 0.98);
  finalColorPP = mix(finalColorPP * shadowTint, finalColorPP, shadows);
  finalColorPP = mix(finalColorPP, finalColorPP * highlightTint, highlights);
  
  // 5. HDR Glow boost
  let hdrGlow = bloom * 0.5;
  finalColorPP = finalColorPP + hdrGlow;
  
  return vec4f(finalColorPP, 1.0);
}`;

    // Connection ring vertex shader
    this.ringVertShader = `
struct GlobalUniforms { viewProj: mat4x4f, time: f32, _pad: vec3f }
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct VertexOutput { 
  @builtin(position) position: vec4f, 
  @location(0) normal: vec3f, 
  @location(1) worldPos: vec3f,
  @location(2) ringPos: vec3f
}
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { 
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); 
}
@vertex fn main(
  @location(0) position: vec3f, 
  @location(1) normal: vec3f
) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = quatRotate(device.deviceRot, position * device.deviceScale) + device.devicePos;
  output.position = globals.viewProj * vec4f(worldPos, 1.0);
  output.normal = quatRotate(device.deviceRot, normal);
  output.worldPos = worldPos;
  output.ringPos = position;
  return output;
}`;

    // Connection ring fragment shader with energy pulse
    this.ringFragShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Ring Material
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct RingMaterialUniforms { 
  ringColor: vec3f, 
  _pad1: f32, 
  pulseColor: vec3f, 
  pulseSpeed: f32 
}
@binding(3) @group(0) var<uniform> material: RingMaterialUniforms;

// Ring SH (cool metallic)
const RING_SH_0: vec3f = vec3f(0.15, 0.18, 0.22);
const RING_SH_1: vec3f = vec3f(0.08, 0.10, 0.12);
const RING_SH_2: vec3f = vec3f(0.12, 0.15, 0.18);
const RING_SH_3: vec3f = vec3f(0.22, 0.28, 0.35);

fn evaluateRingSH(normal: vec3f) -> vec3f {
  return RING_SH_0 + RING_SH_1 * normal.x + RING_SH_2 * normal.y + RING_SH_3 * normal.z;
}

@fragment fn main(
  @location(0) normal: vec3f, 
  @location(1) worldPos: vec3f,
  @location(2) ringPos: vec3f
) -> @location(0) vec4f {
  let n = normalize(normal);
  let viewDir = normalize(globals.cameraPos - worldPos);
  
  // Calculate angle around the ring for pulse effect
  let angle = atan2(ringPos.z, ringPos.x);
  
  // Multiple energy pulses traveling around the ring
  let pulse1 = sin(angle * 3.0 + globals.time * material.pulseSpeed) * 0.5 + 0.5;
  let pulse2 = sin(angle * 3.0 + globals.time * material.pulseSpeed * 1.5 + 2.0) * 0.5 + 0.5;
  let combinedPulse = max(pulse1, pulse2 * 0.7);
  
  // Fresnel for metallic effect
  let fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  
  // IBL ambient
  let ambient = evaluateRingSH(n) * 0.6;
  
  // Key light specular
  let keyDir = normalize(globals.keyLightPos - worldPos);
  let halfDir = normalize(viewDir + keyDir);
  let specAngle = max(dot(n, halfDir), 0.0);
  let specular = pow(specAngle, 32.0) * 0.5 * globals.keyLightIntensity;
  
  // Rim light from globals
  let rimLight = globals.rimLightColor * globals.rimLightIntensity * fresnel;
  
  // Base ring color with pulse
  let baseColor = mix(material.ringColor, material.pulseColor, combinedPulse * 0.8);
  let pulseGlow = material.pulseColor * pow(combinedPulse, 2.0) * 2.0;
  
  // Professional lighting combination
  let litColor = baseColor * (ambient + globals.keyLightColor * globals.keyLightIntensity * 0.4) + 
                 rimLight + specular + pulseGlow;
  
  var finalColor = litColor;
  
  // === CINEMATIC POST-PROCESSING PIPELINE ===
  
  // 1. ACES Filmic Tone Mapping
  let acesA = 2.51;
  let acesB = 0.03;
  let acesC = 2.43;
  let acesD = 0.59;
  let acesE = 0.14;
  finalColor = clamp((finalColor * (acesA * finalColor + acesB)) / (finalColor * (acesC * finalColor + acesD) + acesE), vec3f(0.0), vec3f(1.0));
  
  // 2. Color Grading - Contrast (cinematic)
  finalColor = (finalColor - 0.5) * 1.18 + 0.5;
  
  // 3. Color Grading - Saturation
  let luma = dot(finalColor, vec3f(0.299, 0.587, 0.114));
  finalColor = mix(vec3f(luma), finalColor, 1.1);
  
  // 4. Color tint - Cool shadows, warm highlights
  let shadows = smoothstep(0.0, 0.3, luma);
  let highlights = smoothstep(0.7, 1.0, luma);
  let shadowTint = vec3f(0.92, 0.96, 1.0);
  let highlightTint = vec3f(1.04, 1.02, 0.98);
  finalColor = mix(finalColor * shadowTint, finalColor, shadows);
  finalColor = mix(finalColor, finalColor * highlightTint, highlights);
  
  // 5. Energy pulse HDR boost
  let hdrGlow = glow * combinedPulse * 0.25;
  finalColor = finalColor + hdrGlow;
  
  return vec4f(finalColor, 1.0);
}`;
  }

  setupGlobalShaders() {
    // Use scientific constants from Wolfram data
    const scientificHeader = `
      // Physical Constants (Wolfram verified)
      const PI: f32 = 3.14159265359;
      const MU_0: f32 = ${PHYSICAL_CONSTANTS.MU_0.toExponential(10)};
      const EPSILON_0: f32 = ${PHYSICAL_CONSTANTS.EPSILON_0.toExponential(10)};
      const K_B: f32 = ${PHYSICAL_CONSTANTS.K_B.toExponential(10)};
      const E_CHARGE: f32 = ${PHYSICAL_CONSTANTS.E_CHARGE.toExponential(10)};
      const G: f32 = ${PHYSICAL_CONSTANTS.G};
      
      // SEG Magnetic Constants
      const SEG_BR: f32 = ${SEG_DATA.MAGNET.Br};
      const SEG_RING_RADIUS: f32 = ${SEG_DATA.CONFIG.ringRadius};
      const SEG_NUM_ROLLERS: i32 = ${SEG_DATA.CONFIG.numRollers};
      const SEG_MAGNETIC_MOMENT: f32 = ${SEG_DATA.MAGNETIC_MOMENT.toExponential(4)};
      const SEG_B_SURFACE: f32 = ${SEG_DATA.B_FIELD.surface};
      
      // Kelvin Electrostatic Constants
      const KELVIN_BUCKET_CAP: f32 = ${KELVIN_DATA.BUCKET.capacitance.toExponential(4)};
      const KELVIN_DROPLET_CHARGE: f32 = ${KELVIN_DATA.DROPLET.charge.toExponential(4)};
      const KELVIN_E_BREAKDOWN: f32 = ${KELVIN_DATA.BREAKDOWN.fieldStrength.toExponential(4)};
      
      // Heron SPH Constants
      const HERON_RHO_0: f32 = ${HERON_DATA.SPH.restDensity};
      const HERON_GAS_CONST: f32 = ${HERON_DATA.SPH.gasConstant.toExponential(4)};
      const HERON_GAMMA: f32 = ${HERON_DATA.SPH.gamma};
      const HERON_SMOOTHING_LENGTH: f32 = ${HERON_DATA.SPH.smoothingLength};
    `;
    
    // Shader code (abbreviated for brevity)
    this.rollerVertShader = scientificHeader + `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - IBL + Area Lights
// ============================================

// Spherical harmonics coefficients for ambient lighting
const SH_COEFFS_0: vec3f = vec3f(0.2, 0.25, 0.3);    // Ambient
const SH_COEFFS_1: vec3f = vec3f(0.1, 0.12, 0.15);   // Directional X
const SH_COEFFS_2: vec3f = vec3f(0.15, 0.18, 0.2);   // Directional Y
const SH_COEFFS_3: vec3f = vec3f(0.3, 0.35, 0.4);    // Directional Z (sky)

fn evaluateSH(normal: vec3f) -> vec3f {
  return SH_COEFFS_0 
       + SH_COEFFS_1 * normal.x
       + SH_COEFFS_2 * normal.y
       + SH_COEFFS_3 * normal.z;
}

// Specular reflection approximation (IBL)
fn approximateSpecularIBL(viewDir: vec3f, normal: vec3f, roughness: f32) -> vec3f {
  let R = reflect(-viewDir, normal);
  let envColor = vec3f(0.5, 0.6, 0.7) * (1.0 - roughness * 0.5);
  return envColor * (1.0 - roughness);
}

// Extended GlobalUniforms with lighting data
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct InstanceData { position: vec3f, ringIndex: f32, rotation: vec4f }
@binding(2) @group(0) var<storage> instances: array<InstanceData>;
struct VertexOutput { @builtin(position) position: vec4f, @location(0) normal: vec3f, @location(1) worldPos: vec3f, @location(2) instanceId: f32 }
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
@vertex fn main(@location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
  var output: VertexOutput;
  let inst = instances[instanceIdx];
  
  // Ring-specific scale: inner=0.6, middle=0.8, outer=1.0
  var ringScale: f32 = 1.0;
  if (inst.ringIndex < 0.5) {
    ringScale = 0.6;  // Inner ring
  } else if (inst.ringIndex < 1.5) {
    ringScale = 0.8;  // Middle ring
  } else {
    ringScale = 1.0;  // Outer ring
  }
  
  let localPos = quatRotate(inst.rotation, position * device.deviceScale * ringScale) + inst.position;
  let worldPos = quatRotate(device.deviceRot, localPos) + device.devicePos;
  output.position = globals.viewProj * vec4f(worldPos, 1.0);
  output.normal = quatRotate(device.deviceRot, quatRotate(inst.rotation, normal));
  output.worldPos = worldPos;
  output.instanceId = inst.ringIndex;  // Pass ring index for color
  return output;
}`;

        this.rollerFragShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - PBR + IBL + Area Lights
// ============================================
const PI: f32 = 3.14159265359;

// Spherical harmonics coefficients for Image-Based Lighting
const SH_COEFFS_0: vec3f = vec3f(0.25, 0.28, 0.32);    // Ambient base
const SH_COEFFS_1: vec3f = vec3f(0.12, 0.14, 0.16);   // Directional X
const SH_COEFFS_2: vec3f = vec3f(0.18, 0.20, 0.22);   // Directional Y  
const SH_COEFFS_3: vec3f = vec3f(0.35, 0.40, 0.45);   // Directional Z (sky)

// Evaluate spherical harmonics for ambient lighting
fn evaluateSH(normal: vec3f) -> vec3f {
  return SH_COEFFS_0 
       + SH_COEFFS_1 * normal.x
       + SH_COEFFS_2 * normal.y
       + SH_COEFFS_3 * normal.z;
}

// Area light with soft shadows approximation
fn rectLight(lightPos: vec3f, lightSize: vec2f, lightColor: vec3f, intensity: f32, 
             normal: vec3f, worldPos: vec3f, viewDir: vec3f, roughness: f32) -> vec3f {
  let lightDir = normalize(lightPos - worldPos);
  let dist = length(lightPos - worldPos);
  let distAtten = 1.0 / (1.0 + dist * 0.05 + dist * dist * 0.005);
  
  // Multi-sample area light for soft shadows
  var NdotL_accum = 0.0;
  var specularAccum = 0.0;
  
  let right = normalize(cross(lightDir, vec3f(0.0, 1.0, 0.0)));
  let up = normalize(cross(right, lightDir));
  
  for (var i = 0; i < 4; i = i + 1) {
    let u = (f32(i % 2) - 0.5) * lightSize.x;
    let v = (f32(i / 2) - 0.5) * lightSize.y;
    let sampleOffset = right * u + up * v;
    let sampleDir = normalize(lightPos + sampleOffset - worldPos);
    
    let NdotL = max(dot(normal, sampleDir), 0.0);
    NdotL_accum += NdotL;
    
    // Specular per sample
    let halfDir = normalize(viewDir + sampleDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    specularAccum += pow(NdotH, 64.0 / max(roughness, 0.01));
  }
  
  let diffuse = NdotL_accum / 4.0;
  let specular = specularAccum / 4.0;
  
  return lightColor * intensity * distAtten * (diffuse + specular * 0.3);
}

// Enhanced ambient occlusion with contact shadows
fn enhancedAO(worldPos: vec3f, normal: vec3f) -> f32 {
  // Edge darkening
  let yPos = worldPos.y;
  let edgeFactor = 1.0 - smoothstep(0.85, 1.2, abs(yPos));
  
  // Surface proximity AO (contact shadows)
  let distFromCenter = length(worldPos.xz);
  let contactAO = mix(0.6, 1.0, smoothstep(2.0, 4.0, distFromCenter));
  
  // Cavity occlusion from surface noise
  let cavity = 0.92 + 0.16 * noise(worldPos * 4.0);
  
  return clamp(edgeFactor * contactAO * cavity, 0.4, 1.0);
}

// Professional studio lighting setup
fn calculateStudioLighting(normal: vec3f, viewDir: vec3f, tangent: vec3f,
                           albedo: vec3f, metallic: f32, roughness: f32,
                           worldPos: vec3f, ringColor: vec3f) -> vec3f {
  // IBL Ambient from spherical harmonics
  let ambientIBL = evaluateSH(normal) * 0.6;
  
  // Area lights with soft shadows
  let keyLight = rectLight(
    globals.keyLightPos, vec2f(2.0, 2.0), globals.keyLightColor,
    globals.keyLightIntensity, normal, worldPos, viewDir, roughness
  );
  
  let fillLight = rectLight(
    globals.fillLightPos, vec2f(4.0, 4.0), globals.fillLightColor,
    globals.fillLightIntensity * 0.7, normal, worldPos, viewDir, roughness
  );
  
  // Rim lighting
  let rimFresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);
  let rimLight = globals.rimLightColor * globals.rimLightIntensity * rimFresnel;
  
  // Ground bounce
  let groundNdotL = max(dot(normal, vec3f(0.0, -1.0, 0.0)), 0.0);
  let groundLight = globals.groundLightColor * globals.groundLightIntensity * groundNdotL * 0.25;
  
  // Anisotropic highlight for brushed metal
  let keyDir = normalize(globals.keyLightPos - worldPos);
  let aniso = anisotropicSpecular(viewDir, keyDir, normal, tangent, roughness);
  
  // Combine lighting
  var totalLight = ambientIBL + keyLight + fillLight + groundLight + rimLight;
  totalLight += ringColor * aniso * metallic * 0.2;
  
  return totalLight * albedo;
}

// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;

// Extended PBR material uniforms
struct MaterialUniforms { 
  albedo: vec3f,        // Base color
  metallic: f32,        // 0 = dielectric, 1 = metal
  roughness: f32,       // Surface roughness 0-1
  ao: f32,              // Ambient occlusion
  emission: f32,        // Emission strength
  ringIndex: f32,       // For ring-specific material properties
  _pad: vec2f 
}
@binding(3) @group(0) var<uniform> material: MaterialUniforms;

// ============================================
// DISNEY-STYLE PBR FUNCTIONS
// ============================================

// Hash function for procedural noise
fn hash3(p: vec3f) -> vec3f {
  let q = vec3f(dot(p, vec3f(127.1, 311.7, 74.7)), dot(p, vec3f(269.5, 183.3, 246.1)), dot(p, vec3f(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453);
}

// ============================================
// PROCEDURAL SURFACE DETAIL SYSTEM
// ============================================

// Hash function for pseudo-random values
fn hash3(p: vec3f) -> vec3f {
  let q = vec3f(dot(p, vec3f(127.1, 311.7, 74.7)),
                dot(p, vec3f(269.5, 183.3, 246.1)),
                dot(p, vec3f(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453);
}

// Value noise for surface variation
fn valueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let n = i.x + i.y * 157.0 + 113.0 * i.z;
  return mix(mix(mix(hash3(vec3f(n + 0.0)).x, hash3(vec3f(n + 1.0)).x, f.x),
                 mix(hash3(vec3f(n + 157.0)).x, hash3(vec3f(n + 158.0)).x, f.x), f.y),
             mix(mix(hash3(vec3f(n + 113.0)).x, hash3(vec3f(n + 114.0)).x, f.x),
                 mix(hash3(vec3f(n + 270.0)).x, hash3(vec3f(n + 271.0)).x, f.x), f.y), f.z);
}

// FBM (Fractal Brownian Motion) for complex detail
fn fbm(p: vec3f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  for (var i = 0; i < octaves; i = i + 1) {
    value += amplitude * valueNoise(p * frequency);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return value;
}

// Voronoi noise for wear patterns
fn voronoi(p: vec3f) -> vec2f {
  let n = floor(p);
  let f = fract(p);
  var mg: vec3f;
  var mr: vec3f;
  var md = 8.0;
  for (var k = -1; k <= 1; k = k + 1) {
    for (var j = -1; j <= 1; j = j + 1) {
      for (var i = -1; i <= 1; i = i + 1) {
        let g = vec3f(f32(i), f32(j), f32(k));
        let o = hash3(n + g);
        let r = g + o - f;
        let d = dot(r, r);
        if (d < md) {
          md = d;
          mr = r;
          mg = g;
        }
      }
    }
  }
  return vec2f(md, mr.x + mr.y + mr.z);
}

// Normal perturbation without normal maps
fn perturbNormal(N: vec3f, worldPos: vec3f, strength: f32) -> vec3f {
  let noise1 = fbm(worldPos * 200.0, 3);
  let noise2 = fbm(worldPos * 150.0 + 100.0, 3);
  let noise3 = fbm(worldPos * 180.0 + 200.0, 3);
  let perturb = vec3f(noise1 - 0.5, noise2 - 0.5, noise3 - 0.5) * strength;
  return normalize(N + perturb);
}


// Simplex noise for surface detail
fn noise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let n = i.x + i.y * 157.0 + 113.0 * i.z;
  return mix(mix(mix(hash3(vec3f(n + 0.0)).x, hash3(vec3f(n + 1.0)).x, f.x),
                 mix(hash3(vec3f(n + 157.0)).x, hash3(vec3f(n + 158.0)).x, f.x), f.y),
             mix(mix(hash3(vec3f(n + 113.0)).x, hash3(vec3f(n + 114.0)).x, f.x),
                 mix(hash3(vec3f(n + 270.0)).x, hash3(vec3f(n + 271.0)).x, f.x), f.y), f.z);
}

// Schlick's Fresnel approximation
fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(1.0 - cosTheta, 5.0);
}

// Schlick approximation with roughness (for IBL)
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3f, roughness: f32) -> vec3f {
  return F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(1.0 - cosTheta, 5.0);
}

// GGX/Trowbridge-Reitz Normal Distribution Function
fn ndfGGX(NdotH: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / (PI * denom * denom);
}

// Smith Geometry function with GGX
fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
  let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
  return ggx1 * ggx2;
}

// Complete Cook-Torrance BRDF
fn cookTorranceBRDF(L: vec3f, V: vec3f, N: vec3f, albedo: vec3f, metallic: f32, roughness: f32) -> vec3f {
  let H = normalize(L + V);
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  let NdotH = max(dot(N, H), 0.0);
  let HdotV = max(dot(H, V), 0.0);
  
  // Fresnel term (F)
  let F0 = mix(vec3f(0.04), albedo, metallic);
  let F = fresnelSchlick(HdotV, F0);
  
  // Normal distribution (D)
  let NDF = ndfGGX(NdotH, roughness);
  
  // Geometry term (G)
  let G = geometrySmith(NdotV, NdotL, roughness);
  
  // Cook-Torrance specular
  let numerator = NDF * G * F;
  let denominator = 4.0 * NdotV * NdotL + 0.001;
  let specular = numerator / denominator;
  
  // Lambertian diffuse
  let kS = F;
  let kD = (vec3f(1.0) - kS) * (1.0 - metallic);
  let diffuse = albedo / PI;
  
  return (kD * diffuse + specular) * NdotL;
}

// Environment reflection approximation (simplified IBL)
fn getEnvironmentReflection(viewDir: vec3f, normal: vec3f, roughness: f32, metallic: f32, albedo: vec3f) -> vec3f {
  let reflectDir = reflect(-viewDir, normal);
  
  // Simulated environment colors for different directions
  let skyColor = vec3f(0.2, 0.4, 0.6);
  let groundColor = vec3f(0.1, 0.08, 0.06);
  let horizonColor = vec3f(0.4, 0.5, 0.55);
  
  let t = clamp(reflectDir.y * 0.5 + 0.5, 0.0, 1.0);
  let envColor = mix(groundColor, mix(horizonColor, skyColor, smoothstep(0.3, 0.7, t)), smoothstep(0.0, 0.3, t));
  
  let blurFactor = roughness * roughness;
  let finalEnv = mix(envColor, vec3f(0.5), blurFactor * 0.5);
  
  let F0 = mix(vec3f(0.04), albedo, metallic);
  let fresnel = fresnelSchlickRoughness(max(dot(normal, viewDir), 0.0), F0, roughness);
  
  return finalEnv * fresnel * metallic;
}

// Anisotropic specular highlight for brushed metal effect
fn anisotropicSpecular(viewDir: vec3f, lightDir: vec3f, normal: vec3f, tangent: vec3f, roughness: f32) -> f32 {
  let halfDir = normalize(viewDir + lightDir);
  let NdotH = max(dot(normal, halfDir), 0.0);
  let TdotH = dot(tangent, halfDir);
  let aniso = pow(NdotH, 32.0 / (roughness + 0.01)) * exp(-(TdotH * TdotH) / (0.1 + roughness));
  return aniso;
}

// Calculate tangent from position for cylindrical rollers
fn calculateTangent(worldPos: vec3f, normal: vec3f) -> vec3f {
  let posXZ = normalize(vec2f(worldPos.x, worldPos.z));
  let tangent = vec3f(-posXZ.y, 0.0, posXZ.x);
  return normalize(tangent);
}

// Multiple light source PBR calculation
fn calculatePBR(normal: vec3f, viewDir: vec3f, tangent: vec3f, albedo: vec3f, metallic: f32, roughness: f32, ringColor: vec3f) -> vec3f {
  var totalLight = vec3f(0.0);
  
  // Key light (warm, main illumination)
  let keyDir = normalize(vec3f(0.6, 0.8, 0.3));
  let keyColor = vec3f(1.0, 0.95, 0.85);
  totalLight += cookTorranceBRDF(keyDir, viewDir, normal, albedo, metallic, roughness) * keyColor;
  
  // Fill light (cool, soft from left)
  let fillDir = normalize(vec3f(-0.5, 0.3, -0.4));
  let fillColor = vec3f(0.4, 0.5, 0.6);
  totalLight += cookTorranceBRDF(fillDir, viewDir, normal, albedo, metallic, roughness) * fillColor * 0.5;
  
  // Rim light (cyan accent)
  let rimDir = normalize(vec3f(-0.3, 0.2, 0.8));
  let rimColor = vec3f(0.2, 0.6, 0.8);
  totalLight += cookTorranceBRDF(rimDir, viewDir, normal, albedo, metallic, roughness) * rimColor * 0.4;
  
  // Back rim light (warm)
  let backRimDir = normalize(vec3f(0.4, 0.1, -0.7));
  let backRimColor = vec3f(0.8, 0.6, 0.4);
  totalLight += cookTorranceBRDF(backRimDir, viewDir, normal, albedo, metallic, roughness) * backRimColor * 0.3;
  
  // Anisotropic highlight for brushed metal
  let aniso = anisotropicSpecular(viewDir, keyDir, normal, tangent, roughness);
  totalLight += ringColor * aniso * metallic * 0.15;
  
  return totalLight;
}

// Ambient occlusion approximation
fn calculateAO(worldPos: vec3f, normal: vec3f) -> f32 {
  let yPos = worldPos.y;
  let edgeFactor = 1.0 - smoothstep(0.9, 1.25, abs(yPos));
  let ao = 0.5 + 0.5 * edgeFactor;
  return ao;
}

// Ring-specific material properties
fn getRingMaterial(ringIndex: f32) -> vec4f {
  if (ringIndex < 0.5) {
    return vec4f(0.95, 0.15, 0.9, 1.2);  // Inner: Polished NdFeB
  } else if (ringIndex < 1.5) {
    return vec4f(0.90, 0.25, 0.85, 1.0); // Middle: Brushed metal
  } else {
    return vec4f(0.85, 0.35, 0.8, 0.8);  // Outer: Industrial steel
  }
}

@fragment fn main(@location(0) normal: vec3f, @location(1) worldPos: vec3f, @location(2) ringIndex: f32) -> @location(0) vec4f {
  let n = normalize(normal);
  let viewDir = normalize(globals.cameraPos - worldPos);
  let NdotV = max(dot(n, viewDir), 0.0);
  
  // Ring-specific base colors
  var ringColor: vec3f;
  if (ringIndex < 0.5) {
    ringColor = vec3f(0.0, 0.85, 1.0);
  } else if (ringIndex < 1.5) {
    ringColor = vec3f(0.0, 0.5, 1.0);
  } else {
    ringColor = vec3f(0.6, 0.0, 1.0);
  }
  
  // Get ring-specific material properties
  let ringMat = getRingMaterial(ringIndex);
  let metallic = ringMat.x;
  let roughness = ringMat.y;
  let ao = ringMat.z;
  let emissionScale = ringMat.w;
  
  let albedo = mix(ringColor * 0.8, ringColor, metallic * 0.5);
  
  // ============================================
  // SURFACE DETAIL LAYERS FOR ROLLERS (NdFeB MAGNETS)
  // ============================================
  
  // Layer 1: Micro-scratches → roughness variation
  let microScratches = fbm(worldPos * 500.0, 4) * 0.02;
  let roughnessVar = roughness + microScratches;
  
  // Layer 2: Surface pitting → albedo darkening (Voronoi)
  let pitting = voronoi(worldPos * 100.0).x;
  let pitDarkening = 1.0 - pitting * 0.12;
  
  // Layer 3: Machining marks → normal perturbation
  let machiningMarks = sin(worldPos.y * 200.0) * 0.015;
  
  // Apply perturbed normal with machining marks
  let nDetail = perturbNormal(n, worldPos + vec3f(0.0, machiningMarks, 0.0), 0.025);
  
  // Base surface detail with FBM
  let surfaceNoise = fbm(worldPos * 8.0 + ringIndex * 20.0, 3);
  let surfaceDetail = (0.95 + 0.1 * surfaceNoise * roughnessVar) * pitDarkening;
  
  let tangent = calculateTangent(worldPos, n);
  
  // Calculate professional studio lighting with area lights and IBL
  var pbrColor = calculateStudioLighting(nDetail, viewDir, tangent, albedo * surfaceDetail, metallic, roughnessVar, worldPos, ringColor);
  
  // Add environment reflection (IBL)
  let envReflection = getEnvironmentReflection(viewDir, n, roughness, metallic, albedo);
  pbrColor += envReflection * ao;
  
  // Enhanced ambient occlusion
  let aoFactor = enhancedAO(worldPos, n) * ao;
  pbrColor *= aoFactor;
  
  // Magnetic field energy emission
  let fieldPattern = sin(worldPos.y * 4.0 + globals.time * 4.0) * 
                     cos(length(worldPos.xz) * 5.0 - globals.time * 3.0 + ringIndex);
  let energyPulse = 0.7 + 0.3 * sin(globals.time * 3.0 + ringIndex * 1.5);
  let fieldGlow = ringColor * (fieldPattern * 0.2 + 0.4) * pow(1.0 - NdotV, 3.0) * material.emission * emissionScale * energyPulse;
  
  // Combine all components
  let finalColor = pbrColor + fieldGlow;
  
  // HDR tone mapping (exponential)
  let exposure = 1.2;
  var mapped = vec3f(1.0) - exp(-finalColor * exposure);
  
  // === CINEMATIC POST-PROCESSING PIPELINE ===
  
  // 1. ACES Filmic Tone Mapping for cinematic contrast
  let acesA = 2.51;
  let acesB = 0.03;
  let acesC = 2.43;
  let acesD = 0.59;
  let acesE = 0.14;
  mapped = clamp((mapped * (acesA * mapped + acesB)) / (mapped * (acesC * mapped + acesD) + acesE), vec3f(0.0), vec3f(1.0));
  
  // 2. Gamma correction
  let gammaCorrected = pow(mapped, vec3f(1.0 / 2.2));
  
  // 3. Color Grading - Contrast (cinematic punch)
  var finalColorPP = (gammaCorrected - 0.5) * 1.15 + 0.5;
  
  // 4. Color Grading - Saturation boost for metallic materials
  let luma = dot(finalColorPP, vec3f(0.299, 0.587, 0.114));
  finalColorPP = mix(vec3f(luma), finalColorPP, 1.08);
  
  // 5. Color tint - Cool shadows, warm highlights
  let shadows = smoothstep(0.0, 0.25, luma);
  let highlights = smoothstep(0.75, 1.0, luma);
  let shadowTint = vec3f(0.9, 0.94, 1.0);  // Cool blue shadow tint
  let highlightTint = vec3f(1.04, 1.02, 0.98);  // Warm highlight tint
  finalColorPP = mix(finalColorPP * shadowTint, finalColorPP, shadows);
  finalColorPP = mix(finalColorPP, finalColorPP * highlightTint, highlights);
  
  // 6. HDR Bloom boost from magnetic field glow
  let luminance = dot(finalColor, vec3f(0.299, 0.587, 0.114));
  let hdrBoost = 1.0 + luminance * 0.15;
  let bloomGlow = fieldGlow * energyPulse * 0.3;
  finalColorPP = finalColorPP * hdrBoost + bloomGlow;
  
  return vec4f(finalColorPP, 1.0);
}`;


    this.particleVertShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, particleType: u32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct Particle { position: vec3f, velocity: vec3f, density: f32, pressure: f32, charge: f32, life: f32 }
@binding(4) @group(0) var<storage> particles: array<Particle>;
struct VertexOutput { 
  @builtin(position) position: vec4f, 
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f 
}
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
@vertex fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
  var output: VertexOutput;
  let p = particles[instanceIdx];
  let size = select(0.05, 0.08, device.particleType == 1u);
  let corners = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  output.uv = corners[vertIdx];
  let corner = corners[vertIdx] * size;
  let localPos = p.position * device.deviceScale;
  output.worldPos = quatRotate(device.deviceRot, localPos) + device.devicePos;
  output.position = globals.viewProj * vec4f(output.worldPos + vec3f(corner, 0.0), 1.0);
  return output;
}`;

    this.particleFragShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct MaterialUniforms { baseColor: vec3f, _pad1: f32, glowColor: vec3f, emission: f32 }
@binding(3) @group(0) var<uniform> material: MaterialUniforms;

// Smoothstep for soft edges
fn smoothStep(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@fragment fn main(@builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) worldPos: vec3f) -> @location(0) vec4f {
  let dist = length(uv);
  if (dist > 1.0) { discard; }
  
  // Soft radial gradient
  let radialFalloff = 1.0 - smoothStep(0.0, 1.0, dist);
  
  // Inner bright core
  let coreIntensity = 1.0 - smoothStep(0.0, 0.4, dist);
  
  // Outer glow halo
  let glowIntensity = smoothStep(0.3, 1.0, dist) * 0.5;
  
  // Time-based pulse
  let pulse = 0.85 + 0.15 * sin(globals.time * 4.0);
  
  // Combine core and glow
  let totalIntensity = (coreIntensity * 1.5 + radialFalloff * 0.5 + glowIntensity * 0.3) * pulse;
  
  // HDR boost for bloom effect
  let hdrColor = material.glowColor * (1.0 + material.emission * 0.5);
  
  // Alpha with HDR-style falloff
  let alpha = radialFalloff * material.emission * pulse;
  
  var finalColor = hdrColor * totalIntensity;
  
  // === CINEMATIC POST-PROCESSING PIPELINE (Particle Edition) ===
  
  // 1. Soft ACES-style tone mapping for particles (preserves glow)
  let acesA = 2.51;
  let acesB = 0.03;
  let acesC = 2.43;
  let acesD = 0.59;
  let acesE = 0.14;
  finalColor = clamp((finalColor * (acesA * finalColor + acesB)) / (finalColor * (acesC * finalColor + acesD) + acesE), vec3f(0.0), vec3f(1.0));
  
  // 2. Subtle contrast boost for particle definition
  finalColor = (finalColor - 0.5) * 1.1 + 0.5;
  
  // 3. Enhanced saturation for glow effect
  let luma = dot(finalColor, vec3f(0.299, 0.587, 0.114));
  finalColor = mix(vec3f(luma), finalColor, 1.15);
  
  // 4. HDR bloom boost from core intensity
  let bloomBoost = coreIntensity * material.emission * 0.3;
  finalColor = finalColor + material.glowColor * bloomBoost;
  
  // Output with additive-friendly alpha
  return vec4f(finalColor, alpha);
}`;

    this.gridVertShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
@vertex fn main(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return globals.viewProj * vec4f(pos.x * 50.0, -3.0, pos.y * 50.0, 1.0);
}`;

    this.gridFragShader = `
@fragment fn main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let gridScale = 2.0;
  let gridPos = pos.xy / gridScale;
  let gridLine = abs(fract(gridPos - 0.5) - 0.5) / fwidth(gridPos);
  let line = min(gridLine.x, gridLine.y);
  let gridIntensity = 1.0 - min(line, 1.0);
  let centerDist = length(pos.xy - vec2f(0.5)) * 2.0;
  let fade = 1.0 - smoothstep(0.3, 1.0, centerDist);
  return vec4f(vec3f(0.0, 0.4, 0.5), gridIntensity * fade * 0.3);
}`;
    
    // Core vertex shader - supports instanced rendering with position offsets
    this.coreVertShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct VertexOutput { @builtin(position) position: vec4f, @location(0) normal: vec3f, @location(1) worldPos: vec3f, @location(2) baseNormal: vec3f }
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
@vertex fn main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) instancePos: vec3f) -> VertexOutput {
  var output: VertexOutput;
  // Apply instance offset if provided (for bolts), otherwise use origin
  let localPos = position + instancePos;
  let worldPos = quatRotate(device.deviceRot, localPos * device.deviceScale) + device.devicePos;
  output.position = globals.viewProj * vec4f(worldPos, 1.0);
  output.normal = quatRotate(device.deviceRot, normal);
  output.worldPos = worldPos;
  output.baseNormal = normal;
  return output;
}`;
    
    // Core fragment shader - metallic material with glow
    this.coreFragShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct CoreMaterialUniforms { 
  baseColor: vec3f, 
  emission: f32, 
  coreColor: vec3f, 
  glowIntensity: f32 
}
@binding(3) @group(0) var<uniform> material: CoreMaterialUniforms;

// ============================================
// PROCEDURAL SURFACE DETAIL FOR CORE (STEEL)
// ============================================

// Hash function for pseudo-random values
fn coreHash3(p: vec3f) -> vec3f {
  let q = vec3f(dot(p, vec3f(127.1, 311.7, 74.7)),
                dot(p, vec3f(269.5, 183.3, 246.1)),
                dot(p, vec3f(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453);
}

// Value noise for surface variation
fn coreValueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let n = i.x + i.y * 157.0 + 113.0 * i.z;
  return mix(mix(mix(coreHash3(vec3f(n + 0.0)).x, coreHash3(vec3f(n + 1.0)).x, f.x),
                 mix(coreHash3(vec3f(n + 157.0)).x, coreHash3(vec3f(n + 158.0)).x, f.x), f.y),
             mix(mix(coreHash3(vec3f(n + 113.0)).x, coreHash3(vec3f(n + 114.0)).x, f.x),
                 mix(coreHash3(vec3f(n + 270.0)).x, coreHash3(vec3f(n + 271.0)).x, f.x), f.y), f.z);
}

// FBM for complex detail
fn coreFbm(p: vec3f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  for (var i = 0; i < octaves; i = i + 1) {
    value += amplitude * coreValueNoise(p * frequency);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return value;
}

// Normal perturbation without normal maps
fn corePerturbNormal(N: vec3f, worldPos: vec3f, strength: f32) -> vec3f {
  let noise1 = coreFbm(worldPos * 200.0, 3);
  let noise2 = coreFbm(worldPos * 150.0 + 100.0, 3);
  let noise3 = coreFbm(worldPos * 180.0 + 200.0, 3);
  let perturb = vec3f(noise1 - 0.5, noise2 - 0.5, noise3 - 0.5) * strength;
  return normalize(N + perturb);
}

// ============================================
// PROFESSIONAL LIGHTING - Core/Solid Material
// ============================================

// Core material SH (neutral industrial lighting)
const CORE_SH_0: vec3f = vec3f(0.18, 0.20, 0.22);
const CORE_SH_1: vec3f = vec3f(0.08, 0.09, 0.10);
const CORE_SH_2: vec3f = vec3f(0.12, 0.13, 0.14);
const CORE_SH_3: vec3f = vec3f(0.25, 0.28, 0.30);

fn evaluateCoreSH(normal: vec3f) -> vec3f {
  return CORE_SH_0 + CORE_SH_1 * normal.x + CORE_SH_2 * normal.y + CORE_SH_3 * normal.z;
}

// Multi-light calculation for solid materials
fn calculateCoreLighting(normal: vec3f, viewDir: vec3f, worldPos: vec3f, 
                         roughness: f32) -> vec3f {
  // Key light
  let keyDir = normalize(globals.keyLightPos - worldPos);
  let keyNdotL = max(dot(normal, keyDir), 0.0);
  let keyHalf = normalize(viewDir + keyDir);
  let keySpec = pow(max(dot(normal, keyHalf), 0.0), 64.0 / roughness);
  let keyContrib = globals.keyLightColor * globals.keyLightIntensity * 
                   (keyNdotL * 0.7 + keySpec * 0.5);
  
  // Fill light
  let fillDir = normalize(globals.fillLightPos - worldPos);
  let fillNdotL = max(dot(normal, fillDir), 0.0);
  let fillContrib = globals.fillLightColor * globals.fillLightIntensity * fillNdotL * 0.5;
  
  // Rim light
  let rimFresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);
  let rimContrib = globals.rimLightColor * globals.rimLightIntensity * rimFresnel;
  
  // Ground bounce
  let groundNdotL = max(dot(normal, vec3f(0.0, -1.0, 0.0)), 0.0);
  let groundContrib = globals.groundLightColor * globals.groundLightIntensity * groundNdotL * 0.2;
  
  // IBL ambient
  let ambient = evaluateCoreSH(normal) * 0.5;
  
  return ambient + keyContrib + fillContrib + rimContrib + groundContrib;
}

// Contact AO for solid parts
fn calculateCoreAO(worldPos: vec3f, normal: vec3f) -> f32 {
  let yPos = worldPos.y;
  let edgeFactor = 1.0 - smoothstep(1.4, 2.8, abs(yPos));
  return 0.4 + 0.6 * edgeFactor;
}

@fragment fn main(@location(0) normal: vec3f, @location(1) worldPos: vec3f, @location(2) baseNormal: vec3f) -> @location(0) vec4f {
  // ============================================
  // SURFACE DETAIL LAYERS FOR CORE (STEEL)
  // ============================================
  
  // Layer 1: Brushed metal streaks - directional noise along cylinder axis (Y)
  let brushNoise = coreFbm(vec3f(worldPos.x * 50.0, worldPos.y * 2.0, worldPos.z * 50.0), 3);
  let brushedStreaks = 0.9 + brushNoise * 0.2;
  
  // Layer 2: Oil stains - low-frequency color variation
  let oilPattern = coreFbm(worldPos * 5.0 + vec3f(100.0), 3);
  let oilStain = mix(vec3f(1.0), vec3f(0.9, 0.85, 0.75), oilPattern * 0.3);
  
  // Layer 3: Edge wear - increased roughness at cylinder edges (top/bottom)
  let yPos = worldPos.y - device.devicePos.y;
  let edgeDistance = abs(abs(yPos) - 1.5);
  let edgeWear = smoothstep(0.5, 0.0, edgeDistance) * 0.3;
  let wornRoughness = 0.4 + edgeWear;
  
  // Layer 4: Machining marks on shaft
  let shaftRadius = sqrt(worldPos.x * worldPos.x + worldPos.z * worldPos.z);
  let isShaft = shaftRadius < 0.6;
  let machiningMarks = select(0.0, sin(worldPos.y * 300.0) * 0.02, isShaft);
  
  // Apply perturbed normal with machining marks
  let n = corePerturbNormal(normalize(normal), worldPos + vec3f(0.0, machiningMarks, 0.0), 0.015);
  let viewDir = normalize(globals.cameraPos - worldPos);
  
  // Professional multi-light calculation with worn roughness
  let lighting = calculateCoreLighting(n, viewDir, worldPos, wornRoughness);
  
  // Specular highlights (Blinn-Phong with key light) with worn roughness
  let keyDir = normalize(globals.keyLightPos - worldPos);
  let halfDir = normalize(keyDir + viewDir);
  let specAngle = max(dot(n, halfDir), 0.0);
  let specularPower = 32.0 / (wornRoughness + 0.1);
  let specular = pow(specAngle, specularPower) * (0.6 - edgeWear * 0.2) * globals.keyLightIntensity;
  
  // Fresnel rim lighting
  let fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  let rimLight = fresnel * 0.4;
  
  // Time-based magnetic glow (pulsing cyan glow)
  let pulse = sin(globals.time * 3.0) * 0.3 + 0.7;
  let glow = material.coreColor * pulse * material.glowIntensity * fresnel;
  
  // Determine if this is the magnetic core (center) based on height
  let isCore = abs(yPos) < 1.6;
  
  // Mix colors based on position with brushed metal and oil stains
  let baseSteel = material.baseColor * brushedStreaks * oilStain;
  let baseCore = material.coreColor * 0.8 * brushedStreaks;
  let finalBase = select(baseSteel, baseCore, isCore);
  
  // Combine lighting with professional studio setup
  let ao = calculateCoreAO(worldPos, n);
  let litColor = finalBase * lighting * ao + vec3f(specular) + rimLight * finalBase;
  
  // Add emission glow
  var finalColor = litColor + glow * pulse;
  
  // === CINEMATIC POST-PROCESSING PIPELINE ===
  
  // 1. ACES Filmic Tone Mapping
  let acesA = 2.51;
  let acesB = 0.03;
  let acesC = 2.43;
  let acesD = 0.59;
  let acesE = 0.14;
  finalColor = clamp((finalColor * (acesA * finalColor + acesB)) / (finalColor * (acesC * finalColor + acesD) + acesE), vec3f(0.0), vec3f(1.0));
  
  // 2. Color Grading - Contrast
  finalColor = (finalColor - 0.5) * 1.12 + 0.5;
  
  // 3. Color Grading - Saturation
  let luma = dot(finalColor, vec3f(0.299, 0.587, 0.114));
  finalColor = mix(vec3f(luma), finalColor, 1.08);
  
  // 4. Color tint - Cool shadows, warm highlights for metallic core
  let shadows = smoothstep(0.0, 0.25, luma);
  let highlights = smoothstep(0.75, 1.0, luma);
  let shadowTint = vec3f(0.9, 0.94, 1.0);
  let highlightTint = vec3f(1.04, 1.02, 0.98);
  finalColor = mix(finalColor * shadowTint, finalColor, shadows);
  finalColor = mix(finalColor, finalColor * highlightTint, highlights);
  
  // 5. HDR Glow boost from magnetic emission
  let bloomGlow = glow * pulse * 0.4;
  finalColor = finalColor + bloomGlow;
  
  return vec4f(finalColor, 1.0);
}`;
    
    // Field line vertex shader - flowing magnetic field lines
    this.fieldLineVertShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct FieldParticle { position: vec3f, velocity: vec3f, life: f32, strength: f32 }
@binding(4) @group(0) var<storage> fieldParticles: array<FieldParticle>;
struct VertexOutput { 
  @builtin(position) position: vec4f, 
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f,
  @location(2) life: f32,
  @location(3) strength: f32
}
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
@vertex fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
  var output: VertexOutput;
  let fp = fieldParticles[instanceIdx];
  let size = 0.02 * fp.strength;
  let corners = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  output.uv = corners[vertIdx];
  let corner = corners[vertIdx] * size;
  let localPos = fp.position * device.deviceScale;
  output.worldPos = quatRotate(device.deviceRot, localPos) + device.devicePos;
  output.position = globals.viewProj * vec4f(output.worldPos + vec3f(corner, 0.0), 1.0);
  output.life = fp.life;
  output.strength = fp.strength;
  return output;
}`;
    
    // Field line fragment shader - glowing flowing particles
    this.fieldLineFragShader = `
struct GlobalUniforms { viewProj: mat4x4f, time: f32, _pad: vec3f }
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
@fragment fn main(@location(0) uv: vec2f, @location(1) worldPos: vec3f, @location(2) life: f32, @location(3) strength: f32) -> @location(0) vec4f {
  let dist = length(uv);
  if (dist > 1.0) { discard; }
  
  // Radial falloff
  let radial = 1.0 - smoothstep(0.0, 1.0, dist);
  
  // Life-based fade in/out
  let lifeFade = sin(life * 3.14159);
  
  // Strength-based intensity
  let intensity = strength * radial * lifeFade;
  
  // North pole color (cyan) to South pole color (red)
  let northColor = vec3f(0.0, 0.9, 1.0);
  let southColor = vec3f(1.0, 0.2, 0.1);
  let fieldColor = mix(northColor, southColor, smoothstep(-1.0, 1.0, worldPos.y));
  
  // Trail effect - elongate along velocity
  let trail = pow(radial, 0.5) * 1.5;
  
  // HDR glow
  var hdrColor = fieldColor * (1.0 + intensity * 2.0);
  
  // === CINEMATIC POST-PROCESSING (Field Lines) ===
  
  // ACES tone mapping for cinematic look
  let acesA = 2.51;
  let acesB = 0.03;
  let acesC = 2.43;
  let acesD = 0.59;
  let acesE = 0.14;
  hdrColor = clamp((hdrColor * (acesA * hdrColor + acesB)) / (hdrColor * (acesC * hdrColor + acesD) + acesE), vec3f(0.0), vec3f(1.0));
  
  // Saturation boost for magnetic field visibility
  let luma = dot(hdrColor, vec3f(0.299, 0.587, 0.114));
  hdrColor = mix(vec3f(luma), hdrColor, 1.2);
  
  // HDR boost from field intensity
  let fieldBoost = intensity * fieldColor * 0.5;
  hdrColor = hdrColor + fieldBoost;
  
  return vec4f(hdrColor * trail, intensity * 0.8);
}`;
    
    // Energy arc vertex shader - electric arcs between rollers
    this.energyArcVertShader = `
// ============================================
// PROFESSIONAL LIGHTING SYSTEM - Extended GlobalUniforms
// ============================================
struct GlobalUniforms { 
  viewProj: mat4x4f, 
  time: f32, 
  _pad0: vec3f, 
  cameraPos: vec3f, 
  _pad1: f32,
  // Key light (warm, main)
  keyLightPos: vec3f,
  keyLightIntensity: f32,
  keyLightColor: vec3f,
  _pad2: f32,
  // Fill light (cool, soft)
  fillLightPos: vec3f,
  fillLightIntensity: f32,
  fillLightColor: vec3f,
  _pad3: f32,
  // Rim light (edge highlight)
  rimLightPos: vec3f,
  rimLightIntensity: f32,
  rimLightColor: vec3f,
  _pad4: f32,
  // Ground light (bounce)
  groundLightPos: vec3f,
  groundLightIntensity: f32,
  groundLightColor: vec3f,
  _pad5: f32
}
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct ArcSegment { startPos: vec3f, endPos: vec3f, intensity: f32, width: f32 }
@binding(4) @group(0) var<storage> arcSegments: array<ArcSegment>;
struct VertexOutput { 
  @builtin(position) position: vec4f, 
  @location(0) t: f32,
  @location(1) offset: f32,
  @location(2) intensity: f32,
  @location(3) worldPos: vec3f
}
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
fn noise(p: f32) -> f32 { return fract(sin(p * 12.9898) * 43758.5453); }
@vertex fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
  var output: VertexOutput;
  let arc = arcSegments[instanceIdx / 2];
  let isTop = (instanceIdx % 2u) == 0u;
  
  // Arc parameter t along the line
  let t = select(0.0, 1.0, (vertIdx % 2u) == 1u);
  output.t = t;
  
  // Jitter for electric arc effect
  let jitter1 = noise(t * 10.0 + globals.time * 20.0 + f32(instanceIdx)) * 0.3;
  let jitter2 = noise(t * 15.0 + globals.time * 25.0 + f32(instanceIdx) * 1.5) * 0.2;
  
  // Base position along arc
  let basePos = mix(arc.startPos, arc.endPos, t);
  
  // Add perpendicular jitter
  let dir = normalize(arc.endPos - arc.startPos);
  let up = vec3f(0.0, 1.0, 0.0);
  let right = normalize(cross(dir, up));
  let perp = normalize(cross(dir, right));
  
  let jitterOffset = (jitter1 * right + jitter2 * perp) * arc.width;
  let arcPos = basePos + jitterOffset;
  
  // Width offset
  let widthOffset = select(-1.0, 1.0, isTop) * arc.width * 0.5;
  let finalPos = arcPos + perp * widthOffset;
  
  let localPos = finalPos * device.deviceScale;
  output.worldPos = quatRotate(device.deviceRot, localPos) + device.devicePos;
  output.position = globals.viewProj * vec4f(output.worldPos, 1.0);
  output.offset = widthOffset;
  output.intensity = arc.intensity;
  
  return output;
}`;
    
    // Energy arc fragment shader - electric spark effect
    this.energyArcFragShader = `
struct GlobalUniforms { viewProj: mat4x4f, time: f32, _pad: vec3f }
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
@fragment fn main(@location(0) t: f32, @location(1) offset: f32, @location(2) intensity: f32, @location(3) worldPos: vec3f) -> @location(0) vec4f {
  // Electric arc colors (white core, cyan glow)
  let coreColor = vec3f(1.0, 1.0, 1.0);
  let glowColor = vec3f(0.2, 0.8, 1.0);
  
  // Intensity flicker
  let flicker = 0.7 + 0.3 * sin(globals.time * 30.0 + t * 50.0);
  let totalIntensity = intensity * flicker;
  
  // Core brightness
  let core = smoothstep(0.0, 0.1, totalIntensity);
  
  // Glow falloff
  let glow = totalIntensity * 0.5;
  
  // Combine
  let finalColor = mix(glowColor, coreColor, core) * totalIntensity;
  
  // HDR boost for bright arcs
  var hdrColor = finalColor * (1.0 + totalIntensity * 2.0);
  
  // === CINEMATIC POST-PROCESSING (Energy Arcs) ===
  
  // ACES tone mapping for cinematic electric arcs
  let acesA = 2.51;
  let acesB = 0.03;
  let acesC = 2.43;
  let acesD = 0.59;
  let acesE = 0.14;
  hdrColor = clamp((hdrColor * (acesA * hdrColor + acesB)) / (hdrColor * (acesC * hdrColor + acesD) + acesE), vec3f(0.0), vec3f(1.0));
  
  // High contrast for electric arc punch
  hdrColor = (hdrColor - 0.5) * 1.3 + 0.5;
  
  // Saturation boost for cyan electric glow
  let luma = dot(hdrColor, vec3f(0.299, 0.587, 0.114));
  hdrColor = mix(vec3f(luma), hdrColor, 1.25);
  
  // Extra HDR bloom from arc intensity
  let arcBloom = glowColor * totalIntensity * totalIntensity * 0.4;
  hdrColor = hdrColor + arcBloom;
  
  return vec4f(hdrColor, totalIntensity * 0.9);
}`;
  }
  
  async setupDevices() {
    for (const [deviceId, config] of Object.entries(DEVICE_CONFIG)) {
      this.devices[deviceId] = new DeviceInstance(
        this.device,
        deviceId,
        config,
        this
      );
      await this.profiler.trackShaderCompile(`device-${deviceId}`, async () => {
        await this.devices[deviceId].init();
      });
    }
  }
  
  async setupEnergyPipes() {
    const pipeConfigs = [
      { from: 'seg', to: 'heron', speed: 2.0 },
      { from: 'heron', to: 'kelvin', speed: 1.5 },
      { from: 'kelvin', to: 'seg', speed: 2.5 }
    ];
    
    for (const config of pipeConfigs) {
      const pipe = new EnergyPipe(this.device, config);
      await pipe.init();
      this.energyPipes.push(pipe);
    }
  }
  
  async setupFloorGrid() {
    this.gridPipeline = this.device.createRenderPipeline({
      label: 'gridPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.gridVertShader }),
        entryPoint: 'main',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.gridFragShader }),
        entryPoint: 'main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' }
    });
    
    const gridVertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.gridVertexBuffer = this.device.createBuffer({
      size: gridVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.gridVertexBuffer, 0, gridVertices);
    this.profiler.trackBuffer('gridVertices', gridVertices.byteLength, GPUBufferUsage.VERTEX);
  }
  
  setupInteraction() {
    let isDragging = false;
    let lastX = 0, lastY = 0;
    
    this.canvas.addEventListener('mousedown', (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = (e.clientX - lastX) * 0.01;
      const deltaY = (e.clientY - lastY) * 0.01;
      
      if (this.currentView === 'overview') {
        const dist = Math.sqrt(this.camera.position[0]**2 + this.camera.position[2]**2);
        const angle = Math.atan2(this.camera.position[2], this.camera.position[0]) + deltaX;
        this.camera.position[0] = Math.cos(angle) * dist;
        this.camera.position[2] = Math.sin(angle) * dist;
        this.camera.position[1] = Math.max(2, Math.min(15, this.camera.position[1] - deltaY));
      }
      
      lastX = e.clientX;
      lastY = e.clientY;
    });
    
    window.addEventListener('mouseup', () => isDragging = false);
    
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomSpeed = 0.001;
      const forward = [this.camera.target[0] - this.camera.position[0], this.camera.target[1] - this.camera.position[1], this.camera.target[2] - this.camera.position[2]];
      const len = Math.sqrt(forward[0]**2 + forward[1]**2 + forward[2]**2);
      const dir = [forward[0]/len, forward[1]/len, forward[2]/len];
      const move = e.deltaY * zoomSpeed * len;
      this.camera.position[0] += dir[0] * move;
      this.camera.position[1] += dir[1] * move;
      this.camera.position[2] += dir[2] * move;
    });
    
    window.focusDevice = (deviceId) => { this.focusOnDevice(deviceId); };
    window.showOverview = () => { this.showOverview(); };
    window.toggleDevice = (deviceId) => { this.devicesEnabled[deviceId] = !this.devicesEnabled[deviceId]; };
    window.toggleDebugPanel = () => { this.debugPanel.toggle(); };
    
    // Keyboard shortcut for debug panel
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F3' || (e.key === 'd' && e.ctrlKey)) {
        e.preventDefault();
        this.debugPanel.toggle();
      }
    });
  }
  
  focusOnDevice(deviceId) {
    const config = DEVICE_CONFIG[deviceId];
    if (!config) return;
    
    this.currentView = deviceId;
    document.getElementById('currentView').textContent = deviceId.toUpperCase();
    
    const devicePos = config.position;
    const offset = config.cameraOffset;
    const rotY = config.rotation[1];
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const rotatedOffset = [offset[0] * cosY - offset[2] * sinY, offset[1], offset[0] * sinY + offset[2] * cosY];
    const endPos = [devicePos[0] + rotatedOffset[0], devicePos[1] + rotatedOffset[1], devicePos[2] + rotatedOffset[2]];
    
    this.startCameraTransition(endPos, devicePos);
  }
  
  showOverview() {
    this.currentView = 'overview';
    document.getElementById('currentView').textContent = 'Overview';
    this.startCameraTransition([0, 8, 18], [0, 0, 0]);
  }
  
  startCameraTransition(endPos, endTarget) {
    this.camera.transitionActive = true;
    this.camera.transitionStart = performance.now() / 1000;
    this.camera.startPos = [...this.camera.position];
    this.camera.startTarget = [...this.camera.target];
    this.camera.endPos = endPos;
    this.camera.endTarget = endTarget;
  }
  
  updateCamera(deltaTime) {
    if (!this.camera.transitionActive) return;
    
    const now = performance.now() / 1000;
    const elapsed = now - this.camera.transitionStart;
    const t = Math.min(elapsed / this.camera.transitionDuration, 1.0);
    const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    
    this.camera.position[0] = this.lerp(this.camera.startPos[0], this.camera.endPos[0], easeT);
    this.camera.position[1] = this.lerp(this.camera.startPos[1], this.camera.endPos[1], easeT);
    this.camera.position[2] = this.lerp(this.camera.startPos[2], this.camera.endPos[2], easeT);
    this.camera.target[0] = this.lerp(this.camera.startTarget[0], this.camera.endTarget[0], easeT);
    this.camera.target[1] = this.lerp(this.camera.startTarget[1], this.camera.endTarget[1], easeT);
    this.camera.target[2] = this.lerp(this.camera.startTarget[2], this.camera.endTarget[2], easeT);
    
    if (t >= 1.0) this.camera.transitionActive = false;
  }
  
  lerp(a, b, t) { return a + (b - a) * t; }
  
  getViewProjMatrix() {
    const aspect = this.canvas.width / this.canvas.height;
    const proj = this.perspectiveMatrix(this.camera.fov * Math.PI / 180, aspect, 0.1, 200);
    const view = this.lookAt(this.camera.position, this.camera.target, [0, 1, 0]);
    return this.multiplyMatrices(proj, view);
  }
  
  perspectiveMatrix(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  
  lookAt(eye, center, up) {
    const z = this.normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = this.normalize(this.cross(up, z));
    const y = this.cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1]);
  }
  
  normalize(v) { const len = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 0]; }
  cross(a, b) { return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]; }
  dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  multiplyMatrices(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let sum = 0; for (let k = 0; k < 4; k++) sum += a[i*4+k] * b[k*4+j]; out[i*4+j] = sum; }
    return out;
  }
  
  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.device) this.setupDepthBuffer();
  }
  
  async setupDepthBuffer() {
    if (this.depthTexture) {
      this.profiler.textureAllocations = this.profiler.textureAllocations.filter(t => !t.name.includes('depth'));
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.profiler.trackTexture('depthBuffer', this.canvas.width, this.canvas.height, 'depth24plus');
  }
  
  render(timestamp) {
    const deltaTime = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    
    if (timestamp % 500 < 20) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = this.fps;
    }
    
    const speed = parseFloat(document.getElementById('speedSlider')?.value) || 1.0;
    this.time += deltaTime * speed;
    
    // Update camera
    this.updateCamera(deltaTime);
    
    // Record frame in profiler
    const totalParticles = Object.values(this.devices).reduce((sum, d) => sum + (this.devicesEnabled[d.id] ? d.particleCount : 0), 0);
    this.profiler.recordFrame(deltaTime, totalParticles);
    
    // Update global uniforms with extended lighting data
    const viewProj = this.getViewProjMatrix();
    const globalData = new Float32Array(128); // 512 bytes / 4 = 128 floats
    
    // Base uniforms (offset 0-23: 96 bytes)
    globalData.set(viewProj, 0);                    // 0-15: viewProj matrix
    globalData[16] = this.time;                     // 16: time
    // padding at 17-19 (3 floats = 12 bytes)
    globalData[20] = this.camera.position[0];       // 20: cameraPos.x
    globalData[21] = this.camera.position[1];       // 21: cameraPos.y
    globalData[22] = this.camera.position[2];       // 22: cameraPos.z
    // padding at 23 (1 float = 4 bytes)
    
    // Key light (offset 24-31: 32 bytes)
    const key = this.lightingConfig.key;
    globalData[24] = key.position[0];
    globalData[25] = key.position[1];
    globalData[26] = key.position[2];
    globalData[27] = key.intensity;
    globalData[28] = key.color[0];
    globalData[29] = key.color[1];
    globalData[30] = key.color[2];
    // padding at 31
    
    // Fill light (offset 32-39: 32 bytes)
    const fill = this.lightingConfig.fill;
    globalData[32] = fill.position[0];
    globalData[33] = fill.position[1];
    globalData[34] = fill.position[2];
    globalData[35] = fill.intensity;
    globalData[36] = fill.color[0];
    globalData[37] = fill.color[1];
    globalData[38] = fill.color[2];
    // padding at 39
    
    // Rim light (offset 40-47: 32 bytes)
    const rim = this.lightingConfig.rim;
    globalData[40] = rim.position[0];
    globalData[41] = rim.position[1];
    globalData[42] = rim.position[2];
    globalData[43] = rim.intensity;
    globalData[44] = rim.color[0];
    globalData[45] = rim.color[1];
    globalData[46] = rim.color[2];
    // padding at 47
    
    // Ground light (offset 48-55: 32 bytes)
    const ground = this.lightingConfig.ground;
    globalData[48] = ground.position[0];
    globalData[49] = ground.position[1];
    globalData[50] = ground.position[2];
    globalData[51] = ground.intensity;
    globalData[52] = ground.color[0];
    globalData[53] = ground.color[1];
    globalData[54] = ground.color[2];
    // padding at 55
    
    this.device.queue.writeBuffer(this.globalUniformBuffer, 0, globalData);
    
    // Update devices with quality scaling
    const qualityScale = this.profiler.qualityLevel;
    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id]) {
        device.update(deltaTime * speed, qualityScale);
      }
    }
    
    // Begin render pass with timestamp queries
    const encoder = this.device.createCommandEncoder();
    
    // Write start timestamp if enabled
    if (this.profiler.timingEnabled) {
      encoder.writeTimestamp(this.profiler.timestampQuerySet, 0);
    }
    
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });
    
    // Render grid
    console.log('Setting grid pipeline, has depthStencil:', !!this.gridPipeline);
    renderPass.setPipeline(this.gridPipeline);
    renderPass.setBindGroup(0, this.device.createBindGroup({
      layout: this.gridPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globalUniformBuffer } }]
    }));
    renderPass.setVertexBuffer(0, this.gridVertexBuffer);
    renderPass.draw(6);
    
    // Render devices (scaled by quality)
    const scaledQuality = this.profiler.qualityLevel;
    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id]) {
        // Skip field lines if quality is low
        const skipEffects = scaledQuality < 0.5 && device.id === 'seg';
        device.render(renderPass, this.globalUniformBuffer, skipEffects);
      }
    }
    
    renderPass.end();
    
    // Write end timestamp
    if (this.profiler.timingEnabled) {
      encoder.writeTimestamp(this.profiler.timestampQuerySet, 1);
    }
    
    this.device.queue.submit([encoder.finish()]);
    
    // Resolve timestamps asynchronously
    if (this.profiler.timingEnabled) {
      this.profiler.resolveTimestamps().catch(() => {});
    }
    
    requestAnimationFrame((t) => this.render(t));
  }
}

// ============================================
// DEVICE INSTANCE
// ============================================
class DeviceInstance {
  constructor(device, id, config, visualizer) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = config.particleCount;
    this.position = config.position;
    this.rotation = config.rotation;
    this.particles = null;
    this.rollerInstances = null;
    this.deviceUniformBuffer = null;
    this.materialUniformBuffer = null;
    this.coreMaterialBuffer = null;
    this.rollerPipeline = null;
    this.particlePipeline = null;
    this.corePipeline = null;
    
    // Field line visualization (SEG only)
    this.fieldLineCount = 1000;
    this.fieldLineParticles = null;
    this.fieldLinePipeline = null;
    this.fieldLineEnabled = true;
    
    // Energy arc visualization (SEG only)
    this.arcSegmentCount = 20;
    this.arcSegments = null;
    this.energyArcPipeline = null;
    this.energyArcEnabled = true;
    this.lastArcTime = 0;
  }
  
  async init() {
    await this.setupUniforms();
    await this.setupPipelines();
    await this.setupParticles();
    
    if (this.id === 'seg') {
      await this.setupRollers();
      await this.setupCore();
      await this.setupFieldLines();
      await this.setupEnergyArcs();
    }
  }
  
  async setupUniforms() {
    this.deviceUniformBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.materialUniformBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    
    this.visualizer.profiler.trackBuffer(`device-${this.id}-uniforms`, 80, GPUBufferUsage.UNIFORM);
    
    // MaterialUniforms: albedo(3) + metallic(1) + roughness(1) + ao(1) + emission(1) + ringIndex(1) + pad(2)
    // Total: 12 floats = 48 bytes
    const materialData = new Float32Array([
      ...this.config.color,             // albedo (3 floats)
      0.95,                             // metallic (high for metals)
      0.2,                              // roughness (slightly polished)
      0.9,                              // ao (ambient occlusion)
      2.0,                              // emission (energy glow)
      0.0,                              // ringIndex (set per instance)
      0.0, 0.0                          // padding
    ]);
    this.device.queue.writeBuffer(this.materialUniformBuffer, 0, materialData);
    
    // Setup core material buffer for SEG
    if (this.id === 'seg' && this.config.core) {
      this.coreMaterialBuffer = this.device.createBuffer({ 
        size: 32, 
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST 
      });
      this.visualizer.profiler.trackBuffer(`device-${this.id}-core-material`, 32, GPUBufferUsage.UNIFORM);
      
      const core = this.config.core;
      // baseColor (3) + emission (1) + coreColor (3) + glowIntensity (1)
      const coreMaterialData = new Float32Array([
        ...core.baseColor, 0.0,  // baseColor + padding
        ...core.coreColor, 1.5   // coreColor + glowIntensity
      ]);
      this.device.queue.writeBuffer(this.coreMaterialBuffer, 0, coreMaterialData);
    }
  }
  
  async setupPipelines() {
    this.rollerPipeline = this.device.createRenderPipeline({
      label: 'rollerPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.visualizer.rollerVertShader }),
        entryPoint: 'main',
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.visualizer.rollerFragShader }),
        entryPoint: 'main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
    });
    
    this.particlePipeline = this.device.createRenderPipeline({
      label: 'particlePipeline',
      layout: 'auto',
      vertex: { module: this.device.createShaderModule({ code: this.visualizer.particleVertShader }), entryPoint: 'main' },
      fragment: { module: this.device.createShaderModule({ code: this.visualizer.particleFragShader }), entryPoint: 'main', targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' }
    });
    
    // Setup core pipeline for SEG
    if (this.id === 'seg') {
      this.corePipeline = this.device.createRenderPipeline({
        label: 'corePipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.coreVertShader }),
          entryPoint: 'main',
          buffers: [
            // Position and normal
            { arrayStride: 24, attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, 
              { shaderLocation: 1, offset: 12, format: 'float32x3' }
            ]},
            // Instance position (for bolts)
            { arrayStride: 12, stepMode: 'instance', attributes: [
              { shaderLocation: 2, offset: 0, format: 'float32x3' }
            ]}
          ]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.coreFragShader }),
          entryPoint: 'main',
          targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
      });
      
      // Field line pipeline
      this.fieldLinePipeline = this.device.createRenderPipeline({
        label: 'fieldLinePipeline',
        layout: 'auto',
        vertex: { 
          module: this.device.createShaderModule({ code: this.visualizer.fieldLineVertShader }), 
          entryPoint: 'main' 
        },
        fragment: { 
          module: this.device.createShaderModule({ code: this.visualizer.fieldLineFragShader }), 
          entryPoint: 'main', 
          targets: [{ 
            format: navigator.gpu.getPreferredCanvasFormat(), 
            blend: { 
              color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, 
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } 
            } 
          }] 
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' }
      });
      
      // Energy arc pipeline
      this.energyArcPipeline = this.device.createRenderPipeline({
        label: 'energyArcPipeline',
        layout: 'auto',
        vertex: { 
          module: this.device.createShaderModule({ code: this.visualizer.energyArcVertShader }), 
          entryPoint: 'main' 
        },
        fragment: { 
          module: this.device.createShaderModule({ code: this.visualizer.energyArcFragShader }), 
          entryPoint: 'main', 
          targets: [{ 
            format: navigator.gpu.getPreferredCanvasFormat(), 
            blend: { 
              color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, 
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } 
            } 
          }] 
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { depthWriteEnabled: false, depthCompare: 'always', format: 'depth24plus' }
      });
    }
  }
  
  async setupCore() {
    // Core geometry is already set up in MultiDeviceVisualizer.setupCoreGeometryBuffers()
    // This method ensures proper initialization order
    if (!this.config.core) return;
    
    console.log(`SEG Core initialized with:
    - Shaft: radius ${this.config.core.shaftRadius}m, height ${this.config.core.shaftHeight}m
    - Magnetic Core: radius ${this.config.core.coreRadius}m, height ${this.config.core.coreHeight}m
    - Plates: radius ${this.config.core.plateRadius}m, at y = ±${this.config.core.plateY}m
    - Bolts: ${this.config.core.boltCount} per plate`);
  }
  
  async setupPickupCoils() {
    // 24 pickup coils arranged in a circle at radius 7.0m
    const numCoils = 24;
    const coilRadius = 7.0;
    
    // Coil instance buffer: position (3), rotation (4), energy (1), coilIndex (1) = 9 floats per coil
    // Using 32 bytes per coil for alignment (8 floats, but we store extra data)
    this.coilInstances = this.device.createBuffer({
      size: numCoils * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-coils`, numCoils * 32, GPUBufferUsage.STORAGE);
    
    // Coil material buffer (copper color + glow color + emission)
    this.coilMaterialBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-coil-material`, 32, GPUBufferUsage.UNIFORM);
    
    // Copper base color: #8B4513 = (0.55, 0.27, 0.07)
    // Glow color: #00CCFF = (0.0, 0.8, 1.0)
    const coilMaterialData = new Float32Array([
      0.55, 0.27, 0.07, 0.0,  // copperColor + padding
      0.0, 0.8, 1.0, 2.0       // glowColor + emission
    ]);
    this.device.queue.writeBuffer(this.coilMaterialBuffer, 0, coilMaterialData);
    
    // Ring material buffer
    this.ringMaterialBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-ring-material`, 32, GPUBufferUsage.UNIFORM);
    
    // Ring color (copper) + pulse color (cyan-blue)
    const ringMaterialData = new Float32Array([
      0.55, 0.27, 0.07, 0.0,  // ringColor + padding
      0.0, 0.8, 1.0, 3.0      // pulseColor + pulseSpeed
    ]);
    this.device.queue.writeBuffer(this.ringMaterialBuffer, 0, ringMaterialData);
    
    // Create coil pipeline
    this.coilPipeline = this.device.createRenderPipeline({
      label: 'coilPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.visualizer.coilVertShader }),
        entryPoint: 'main',
        buffers: [
          { 
            arrayStride: 32, // 8 floats: pos(3) + normal(3) + uv(2)
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x2' }
            ]
          }
        ]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.visualizer.coilFragShader }),
        entryPoint: 'main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
    });
    
    // Create ring pipeline
    this.ringPipeline = this.device.createRenderPipeline({
      label: 'ringPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.visualizer.ringVertShader }),
        entryPoint: 'main',
        buffers: [
          { 
            arrayStride: 24, // 6 floats: pos(3) + normal(3)
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' }
            ]
          }
        ]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.visualizer.ringFragShader }),
        entryPoint: 'main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
    });
    
    // Initialize coil energy levels
    this.coilEnergies = new Float32Array(numCoils);
    
    console.log(`SEG Pickup Coils initialized: ${numCoils} coils at radius ${coilRadius}m`);
  }
  
  async setupParticles() {
    const particleSize = 40;
    this.particles = this.device.createBuffer({
      size: this.particleCount * particleSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-particles`, this.particleCount * particleSize, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    
    const particleData = new Float32Array(this.particleCount * 10);
    for (let i = 0; i < this.particleCount; i++) {
      const idx = i * 10;
      if (this.id === 'seg') {
        const theta = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 4;
        particleData[idx] = r * Math.cos(theta);
        particleData[idx + 1] = (Math.random() - 0.5) * 6;
        particleData[idx + 2] = r * Math.sin(theta);
        particleData[idx + 9] = Math.random();
      } else {
        particleData[idx + 1] = (Math.random() - 0.5) * 6;
      }
    }
    this.device.queue.writeBuffer(this.particles, 0, particleData);
  }
  
  async setupRollers() {
    // 3-ring SEG system: 8 inner + 12 middle + 16 outer = 36 rollers total
    const totalRollers = 36;
    this.rollerInstances = this.device.createBuffer({
      size: totalRollers * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-rollers`, totalRollers * 32, GPUBufferUsage.STORAGE);
  }
  
  async setupFieldLines() {
    // Field particles: position(3) + velocity(3) + life(1) + strength(1) = 8 floats = 32 bytes
    this.fieldLineParticles = this.device.createBuffer({
      size: this.fieldLineCount * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-fieldlines`, this.fieldLineCount * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    
    // Initialize field line particles flowing between rollers
    const fieldData = new Float32Array(this.fieldLineCount * 8);
    for (let i = 0; i < this.fieldLineCount; i++) {
      const idx = i * 8;
      // Distribute particles in arcs between rollers
      const ringIdx = Math.floor(Math.random() * 3);
      const ringRadii = [2.5, 4.0, 5.5];
      const ringRadius = ringRadii[ringIdx];
      
      const angle = Math.random() * Math.PI * 2;
      const height = (Math.random() - 0.5) * 2.0;
      
      // Position along magnetic field line
      fieldData[idx] = Math.cos(angle) * ringRadius;
      fieldData[idx + 1] = height;
      fieldData[idx + 2] = Math.sin(angle) * ringRadius;
      
      // Velocity tangent to ring (magnetic field direction)
      const speed = 0.5 + Math.random() * 1.0;
      fieldData[idx + 3] = -Math.sin(angle) * speed;
      fieldData[idx + 4] = (Math.random() - 0.5) * 0.2;
      fieldData[idx + 5] = Math.cos(angle) * speed;
      
      // Life and strength
      fieldData[idx + 6] = Math.random(); // life 0-1
      fieldData[idx + 7] = 0.5 + Math.random() * 0.5; // strength
    }
    this.device.queue.writeBuffer(this.fieldLineParticles, 0, fieldData);
  }
  
  async setupEnergyArcs() {
    // Arc segments: startPos(3) + endPos(3) + intensity(1) + width(1) = 8 floats = 32 bytes
    this.arcSegments = this.device.createBuffer({
      size: this.arcSegmentCount * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-arcs`, this.arcSegmentCount * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    
    // Initialize arc segments between nearby rollers
    this.updateEnergyArcs(true);
  }
  
  updateEnergyArcs(initial = false) {
    if (!this.arcSegments) return;
    
    const arcData = new Float32Array(this.arcSegmentCount * 8);
    const time = this.visualizer.time;
    
    // Only update arcs periodically for performance
    if (!initial && time - this.lastArcTime < 0.1) return;
    this.lastArcTime = time;
    
    // Ring configurations
    const rings = [
      { count: 8, radius: 2.5 },
      { count: 12, radius: 4.0 },
      { count: 16, radius: 5.5 }
    ];
    
    let arcIdx = 0;
    for (const ring of rings) {
      if (arcIdx >= this.arcSegmentCount) break;
      
      // Create arcs between adjacent rollers
      for (let i = 0; i < ring.count && arcIdx < this.arcSegmentCount; i++) {
        const angle1 = (i / ring.count) * Math.PI * 2 + time * 0.5;
        const angle2 = ((i + 1) / ring.count) * Math.PI * 2 + time * 0.5;
        
        // Random chance to show arc based on proximity
        const arcChance = Math.random();
        if (arcChance > 0.3) continue; // 30% chance of arc
        
        const idx = arcIdx * 8;
        
        // Start position
        arcData[idx] = Math.cos(angle1) * ring.radius;
        arcData[idx + 1] = (Math.random() - 0.5) * 1.5;
        arcData[idx + 2] = Math.sin(angle1) * ring.radius;
        
        // End position
        arcData[idx + 3] = Math.cos(angle2) * ring.radius;
        arcData[idx + 4] = arcData[idx + 1] + (Math.random() - 0.5) * 0.5;
        arcData[idx + 5] = Math.sin(angle2) * ring.radius;
        
        // Intensity with flicker
        arcData[idx + 6] = (0.5 + Math.random() * 0.5) * (Math.sin(time * 20 + i) * 0.3 + 0.7);
        
        // Width
        arcData[idx + 7] = 0.02 + Math.random() * 0.03;
        
        arcIdx++;
      }
    }
    
    this.device.queue.writeBuffer(this.arcSegments, 0, arcData);
  }
  
  update(deltaTime, qualityScale) {
    // Scale particle count by quality
    const scaledParticleCount = Math.floor(this.particleCount * qualityScale);
    
    const deviceData = new Float32Array([...this.position, Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0, 1.0, this.id === 'heron' ? 1 : (this.id === 'kelvin' ? 2 : 0), 0, 0]);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
    
    if (this.id === 'seg' && this.rollerInstances) {
      // 3-ring SEG system based on John Searl's design
      const instanceData = new Float32Array(36 * 8);
      const time = this.visualizer.time;
      
      // Ring specifications
      const rings = [
        { count: 8, radius: 2.5, scale: 0.6, speed: 2.0, index: 0 },   // Inner ring - fastest
        { count: 12, radius: 4.0, scale: 0.8, speed: 1.0, index: 1 },  // Middle ring - current
        { count: 16, radius: 5.5, scale: 1.0, speed: 0.5, index: 2 }   // Outer ring - slowest
      ];
      
      let rollerOffset = 0;
      
      for (const ring of rings) {
        for (let i = 0; i < ring.count; i++) {
          // Orbital position around the central axis
          const angle = (i / ring.count) * Math.PI * 2 + time * 0.5 * ring.speed;
          
          // Position in toroidal ring
          instanceData[rollerOffset * 8] = Math.cos(angle) * ring.radius;     // x
          instanceData[rollerOffset * 8 + 1] = 0;                              // y
          instanceData[rollerOffset * 8 + 2] = Math.sin(angle) * ring.radius;  // z
          
          // Roller self-rotation (gear-like rolling motion)
          // Self-rotation = orbital_angle * (ring_radius / roller_radius)
          // roller_radius is proportional to scale, so gear ratio = ring_radius / scale
          const gearRatio = ring.radius / ring.scale;
          const selfRotAngle = angle * gearRatio * 0.5;
          
          // Quaternion for self-rotation (around Y axis)
          instanceData[rollerOffset * 8 + 3] = ring.index;                     // ringIndex (stored in position.w or use separate field)
          instanceData[rollerOffset * 8 + 4] = Math.sin(selfRotAngle / 2);     // rotation.x
          instanceData[rollerOffset * 8 + 5] = 0;                              // rotation.y
          instanceData[rollerOffset * 8 + 6] = Math.sin(selfRotAngle / 2);     // rotation.z (roll around tangent)
          instanceData[rollerOffset * 8 + 7] = Math.cos(selfRotAngle / 2);     // rotation.w
          
          // Calculate proper rotation quaternion for rolling motion
          // The roller should roll around its own axis tangent to the ring
          const tangentAngle = angle + Math.PI / 2; // tangent to the ring
          const rollAxisX = Math.cos(tangentAngle);
          const rollAxisZ = Math.sin(tangentAngle);
          
          // Update rotation: around tangent axis for rolling
          instanceData[rollerOffset * 8 + 3] = ring.index;                     // ringIndex
          instanceData[rollerOffset * 8 + 4] = rollAxisX * Math.sin(selfRotAngle / 2);
          instanceData[rollerOffset * 8 + 5] = 0;
          instanceData[rollerOffset * 8 + 6] = rollAxisZ * Math.sin(selfRotAngle / 2);
          instanceData[rollerOffset * 8 + 7] = Math.cos(selfRotAngle / 2);
          
          rollerOffset++;
        }
      }
      this.device.queue.writeBuffer(this.rollerInstances, 0, instanceData);
      
      // Update pickup coil energy levels based on roller positions
      this.updatePickupCoilEnergies(instanceData);
    }
  }
  
  updatePickupCoilEnergies(rollerData) {
    if (!this.coilInstances) return;
    
    const numCoils = 24;
    const coilRadius = 7.0;
    
    // Initialize coil energies array if needed
    if (!this.coilEnergies) {
      this.coilEnergies = new Float32Array(numCoils);
    }
    
    // Coil data packed as vec4f pairs for the shader:
    // vec4f[0] = (position.xyz, rotation.x)
    // vec4f[1] = (rotation.yzw, energy)
    // Total: 2 vec4f = 8 floats per coil = 32 bytes per coil
    const coilInstanceData = new Float32Array(numCoils * 8);
    
    for (let i = 0; i < numCoils; i++) {
      const coilAngle = (i / numCoils) * Math.PI * 2;
      const coilX = Math.cos(coilAngle) * coilRadius;
      const coilZ = Math.sin(coilAngle) * coilRadius;
      
      // Find nearest roller and calculate energy
      let minDistance = Infinity;
      let nearestRollerSpeed = 0;
      
      // Check all 36 rollers (3 rings: 8 + 12 + 16)
      for (let r = 0; r < 36; r++) {
        const rollerX = rollerData[r * 8];
        const rollerZ = rollerData[r * 8 + 2];
        
        const dx = coilX - rollerX;
        const dz = coilZ - rollerZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist < minDistance) {
          minDistance = dist;
          // Ring speed factors: inner=2.0, middle=1.0, outer=0.5
          if (r < 8) nearestRollerSpeed = 2.0;
          else if (r < 20) nearestRollerSpeed = 1.0;
          else nearestRollerSpeed = 0.5;
        }
      }
      
      // Calculate energy: higher when rollers are closer, modulated by roller speed
      // Energy falls off with distance
      const energy = Math.max(0, 1 - minDistance / 3.0) * nearestRollerSpeed * 0.5;
      
      // Smooth energy transition
      this.coilEnergies[i] = this.coilEnergies[i] * 0.9 + energy * 0.1;
      
      // Rotation: face inward (toward center)
      // For a rotation around Y axis by angle = coilAngle + PI (180 degrees to face inward)
      const rotAngle = coilAngle + Math.PI;
      const rotY = Math.sin(rotAngle / 2);  // sin of half angle for Y component
      const rotW = Math.cos(rotAngle / 2);  // cos of half angle for W component
      
      // Pack data into two vec4f:
      // data0: position.xyz, rotation.x
      coilInstanceData[i * 8] = coilX;           // position.x
      coilInstanceData[i * 8 + 1] = 0;           // position.y
      coilInstanceData[i * 8 + 2] = coilZ;       // position.z
      coilInstanceData[i * 8 + 3] = 0;           // rotation.x (not used for Y-axis rotation)
      
      // data1: rotation.yzw, energy
      coilInstanceData[i * 8 + 4] = rotY;        // rotation.y
      coilInstanceData[i * 8 + 5] = 0;           // rotation.z
      coilInstanceData[i * 8 + 6] = rotW;        // rotation.w
      coilInstanceData[i * 8 + 7] = this.coilEnergies[i]; // energy
    }
    
    this.device.queue.writeBuffer(this.coilInstances, 0, coilInstanceData);
    
    // Update field line particles
    if (this.fieldLineParticles && this.fieldLineEnabled) {
      this.updateFieldLines(0.016);
    }
    
    // Update energy arcs
    if (this.arcSegments && this.energyArcEnabled) {
      this.updateEnergyArcs();
    }
  }
  
  updateFieldLines(deltaTime) {
    // Animate field line particles flowing along magnetic field lines
    const fieldData = new Float32Array(this.fieldLineCount * 8);
    const time = this.visualizer.time;
    
    for (let i = 0; i < this.fieldLineCount; i++) {
      const idx = i * 8;
      
      // Get ring for this particle
      const ringIdx = i % 3;
      const ringRadii = [2.5, 4.0, 5.5];
      const ringRadius = ringRadii[ringIdx];
      
      // Flow along circular magnetic field line
      const baseAngle = (i / this.fieldLineCount) * Math.PI * 20 + time * (0.5 + ringIdx * 0.3);
      const heightOffset = Math.sin(time * 0.5 + i * 0.1) * 0.8;
      
      // Position along magnetic field line
      fieldData[idx] = Math.cos(baseAngle) * ringRadius;
      fieldData[idx + 1] = heightOffset + (Math.random() - 0.5) * 0.2;
      fieldData[idx + 2] = Math.sin(baseAngle) * ringRadius;
      
      // Velocity tangent to field line
      const speed = 1.0 + ringIdx * 0.5;
      fieldData[idx + 3] = -Math.sin(baseAngle) * speed;
      fieldData[idx + 4] = Math.cos(time * 2 + i * 0.05) * 0.1;
      fieldData[idx + 5] = Math.cos(baseAngle) * speed;
      
      // Life cycles through 0-1
      fieldData[idx + 6] = (Math.sin(time * 2 + i * 0.5) * 0.5 + 0.5);
      
      // Strength varies by position
      fieldData[idx + 7] = 0.3 + 0.7 * Math.sin(baseAngle * 3 + time);
    }
    
    this.device.queue.writeBuffer(this.fieldLineParticles, 0, fieldData);
  }
  
  render(renderPass, globalUniformBuffer, skipEffects = false) {
    const scaledCount = Math.floor(this.particleCount * this.visualizer.profiler.qualityLevel);
    
    // Render core first (before rollers so rollers appear in front)
    if (this.id === 'seg' && !skipEffects) {
      this.renderCore(renderPass, globalUniformBuffer);
    }
    
    // Render pickup coils (outside the roller ring)
    if (this.id === 'seg' && !skipEffects) {
      this.renderPickupCoils(renderPass, globalUniformBuffer);
    }
    
    if (this.id === 'seg' && this.rollerInstances && !skipEffects) {
      const bindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.rollerInstances } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } }
        ]
      });
      
      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.cylinderBuffer.indexCount, 36); // 3 rings: 8 + 12 + 16 = 36 rollers
    }
    
    // Render field lines (before particles for proper blending)
    if (this.id === 'seg' && this.fieldLineParticles && this.fieldLineEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      const fieldLineCount = Math.floor(this.fieldLineCount * qualityScale);
      
      const fieldLineBindGroup = this.device.createBindGroup({
        layout: this.fieldLinePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 4, resource: { buffer: this.fieldLineParticles } }
        ]
      });
      
      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(0, fieldLineBindGroup);
      renderPass.draw(4, fieldLineCount);
    }
    
    // Render energy arcs (between nearby rollers)
    if (this.id === 'seg' && this.arcSegments && this.energyArcEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      if (qualityScale > 0.5) {
        const arcCount = Math.floor(this.arcSegmentCount * qualityScale);
        
        const arcBindGroup = this.device.createBindGroup({
          layout: this.energyArcPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: globalUniformBuffer } },
            { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
            { binding: 4, resource: { buffer: this.arcSegments } }
          ]
        });
        
        renderPass.setPipeline(this.energyArcPipeline);
        renderPass.setBindGroup(0, arcBindGroup);
        renderPass.draw(4, arcCount * 2); // Each arc uses 2 triangles
      }
    }
    
    const particleBindGroup = this.device.createBindGroup({
      layout: this.particlePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 4, resource: { buffer: this.particles } }
      ]
    });
    
    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(0, particleBindGroup);
    renderPass.draw(4, scaledCount);
  }
  
  renderCore(renderPass, globalUniformBuffer) {
    if (!this.corePipeline || !this.config.core) return;
    
    const coreBindGroup = this.device.createBindGroup({
      layout: this.corePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 3, resource: { buffer: this.coreMaterialBuffer } }
      ]
    });
    
    renderPass.setPipeline(this.corePipeline);
    renderPass.setBindGroup(0, coreBindGroup);
    
    const v = this.visualizer;
    
    // Render central shaft
    renderPass.setVertexBuffer(0, v.coreShaftBuffer.vertexBuffer);
    renderPass.setVertexBuffer(1, v.coreBoltInstanceBuffer); // Dummy, won't be used
    renderPass.setIndexBuffer(v.coreShaftBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.coreShaftBuffer.indexCount, 1);
    
    // Render magnetic core (central cylinder)
    renderPass.setVertexBuffer(0, v.coreMagnetBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.coreMagnetBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.coreMagnetBuffer.indexCount, 1);
    
    // Render top plate
    const plateOffsetTop = new Float32Array([0, this.config.core.plateY, 0]);
    const plateOffsetBottom = new Float32Array([0, -this.config.core.plateY, 0]);
    
    // Top plate - create temp buffer for offset
    const topPlateBuffer = this.device.createBuffer({
      size: 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(topPlateBuffer, 0, plateOffsetTop);
    
    renderPass.setVertexBuffer(0, v.corePlateBuffer.vertexBuffer);
    renderPass.setVertexBuffer(1, topPlateBuffer);
    renderPass.setIndexBuffer(v.corePlateBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.corePlateBuffer.indexCount, 1);
    topPlateBuffer.destroy();
    
    // Bottom plate
    const bottomPlateBuffer = this.device.createBuffer({
      size: 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(bottomPlateBuffer, 0, plateOffsetBottom);
    
    renderPass.setVertexBuffer(1, bottomPlateBuffer);
    renderPass.drawIndexed(v.corePlateBuffer.indexCount, 1);
    bottomPlateBuffer.destroy();
    
    // Render bolts (instanced)
    renderPass.setVertexBuffer(0, v.coreBoltBuffer.vertexBuffer);
    renderPass.setVertexBuffer(1, v.coreBoltInstanceBuffer);
    renderPass.setIndexBuffer(v.coreBoltBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.coreBoltBuffer.indexCount, v.coreBoltPositions.length / 3);
  }
  
  renderPickupCoils(renderPass, globalUniformBuffer) {
    if (!this.coilInstances || !this.coilPipeline) return;
    
    const numCoils = 24;
    
    // Render top connection ring (at y = +2.0)
    const topRingDeviceData = new Float32Array(8);
    topRingDeviceData.set([
      this.position[0], this.position[1] + 2.0, this.position[2],
      Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0,
      0, 0
    ]);
    const topRingDeviceBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(topRingDeviceBuffer, 0, topRingDeviceData);
    
    const topRingBindGroup = this.device.createBindGroup({
      layout: this.ringPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: topRingDeviceBuffer } },
        { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
      ]
    });
    
    renderPass.setPipeline(this.ringPipeline);
    renderPass.setBindGroup(0, topRingBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);
    
    // Render bottom connection ring (at y = -2.0)
    const bottomRingDeviceData = new Float32Array(8);
    bottomRingDeviceData.set([
      this.position[0], this.position[1] - 2.0, this.position[2],
      Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0,
      0, 0
    ]);
    const bottomRingDeviceBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(bottomRingDeviceBuffer, 0, bottomRingDeviceData);
    
    const bottomRingBindGroup = this.device.createBindGroup({
      layout: this.ringPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: bottomRingDeviceBuffer } },
        { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
      ]
    });
    
    renderPass.setBindGroup(0, bottomRingBindGroup);
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);
    
    // Render coils
    const coilBindGroup = this.device.createBindGroup({
      layout: this.coilPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.coilInstances } },
        { binding: 3, resource: { buffer: this.coilMaterialBuffer } }
      ]
    });
    
    renderPass.setPipeline(this.coilPipeline);
    renderPass.setBindGroup(0, coilBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.coilBuffer.vertexBuffer);
    renderPass.draw(this.visualizer.coilBuffer.vertexCount, numCoils);
  }
}

// ============================================
// ENERGY PIPE
// ============================================
class EnergyPipe {
  constructor(device, config) {
    this.device = device;
    this.config = config;
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.pipeline = null;
  }
  
  async init() {
    // Simplified initialization
  }
  
  render(renderPass, globalUniformBuffer) {
    // Simplified rendering
  }
}

// ============================================
// INITIALIZATION
// ============================================
let visualizer;
window.addEventListener('load', () => {
  visualizer = new MultiDeviceVisualizer();
});
