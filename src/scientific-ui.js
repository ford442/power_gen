/**
 * SEG WebGPU Visualizer - Scientific UI Components
 * Real-time gauges and Wolfram MCP status indicators
 */

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Format a number with specified decimal places
 */
function formatNumber(value, decimals = 2) {
  return value.toFixed(decimals);
}

/**
 * Format a large number with K/M suffix
 */
function formatCompact(value) {
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  return value.toString();
}

/**
 * Clamp a value between min and max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Interpolate between two colors
 */
function lerpColor(color1, color2, factor) {
  const r1 = parseInt(color1.slice(1, 3), 16);
  const g1 = parseInt(color1.slice(3, 5), 16);
  const b1 = parseInt(color1.slice(5, 7), 16);
  
  const r2 = parseInt(color2.slice(1, 3), 16);
  const g2 = parseInt(color2.slice(3, 5), 16);
  const b2 = parseInt(color2.slice(5, 7), 16);
  
  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);
  
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ============================================
// MAGNETIC FIELD GAUGE
// ============================================

/**
 * Circular gauge displaying magnetic field magnitude (0-3 Tesla)
 * Color zones: Safe (0-0.5T), Caution (0.5-1.5T), Warning (1.5-3T)
 */
class MagneticFieldGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.value = 0;
    this.maxValue = 3.0;
    this.decimals = 3;
    this.colors = {
      safe: '#44ff44',
      caution: '#ffff00',
      warning: '#ff4444',
      background: '#1a1a2e'
    };
    this.history = new Array(60).fill(0);
    
    this.render();
    this.canvas = this.container.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.valueEl = this.container.querySelector('.sci-circular-number');
    
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height;
    this.draw();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Magnetic Flux Density</span>
      </div>
      <div class="sci-gauge-container">
        <div class="sci-circular-gauge">
          <canvas width="120" height="120"></canvas>
          <div class="sci-circular-value">
            <div class="sci-circular-number">0.000</div>
            <div class="sci-circular-unit">Tesla</div>
          </div>
        </div>
        <div class="sci-circular-zones">
          <div class="sci-zone-marker">
            <div class="sci-zone-color safe"></div>
            <span>Safe ≤0.5T</span>
          </div>
          <div class="sci-zone-marker">
            <div class="sci-zone-color caution"></div>
            <span>Caution 0.5-1.5T</span>
          </div>
          <div class="sci-zone-marker">
            <div class="sci-zone-color warning"></div>
            <span>Warning >1.5T</span>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Get color based on field strength
   */
  getColorForValue(value) {
    if (value <= 0.5) return this.colors.safe;
    if (value <= 1.5) return this.colors.caution;
    return this.colors.warning;
  }
  
  /**
   * Update the gauge value
   */
  setValue(value) {
    this.value = clamp(value, 0, this.maxValue);
    this.history.push(this.value);
    this.history.shift();
    
    // Update digital readout
    this.valueEl.textContent = formatNumber(this.value, this.decimals);
    this.valueEl.style.color = this.getColorForValue(this.value);
    
    this.draw();
  }
  
  /**
   * Draw the circular gauge
   */
  draw() {
    const ctx = this.ctx;
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    const radius = Math.min(centerX, centerY) - 10;
    const startAngle = Math.PI * 0.75;
    const endAngle = Math.PI * 2.25;
    const totalAngle = endAngle - startAngle;
    
    ctx.clearRect(0, 0, this.width, this.height);
    
    // Draw background arc
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, endAngle);
    ctx.lineWidth = 12;
    ctx.strokeStyle = this.colors.background;
    ctx.lineCap = 'round';
    ctx.stroke();
    
    // Draw zone arcs
    const safeEnd = startAngle + (0.5 / this.maxValue) * totalAngle;
    const cautionEnd = startAngle + (1.5 / this.maxValue) * totalAngle;
    
    // Safe zone
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, safeEnd);
    ctx.lineWidth = 12;
    ctx.strokeStyle = this.colors.safe;
    ctx.globalAlpha = 0.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
    
    // Caution zone
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, safeEnd, cautionEnd);
    ctx.lineWidth = 12;
    ctx.strokeStyle = this.colors.caution;
    ctx.globalAlpha = 0.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
    
    // Warning zone
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, cautionEnd, endAngle);
    ctx.lineWidth = 12;
    ctx.strokeStyle = this.colors.warning;
    ctx.globalAlpha = 0.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
    
    // Draw value arc
    const valueAngle = startAngle + (this.value / this.maxValue) * totalAngle;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, valueAngle);
    ctx.lineWidth = 12;
    ctx.strokeStyle = this.getColorForValue(this.value);
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 15;
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    // Draw tick marks
    for (let i = 0; i <= 6; i++) {
      const angle = startAngle + (i / 6) * totalAngle;
      const tickStart = radius - 18;
      const tickEnd = radius - 8;
      ctx.beginPath();
      ctx.moveTo(centerX + Math.cos(angle) * tickStart, centerY + Math.sin(angle) * tickStart);
      ctx.lineTo(centerX + Math.cos(angle) * tickEnd, centerY + Math.sin(angle) * tickEnd);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#444';
      ctx.stroke();
    }
    
    // Draw needle
    const needleLength = radius - 20;
    const needleX = centerX + Math.cos(valueAngle) * needleLength;
    const needleY = centerY + Math.sin(valueAngle) * needleLength;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(needleX, needleY);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    
    // Draw center dot
    ctx.beginPath();
    ctx.arc(centerX, centerY, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}

