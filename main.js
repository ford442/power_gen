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
    color: [0.0, 0.9, 1.0]
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
      
      this.resize();
      this.context.configure({
        device: this.device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });
      
      await this.setupGlobalResources();
      await this.setupDevices();
      await this.setupEnergyPipes();
      await this.setupFloorGrid();
      await this.setupDepthBuffer();
      
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
    
    this.globalUniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.profiler.trackBuffer('globalUniforms', 256, GPUBufferUsage.UNIFORM);
    
    this.cylinderBuffer = this.createCylinderBuffer(0.8, 2.5, 32);
    
    this.setupGlobalShaders();
    
    console.log(`Global resources setup in ${(performance.now() - startTime).toFixed(2)}ms`);
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
struct GlobalUniforms { viewProj: mat4x4f, time: f32, _pad: vec3f }
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, _pad: f32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct InstanceData { position: vec3f, rotation: vec4f }
@binding(2) @group(0) var<storage> instances: array<InstanceData>;
struct VertexOutput { @builtin(position) position: vec4f, @location(0) normal: vec3f, @location(1) worldPos: vec3f, @location(2) instanceId: f32 }
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
@vertex fn main(@location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
  var output: VertexOutput;
  let inst = instances[instanceIdx];
  let localPos = quatRotate(inst.rotation, position * device.deviceScale) + inst.position;
  let worldPos = quatRotate(device.deviceRot, localPos) + device.devicePos;
  output.position = globals.viewProj * vec4f(worldPos, 1.0);
  output.normal = quatRotate(device.deviceRot, quatRotate(inst.rotation, normal));
  output.worldPos = worldPos;
  output.instanceId = f32(instanceIdx);
  return output;
}`;

    this.rollerFragShader = `
struct GlobalUniforms { viewProj: mat4x4f, time: f32, _pad: vec3f }
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct MaterialUniforms { baseColor: vec3f, _pad1: f32, glowColor: vec3f, emission: f32 }
@binding(3) @group(0) var<uniform> material: MaterialUniforms;
@fragment fn main(@location(0) normal: vec3f, @location(1) worldPos: vec3f, @location(2) instanceId: f32) -> @location(0) vec4f {
  let n = normalize(normal);
  let viewDir = normalize(vec3f(0.0, 8.0, 18.0) - worldPos);
  let fresnel = pow(1.0 - abs(dot(n, viewDir)), 2.0);
  let fieldPattern = sin(worldPos.y * 4.0 + globals.time * 4.0) * cos(length(worldPos.xz) * 5.0 - globals.time * 3.0 + instanceId);
  let fieldGlow = material.glowColor * (fieldPattern * 0.3 + 0.5) * fresnel * material.emission;
  return vec4f(material.baseColor + fieldGlow, 1.0);
}`;

    this.particleVertShader = `
struct GlobalUniforms { viewProj: mat4x4f, time: f32, _pad: vec3f }
@binding(0) @group(0) var<uniform> globals: GlobalUniforms;
struct DeviceUniforms { devicePos: vec3f, deviceRot: vec4f, deviceScale: f32, particleType: u32 }
@binding(1) @group(0) var<uniform> device: DeviceUniforms;
struct Particle { position: vec3f, velocity: vec3f, density: f32, pressure: f32, charge: f32, life: f32 }
@binding(4) @group(0) var<storage> particles: array<Particle>;
fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
@vertex fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instanceIdx: u32) -> @builtin(position) vec4f {
  let p = particles[instanceIdx];
  let size = select(0.05, 0.08, device.particleType == 1u);
  let corners = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let corner = corners[vertIdx] * size;
  let localPos = p.position * device.deviceScale;
  let worldPos = quatRotate(device.deviceRot, localPos) + device.devicePos;
  return globals.viewProj * vec4f(worldPos + vec3f(corner, 0.0), 1.0);
}`;

    this.particleFragShader = `
struct MaterialUniforms { baseColor: vec3f, _pad1: f32, glowColor: vec3f, emission: f32 }
@binding(3) @group(0) var<uniform> material: MaterialUniforms;
@fragment fn main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let coord = pos.xy % 2.0 - vec2f(1.0);
  let dist = length(coord);
  if (dist > 1.0) { discard; }
  let alpha = (1.0 - dist) * 0.8;
  return vec4f(material.glowColor, alpha);
}`;

    this.gridVertShader = `
struct GlobalUniforms { viewProj: mat4x4f, time: f32, _pad: vec3f }
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
    
    // Update global uniforms
    const viewProj = this.getViewProjMatrix();
    const globalData = new Float32Array(32);
    globalData.set(viewProj, 0);
    globalData[16] = this.time;
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
    this.rollerPipeline = null;
    this.particlePipeline = null;
  }
  
  async init() {
    await this.setupUniforms();
    await this.setupPipelines();
    await this.setupParticles();
    
    if (this.id === 'seg') {
      await this.setupRollers();
    }
  }
  
  async setupUniforms() {
    this.deviceUniformBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.materialUniformBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    
    this.visualizer.profiler.trackBuffer(`device-${this.id}-uniforms`, 64, GPUBufferUsage.UNIFORM);
    
    const materialData = new Float32Array([...this.config.color, 0.0, 0.0, 0.9, 1.0, 0.0, 2.0, 0.0, 0.0, 0.0]);
    this.device.queue.writeBuffer(this.materialUniformBuffer, 0, materialData);
  }
  
  async setupPipelines() {
    this.rollerPipeline = this.device.createRenderPipeline({
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
      layout: 'auto',
      vertex: { module: this.device.createShaderModule({ code: this.visualizer.particleVertShader }), entryPoint: 'main' },
      fragment: { module: this.device.createShaderModule({ code: this.visualizer.particleFragShader }), entryPoint: 'main', targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' }
    });
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
    this.rollerInstances = this.device.createBuffer({
      size: 12 * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-rollers`, 12 * 32, GPUBufferUsage.STORAGE);
  }
  
  update(deltaTime, qualityScale) {
    // Scale particle count by quality
    const scaledParticleCount = Math.floor(this.particleCount * qualityScale);
    
    const deviceData = new Float32Array([...this.position, Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0, 1.0, this.id === 'heron' ? 1 : (this.id === 'kelvin' ? 2 : 0), 0, 0]);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
    
    if (this.id === 'seg' && this.rollerInstances) {
      const instanceData = new Float32Array(12 * 8);
      const ringRadius = 4.0;
      const time = this.visualizer.time;
      
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2 + time * 0.5;
        instanceData[i * 8] = Math.cos(angle) * ringRadius;
        instanceData[i * 8 + 1] = 0;
        instanceData[i * 8 + 2] = Math.sin(angle) * ringRadius;
        const rotAngle = angle + time * 2.0;
        instanceData[i * 8 + 4] = Math.sin(rotAngle / 2);
        instanceData[i * 8 + 6] = Math.cos(rotAngle / 2);
      }
      this.device.queue.writeBuffer(this.rollerInstances, 0, instanceData);
    }
  }
  
  render(renderPass, globalUniformBuffer, skipEffects = false) {
    const scaledCount = Math.floor(this.particleCount * this.visualizer.profiler.qualityLevel);
    
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
      renderPass.drawIndexed(this.visualizer.cylinderBuffer.indexCount, 12);
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