// ============================================
// ENERGY DENSITY GAUGE
// ============================================

/**
 * Vertical bar gauge showing energy density in kJ/m³
 * Range: 0-900 kJ/m³ (based on Wolfram max of 871,532 J/m³)
 * Gradient fill from blue to red
 */
class EnergyDensityGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.value = 0;
    this.maxValue = 900; // kJ/m³
    this.decimals = 1;
    
    this.render();
    this.valueEl = this.container.querySelector('.sci-gauge-value');
    this.barEl = this.container.querySelector('.sci-bar-fill');
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Energy Density</span>
        <span class="sci-gauge-value">0.0 kJ/m³</span>
      </div>
      <div class="sci-gauge-container">
        <div class="sci-bar-gauge">
          <div class="sci-bar-fill energy" style="width: 0%"></div>
        </div>
        <div class="sci-bar-labels">
          <span>0</span>
          <span>225</span>
          <span>450</span>
          <span>675</span>
          <span>900</span>
        </div>
      </div>
    `;
  }
  
  /**
   * Update the gauge value
   * @param {number} value - Energy density in kJ/m³
   */
  setValue(value) {
    this.value = clamp(value, 0, this.maxValue);
    const percentage = (this.value / this.maxValue) * 100;
    
    this.barEl.style.width = percentage + '%';
    this.valueEl.textContent = formatNumber(this.value, this.decimals) + ' kJ/m³';
    
    // Update color based on value
    if (this.value < 300) {
      this.valueEl.className = 'sci-gauge-value';
    } else if (this.value < 600) {
      this.valueEl.className = 'sci-gauge-value warning';
    } else {
      this.valueEl.className = 'sci-gauge-value danger';
    }
  }
}

// ============================================
// TORQUE GAUGE
// ============================================

/**
 * Dual gauge showing torque on inner and outer rings
 * Units: N·m
 * Real-time animation synchronized with simulation
 */
class TorqueGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.innerTorque = 0;
    this.outerTorque = 0;
    this.maxTorque = 50; // N·m
    this.decimals = 1;
    
    this.render();
    this.innerValueEl = this.container.querySelector('.sci-torque-value[data-ring="inner"]');
    this.outerValueEl = this.container.querySelector('.sci-torque-value[data-ring="outer"]');
    this.innerBarEl = this.container.querySelector('.sci-torque-bar[data-ring="inner"]');
    this.outerBarEl = this.container.querySelector('.sci-torque-bar[data-ring="outer"]');
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Torque (Inner & Outer Rings)</span>
      </div>
      <div class="sci-gauge-container">
        <div class="sci-torque-gauge">
          <div class="sci-torque-ring">
            <span class="sci-torque-label">Inner</span>
            <div class="sci-torque-visual">
              <div class="sci-torque-center"></div>
              <div class="sci-torque-bar left" data-ring="inner" style="width: 0%"></div>
              <div class="sci-torque-bar right" data-ring="inner" style="width: 0%"></div>
            </div>
            <span class="sci-torque-value" data-ring="inner">0.0 N·m</span>
          </div>
          <div class="sci-torque-ring">
            <span class="sci-torque-label">Outer</span>
            <div class="sci-torque-visual">
              <div class="sci-torque-center"></div>
              <div class="sci-torque-bar left" data-ring="outer" style="width: 0%"></div>
              <div class="sci-torque-bar right" data-ring="outer" style="width: 0%"></div>
            </div>
            <span class="sci-torque-value" data-ring="outer">0.0 N·m</span>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Update torque values
   * @param {number} inner - Inner ring torque in N·m
   * @param {number} outer - Outer ring torque in N·m
   */
  setValues(inner, outer) {
    this.innerTorque = inner;
    this.outerTorque = outer;
    
    this.updateRing('inner', inner);
    this.updateRing('outer', outer);
  }
  
  updateRing(ring, value) {
    const absValue = Math.abs(value);
    const percentage = Math.min((absValue / this.maxTorque) * 50, 50);
    const direction = value >= 0 ? 'right' : 'left';
    
    const valueEl = this.container.querySelector(`.sci-torque-value[data-ring="${ring}"]`);
    const leftBar = this.container.querySelector(`.sci-torque-bar.left[data-ring="${ring}"]`);
    const rightBar = this.container.querySelector(`.sci-torque-bar.right[data-ring="${ring}"]`);
    
    valueEl.textContent = formatNumber(value, this.decimals) + ' N·m';
    
    if (direction === 'left') {
      leftBar.style.width = percentage + '%';
      rightBar.style.width = '0%';
    } else {
      leftBar.style.width = '0%';
      rightBar.style.width = percentage + '%';
    }
  }
}

// ============================================
// PARTICLE FLUX GAUGE
// ============================================

/**
 * Flow rate visualization with sparkline graph
 */
class ParticleFluxGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.rate = 0;
    this.maxRate = 50000;
    this.historyLength = 60;
    this.history = new Array(this.historyLength).fill(0);
    
    this.render();
    this.canvas = this.container.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.rateEl = this.container.querySelector('.sci-flux-rate');
    
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  
  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height;
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Particle Flux</span>
      </div>
      <div class="sci-gauge-container">
        <div class="sci-flux-gauge">
          <div class="sci-flux-header">
            <span class="sci-flux-rate">≈ 0 p/s</span>
            <span class="sci-flux-particles">● real-time</span>
          </div>
          <div class="sci-flux-sparkline">
            <canvas></canvas>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Update the flux rate
   * @param {number} rate - Particles per second
   */
  setRate(rate) {
    this.rate = Math.max(0, rate);
    this.history.push(this.rate);
    this.history.shift();
    
    this.rateEl.textContent = '≈ ' + formatCompact(this.rate) + ' p/s';
    this.drawSparkline();
  }
  
  drawSparkline() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    
    if (this.history.every(v => v === 0)) return;
    
    const max = Math.max(...this.history, this.maxRate * 0.1);
    const min = 0;
    const range = max - min;
    
    // Draw gradient area
    ctx.beginPath();
    ctx.moveTo(0, this.height);
    
    this.history.forEach((value, i) => {
      const x = (i / (this.historyLength - 1)) * this.width;
      const y = this.height - ((value - min) / range) * (this.height - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    
    ctx.lineTo(this.width, this.height);
    ctx.closePath();
    
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, 'rgba(0, 255, 255, 0.4)');
    gradient.addColorStop(1, 'rgba(0, 255, 255, 0.05)');
    ctx.fillStyle = gradient;
    ctx.fill();
    
    // Draw line
    ctx.beginPath();
    this.history.forEach((value, i) => {
      const x = (i / (this.historyLength - 1)) * this.width;
      const y = this.height - ((value - min) / range) * (this.height - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Draw current value dot
    const lastY = this.height - ((this.rate - min) / range) * (this.height - 4) - 2;
    ctx.beginPath();
    ctx.arc(this.width, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#00ffff';
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

// ============================================
// WOLFRAM STATUS PANEL
// ============================================

/**
 * MCP connection status, cache stats, and query log
 */
class WolframStatusPanel {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.status = 'disconnected'; // connected, fallback, disconnected
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.lastQueryTime = null;
    this.dataSource = 'fallback'; // wolfram, cached, fallback
    this.queryLog = [];
    this.maxLogEntries = 5;
    
    this.render();
    this.statusEl = this.container.querySelector('.sci-status-dot');
    this.statusTextEl = this.container.querySelector('.sci-status-text');
    this.statusDetailEl = this.container.querySelector('.sci-status-detail');
    this.sourceEl = this.container.querySelector('.sci-data-source');
    this.cacheHitsEl = this.container.querySelector('.sci-cache-hits');
    this.cacheMissesEl = this.container.querySelector('.sci-cache-misses');
    this.lastUpdateEl = this.container.querySelector('.sci-last-update');
    this.logEl = this.container.querySelector('.sci-query-log');
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-section">
        <div class="sci-wolfram-status">
          <div class="sci-status-indicator">
            <div class="sci-status-dot disconnected"></div>
            <div>
              <div class="sci-status-text">Wolfram MCP Disconnected</div>
              <div class="sci-status-detail">Using estimated values ⚠️</div>
            </div>
          </div>
          <span class="sci-data-source">Fallback</span>
        </div>
      </div>
      
      <div class="sci-cache-status">
        <div class="sci-cache-stats">
          <span class="sci-cache-hits">0</span> hits | <span class="sci-cache-misses">0</span> misses
        </div>
        <div class="sci-last-update">--</div>
      </div>
      
      <div class="sci-query-log"></div>
    `;
  }
  
  /**
   * Update connection status
   */
  setStatus(status, message = null) {
    this.status = status;
    
    this.statusEl.className = 'sci-status-dot ' + status;
    
    const statusMap = {
      connected: { text: 'Wolfram MCP Connected', detail: 'Real-time queries active' },
      fallback: { text: 'Wolfram MCP Limited', detail: 'Using cached values' },
      disconnected: { text: 'Wolfram MCP Disconnected', detail: 'Using estimated values ⚠️' }
    };
    
    const info = statusMap[status];
    this.statusTextEl.textContent = message || info.text;
    this.statusDetailEl.textContent = info.detail;
  }
  
  /**
   * Set current data source
   */
  setDataSource(source) {
    this.dataSource = source;
    const sourceLabels = {
      wolfram: 'Wolfram',
      cached: 'Cached',
      fallback: 'Fallback'
    };
    this.sourceEl.textContent = sourceLabels[source] || 'Unknown';
  }
  
  /**
   * Update cache statistics
   */
  updateCacheStats(hits, misses) {
    this.cacheHits = hits;
    this.cacheMisses = misses;
    this.cacheHitsEl.textContent = hits;
    this.cacheMissesEl.textContent = misses;
  }
  
  /**
   * Record a cache hit
   */
  recordHit() {
    this.cacheHits++;
    this.cacheHitsEl.textContent = this.cacheHits;
    this.lastQueryTime = Date.now();
    this.updateLastUpdate();
  }
  
  /**
   * Record a cache miss
   */
  recordMiss() {
    this.cacheMisses++;
    this.cacheMissesEl.textContent = this.cacheMisses;
    this.lastQueryTime = Date.now();
    this.updateLastUpdate();
  }
  
  /**
   * Add entry to query log
   */
  addLogEntry(query, status) {
    const entry = {
      time: new Date(),
      query: query,
      status: status // hit, miss, error
    };
    
    this.queryLog.unshift(entry);
    if (this.queryLog.length > this.maxLogEntries) {
      this.queryLog.pop();
    }
    
    this.renderLog();
  }
  
  renderLog() {
    this.logEl.innerHTML = this.queryLog.map(entry => {
      const timeStr = entry.time.toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit',
        second: '2-digit'
      });
      const shortQuery = entry.query.length > 25 
        ? entry.query.substring(0, 22) + '...' 
        : entry.query;
      
      return `
        <div class="sci-query-entry">
          <span class="sci-query-time">${timeStr}</span>
          <span class="sci-query-status ${entry.status}"></span>
          <span class="sci-query-text" title="${entry.query}">${shortQuery}</span>
        </div>
      `;
    }).join('');
  }
  
  updateLastUpdate() {
    if (!this.lastQueryTime) {
      this.lastUpdateEl.textContent = '--';
      return;
    }
    
    const seconds = ((Date.now() - this.lastQueryTime) / 1000).toFixed(2);
    this.lastUpdateEl.textContent = seconds + 's ago';
  }
  
  /**
   * Start periodic update of "last update" text
   */
  startUpdateLoop() {
    setInterval(() => this.updateLastUpdate(), 100);
  }
}

// ============================================
// SCIENTIFIC UI MANAGER
// ============================================

/**
 * Main manager coordinating all scientific UI components
 */
class ScientificUIManager {
  constructor(options = {}) {
    this.options = {
      panelId: 'scientific-panel',
      showToggle: true,
      ...options
    };
    
    this.panel = null;
    this.gauges = {};
    this.wolframPanel = null;
    this.isVisible = false;
    this.cache = new Map();
    
    this.init();
  }
  
  init() {
    this.createPanel();
    if (this.options.showToggle) {
      this.createToggleButton();
    }
    this.initGauges();
  }
  
  createPanel() {
    // Check if panel already exists
    let panel = document.getElementById(this.options.panelId);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = this.options.panelId;
      panel.className = 'sci-panel collapsed';
      document.body.appendChild(panel);
    }
    
    this.panel = panel;
    this.panel.innerHTML = `
      <div class="sci-panel-header">
        <div class="sci-panel-title">
          <span class="sci-panel-icon">🔬</span>
          <span>SEG Physics Monitor</span>
        </div>
        <div class="sci-panel-controls">
          <button class="sci-panel-btn" id="sci-collapse-btn" title="Collapse">−</button>
        </div>
      </div>
      <div class="sci-panel-content">
        <div id="sci-wolfram-status"></div>
        <div id="sci-magnetic-gauge"></div>
        <div id="sci-energy-gauge"></div>
        <div id="sci-torque-gauge"></div>
        <div id="sci-flux-gauge"></div>
      </div>
    `;
    
    // Setup collapse button
    this.panel.querySelector('#sci-collapse-btn').addEventListener('click', () => {
      this.hide();
    });
    
    // Setup drag
    this.setupDrag();
  }
  
  createToggleButton() {
    const toggle = document.createElement('button');
    toggle.id = 'sci-panel-toggle';
    toggle.className = 'sci-panel-toggle';
    toggle.innerHTML = '📊';
    toggle.title = 'Show Scientific Panel';
    toggle.addEventListener('click', () => this.show());
    document.body.appendChild(toggle);
  }
  
  setupDrag() {
    const header = this.panel.querySelector('.sci-panel-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    
    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      this.panel.classList.add('dragging');
    });
    
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      this.panel.style.left = (startLeft + dx) + 'px';
      this.panel.style.top = (startTop + dy) + 'px';
      this.panel.style.right = 'auto';
    });
    
    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.panel.classList.remove('dragging');
      }
    });
  }
  
  initGauges() {
    this.gauges.magnetic = new MagneticFieldGauge('sci-magnetic-gauge');
    this.gauges.energy = new EnergyDensityGauge('sci-energy-gauge');
    this.gauges.torque = new TorqueGauge('sci-torque-gauge');
    this.gauges.flux = new ParticleFluxGauge('sci-flux-gauge');
    
    this.wolframPanel = new WolframStatusPanel('sci-wolfram-status');
    this.wolframPanel.startUpdateLoop();
  }
  
  show() {
    this.panel.classList.remove('collapsed');
    const toggle = document.getElementById('sci-panel-toggle');
    if (toggle) toggle.classList.add('hidden');
    this.isVisible = true;
    
    // Redraw canvas gauges after becoming visible
    requestAnimationFrame(() => {
      this.gauges.magnetic.resize();
      this.gauges.flux.resize();
    });
  }
  
  hide() {
    this.panel.classList.add('collapsed');
    const toggle = document.getElementById('sci-panel-toggle');
    if (toggle) toggle.classList.remove('hidden');
    this.isVisible = false;
  }
  
  toggle() {
    if (this.isVisible) this.hide();
    else this.show();
  }
  
  // ============================================
  // DATA UPDATE METHODS
  // ============================================
  
  /**
   * Update magnetic field gauge
   * @param {number} value - Field strength in Tesla
   */
  updateMagneticField(value) {
    if (this.gauges.magnetic) {
      this.gauges.magnetic.setValue(value);
    }
  }
  
  /**
   * Update energy density gauge
   * @param {number} value - Energy density in kJ/m³
   */
  updateEnergyDensity(value) {
    if (this.gauges.energy) {
      this.gauges.energy.setValue(value);
    }
  }
  
  /**
   * Update torque gauges
   * @param {number} inner - Inner ring torque in N·m
   * @param {number} outer - Outer ring torque in N·m
   */
  updateTorque(inner, outer) {
    if (this.gauges.torque) {
      this.gauges.torque.setValues(inner, outer);
    }
  }
  
  /**
   * Update particle flux gauge
   * @param {number} rate - Particles per second
   */
  updateParticleFlux(rate) {
    if (this.gauges.flux) {
      this.gauges.flux.setRate(rate);
    }
  }
  
  /**
   * Update all field data at once
   * @param {Object} data - Field statistics object
   */
  updateFieldData(data) {
    if (data.magneticField !== undefined) {
      this.updateMagneticField(data.magneticField);
    }
    if (data.energyDensity !== undefined) {
      this.updateEnergyDensity(data.energyDensity);
    }
    if (data.torqueInner !== undefined || data.torqueOuter !== undefined) {
      this.updateTorque(data.torqueInner || 0, data.torqueOuter || 0);
    }
    if (data.particleFlux !== undefined) {
      this.updateParticleFlux(data.particleFlux);
    }
  }
  
  /**
   * Update Wolfram MCP status
   * @param {Object} status - Status information
   */
  updateWolframStatus(status) {
    if (!this.wolframPanel) return;
    
    if (status.state) {
      this.wolframPanel.setStatus(status.state, status.message);
    }
    if (status.dataSource) {
      this.wolframPanel.setDataSource(status.dataSource);
    }
    if (status.cacheHits !== undefined && status.cacheMisses !== undefined) {
      this.wolframPanel.updateCacheStats(status.cacheHits, status.cacheMisses);
    }
  }
  
  /**
   * Cache a Wolfram query result
   * @param {string} query - The query string
   * @param {any} result - The result to cache
   */
  cacheQueryResult(query, result) {
    this.cache.set(query, {
      result: result,
      timestamp: Date.now()
    });
  }
  
  /**
   * Get cached result if available and not expired
   * @param {string} query - The query string
   * @param {number} maxAge - Maximum age in milliseconds (default 5 minutes)
   * @returns {any|null} - Cached result or null
   */
  getCachedResult(query, maxAge = 300000) {
    const entry = this.cache.get(query);
    if (!entry) {
      this.wolframPanel?.recordMiss();
      return null;
    }
    
    if (Date.now() - entry.timestamp > maxAge) {
      this.cache.delete(query);
      this.wolframPanel?.recordMiss();
      return null;
    }
    
    this.wolframPanel?.recordHit();
    this.wolframPanel?.addLogEntry(query, 'hit');
    return entry.result;
  }
  
  /**
   * Clear the query cache
   */
  clearCache() {
    this.cache.clear();
    this.wolframPanel?.updateCacheStats(0, 0);
  }
  
  /**
   * Get current cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      hits: this.wolframPanel?.cacheHits || 0,
      misses: this.wolframPanel?.cacheMisses || 0
    };
  }
}

// ============================================
// EXPORT
// ============================================

export { 
  ScientificUIManager, 
  MagneticFieldGauge, 
  EnergyDensityGauge, 
  TorqueGauge, 
  ParticleFluxGauge,
  WolframStatusPanel 
};

// Default export for convenience
export default ScientificUIManager;
