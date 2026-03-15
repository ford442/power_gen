/**
 * SEG WebGPU Visualizer - Scientific UI Components
 * Real-time gauges and Wolfram MCP status indicators
 * Enhanced with LED + Solar Cell monitoring gauges
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

/**
 * Format current with sign and unit
 */
function formatCurrent(mA) {
  const sign = mA >= 0 ? '+' : '';
  return `${sign}${mA.toFixed(0)}mA`;
}

// ============================================
// LED + SOLAR CONSTANTS
// ============================================

const LED_SOLAR_CONSTANTS = {
  // Battery: Li-ion 3.0V (0%) to 4.2V (100%)
  BATTERY: {
    VOLTAGE_MIN: 3.0,
    VOLTAGE_MAX: 4.2,
    VOLTAGE_NOMINAL: 3.7,
    TEMP_MIN: -20,
    TEMP_MAX: 60,
    TEMP_OPTIMAL: 25,
  },
  
  // Solar Panel: AM1.5G standard = 1000 W/m²
  SOLAR: {
    IRRADIANCE_MAX: 1200,
    IRRADIANCE_STANDARD: 1000, // AM1.5G
    EFFICIENCY_MIN: 0.15,
    EFFICIENCY_MAX: 0.26,
  },
  
  // LED Forward Voltages by color
  LED: {
    RED: { vf: 2.0, wavelength: 625, lumensPerWatt: 120 },
    GREEN: { vf: 3.2, wavelength: 525, lumensPerWatt: 180 },
    BLUE: { vf: 3.3, wavelength: 470, lumensPerWatt: 70 },
    WHITE: { vf: 3.5, wavelength: null, lumensPerWatt: 150 },
    YELLOW: { vf: 2.1, wavelength: 590, lumensPerWatt: 130 },
  },
  
  // Energy Flow Efficiency Chain
  EFFICIENCY: {
    BATTERY_DISCHARGE: 0.95,
    LED_CONVERSION: 0.30,
    TRANSMISSION: 0.85,
    SOLAR_CONVERSION: 0.22,
    BATTERY_CHARGE: 0.95,
    get ROUND_TRIP() {
      return this.BATTERY_DISCHARGE * this.LED_CONVERSION * 
             this.TRANSMISSION * this.SOLAR_CONVERSION * this.BATTERY_CHARGE;
    }
  }
};

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
// BATTERY GAUGE
// ============================================

/**
 * Circular battery indicator showing:
 * - Charge percentage (0-100%)
 * - Voltage (3.0V - 4.2V for Li-ion)
 * - Current flow (charging/discharging)
 * - Temperature indicator
 * - Sparkline: charge history (last 60 seconds)
 */
class BatteryGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.chargePercent = 50;
    this.voltage = 3.7;
    this.current = 0; // positive = charging, negative = discharging
    this.temperature = 25;
    this.history = new Array(60).fill(50); // 60 seconds of history
    
    this.constants = LED_SOLAR_CONSTANTS.BATTERY;
    this.colors = {
      low: '#ff4444',
      med: '#ffaa00',
      high: '#44ff44',
      background: '#1a1a2e',
      charging: '#00ff00',
      discharging: '#ff6600'
    };
    
    this.render();
    this.canvas = this.container.querySelector('.battery-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.sparklineCanvas = this.container.querySelector('.sparkline-canvas');
    this.sparklineCtx = this.sparklineCanvas.getContext('2d');
    
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
    
    const sparkRect = this.sparklineCanvas.parentElement.getBoundingClientRect();
    this.sparklineCanvas.width = sparkRect.width * dpr;
    this.sparklineCanvas.height = sparkRect.height * dpr;
    this.sparklineCtx.scale(dpr, dpr);
    this.sparkWidth = sparkRect.width;
    this.sparkHeight = sparkRect.height;
    
    this.draw();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Li-ion Battery</span>
        <span class="sci-gauge-value battery-value">50%</span>
      </div>
      <div class="sci-gauge-container battery-gauge">
        <div class="battery-main">
          <div class="battery-circular">
            <canvas class="battery-canvas" width="100" height="100"></canvas>
            <div class="battery-icon">
              <div class="battery-level">
                <div class="battery-fill" style="height: 50%"></div>
              </div>
            </div>
          </div>
          <div class="battery-readout">
            <div class="battery-percentage">50%</div>
            <div class="battery-voltage">3.70V</div>
            <div class="battery-current">+0mA</div>
          </div>
        </div>
        <div class="battery-details">
          <div class="battery-temp">
            <span class="temp-icon">🌡️</span>
            <span class="temp-value">25°C</span>
          </div>
          <div class="battery-sparkline">
            <canvas class="sparkline-canvas"></canvas>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Get color based on charge percentage
   */
  getColorForCharge(percent) {
    if (percent <= 20) return this.colors.low;
    if (percent <= 50) return this.colors.med;
    return this.colors.high;
  }
  
  /**
   * Get color based on temperature
   */
  getColorForTemp(temp) {
    if (temp < 0 || temp > 50) return '#ff4444';
    if (temp < 10 || temp > 40) return '#ffaa00';
    return '#44ff44';
  }
  
  /**
   * Update battery state
   * @param {Object} state - Battery state
   * @param {number} state.chargePercent - 0-100%
   * @param {number} state.voltage - Volts
   * @param {number} state.current - mA (positive=charging, negative=discharging)
   * @param {number} state.temperature - Celsius
   */
  updateState(state) {
    this.chargePercent = clamp(state.chargePercent ?? 50, 0, 100);
    this.voltage = clamp(state.voltage ?? 3.7, this.constants.VOLTAGE_MIN, this.constants.VOLTAGE_MAX);
    this.current = state.current ?? 0;
    this.temperature = state.temperature ?? 25;
    
    // Update history
    this.history.push(this.chargePercent);
    this.history.shift();
    
    // Update DOM elements
    const percentEl = this.container.querySelector('.battery-percentage');
    const voltageEl = this.container.querySelector('.battery-voltage');
    const currentEl = this.container.querySelector('.battery-current');
    const tempEl = this.container.querySelector('.temp-value');
    const fillEl = this.container.querySelector('.battery-fill');
    const valueEl = this.container.querySelector('.battery-value');
    
    if (percentEl) percentEl.textContent = `${this.chargePercent.toFixed(0)}%`;
    if (voltageEl) voltageEl.textContent = `${this.voltage.toFixed(2)}V`;
    if (currentEl) {
      currentEl.textContent = formatCurrent(this.current);
      currentEl.className = 'battery-current ' + (this.current >= 0 ? 'charging' : 'discharging');
    }
    if (tempEl) {
      tempEl.textContent = `${this.temperature.toFixed(0)}°C`;
      tempEl.style.color = this.getColorForTemp(this.temperature);
    }
    if (fillEl) {
      fillEl.style.height = `${this.chargePercent}%`;
      fillEl.style.background = this.getColorForCharge(this.chargePercent);
    }
    if (valueEl) {
      valueEl.textContent = `${this.chargePercent.toFixed(0)}%`;
      valueEl.style.color = this.getColorForCharge(this.chargePercent);
    }
    
    this.draw();
  }
  
  draw() {
    this.drawCircularGauge();
    this.drawSparkline();
  }
  
  drawCircularGauge() {
    const ctx = this.ctx;
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    const radius = Math.min(centerX, centerY) - 8;
    const startAngle = Math.PI * 0.8;
    const endAngle = Math.PI * 2.2;
    const totalAngle = endAngle - startAngle;
    
    ctx.clearRect(0, 0, this.width, this.height);
    
    // Background arc
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, endAngle);
    ctx.lineWidth = 10;
    ctx.strokeStyle = this.colors.background;
    ctx.lineCap = 'round';
    ctx.stroke();
    
    // Charge arc
    const chargeAngle = startAngle + (this.chargePercent / 100) * totalAngle;
    const chargeColor = this.getColorForCharge(this.chargePercent);
    
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, chargeAngle);
    ctx.lineWidth = 10;
    ctx.strokeStyle = chargeColor;
    ctx.shadowColor = chargeColor;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    // Current indicator arc (small inner arc)
    const currentAngle = Math.PI * 1.5 + (this.current / 1000) * Math.PI * 0.3;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - 15, Math.PI * 1.3, Math.PI * 1.7);
    ctx.lineWidth = 4;
    ctx.strokeStyle = this.current >= 0 ? this.colors.charging : this.colors.discharging;
    ctx.stroke();
  }
  
  drawSparkline() {
    const ctx = this.sparklineCtx;
    ctx.clearRect(0, 0, this.sparkWidth, this.sparkHeight);
    
    if (this.history.every(v => v === 0)) return;
    
    // Draw sparkline
    ctx.beginPath();
    this.history.forEach((value, i) => {
      const x = (i / (this.history.length - 1)) * this.sparkWidth;
      const y = this.sparkHeight - (value / 100) * this.sparkHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    
    ctx.strokeStyle = this.getColorForCharge(this.chargePercent);
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Current value dot
    const lastY = this.sparkHeight - (this.chargePercent / 100) * this.sparkHeight;
    ctx.beginPath();
    ctx.arc(this.sparkWidth, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = this.getColorForCharge(this.chargePercent);
    ctx.fill();
  }
}

// ============================================
// SOLAR PANEL GAUGE
// ============================================

/**
 * Solar panel performance metrics:
 * - Irradiance: W/m² (with AM1.5G reference line at 1000)
 * - Output power: Watts
 * - Efficiency: % (real-time calculated)
 * - I-V curve: mini graph showing operating point
 */
class SolarPanelGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.irradiance = 0; // W/m²
    this.voltage = 0; // V
    this.current = 0; // A
    this.power = 0; // W
    this.efficiency = 0; // %
    this.maxPower = 300; // W rated max
    
    this.constants = LED_SOLAR_CONSTANTS.SOLAR;
    
    this.render();
    this.canvas = this.container.querySelector('.solar-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.ivCanvas = this.container.querySelector('.iv-canvas');
    this.ivCtx = this.ivCanvas.getContext('2d');
    
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
    
    const ivRect = this.ivCanvas.parentElement.getBoundingClientRect();
    this.ivCanvas.width = ivRect.width * dpr;
    this.ivCanvas.height = ivRect.height * dpr;
    this.ivCtx.scale(dpr, dpr);
    this.ivWidth = ivRect.width;
    this.ivHeight = ivRect.height;
    
    this.draw();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Solar Panel</span>
        <span class="sci-gauge-value solar-value">0W</span>
      </div>
      <div class="sci-gauge-container solar-gauge">
        <div class="solar-main">
          <div class="solar-sun-container">
            <canvas class="solar-canvas" width="60" height="60"></canvas>
            <div class="sun-icon">☀️</div>
          </div>
          <div class="solar-metrics">
            <div class="solar-metric">
              <span class="metric-label">Irradiance</span>
              <span class="metric-value irradiance-value">0 W/m²</span>
              <div class="am15g-ref">AM1.5G: 1000 W/m²</div>
            </div>
            <div class="solar-metric">
              <span class="metric-label">Efficiency</span>
              <span class="metric-value efficiency-value">0%</span>
            </div>
            <div class="solar-power-bar">
              <div class="power-bar-bg">
                <div class="power-bar-fill" style="width: 0%"></div>
              </div>
              <span class="power-label">0 / 300W</span>
            </div>
          </div>
        </div>
        <div class="solar-iv-curve">
          <span class="iv-label">I-V Curve</span>
          <canvas class="iv-canvas" width="50" height="30"></canvas>
          <div class="operating-point">●</div>
        </div>
      </div>
    `;
  }
  
  /**
   * Get color for efficiency level
   */
  getEfficiencyColor(eff) {
    if (eff < 15) return '#ff4444'; // Red for low
    if (eff < 20) return '#ffaa00'; // Yellow for medium
    return '#44ff44'; // Green for good
  }
  
  /**
   * Get color for irradiance level
   */
  getIrradianceColor(irr) {
    if (irr < 400) return '#4444ff'; // Low - blue
    if (irr < this.constants.IRRADIANCE_STANDARD) return '#44ff44'; // Medium - green
    return '#ffff44'; // High - yellow
  }
  
  /**
   * Update solar panel output
   * @param {Object} output - Solar output data
   * @param {number} output.irradiance - W/m²
   * @param {number} output.voltage - Volts
   * @param {number} output.current - Amps
   * @param {number} output.power - Watts
   * @param {number} output.efficiency - %
   */
  updateOutput(output) {
    this.irradiance = output.irradiance ?? 0;
    this.voltage = output.voltage ?? 0;
    this.current = output.current ?? 0;
    this.power = output.power ?? 0;
    this.efficiency = output.efficiency ?? 0;
    
    // Update DOM
    const irrEl = this.container.querySelector('.irradiance-value');
    const effEl = this.container.querySelector('.efficiency-value');
    const powerEl = this.container.querySelector('.solar-value');
    const powerBar = this.container.querySelector('.power-bar-fill');
    const powerLabel = this.container.querySelector('.power-label');
    
    if (irrEl) {
      irrEl.textContent = `${this.irradiance.toFixed(0)} W/m²`;
      irrEl.style.color = this.getIrradianceColor(this.irradiance);
    }
    if (effEl) {
      effEl.textContent = `${this.efficiency.toFixed(1)}%`;
      effEl.style.color = this.getEfficiencyColor(this.efficiency);
    }
    if (powerEl) {
      powerEl.textContent = `${this.power.toFixed(1)}W`;
    }
    if (powerBar) {
      const pct = clamp((this.power / this.maxPower) * 100, 0, 100);
      powerBar.style.width = `${pct}%`;
      powerBar.style.background = this.getEfficiencyColor(this.efficiency);
    }
    if (powerLabel) {
      powerLabel.textContent = `${this.power.toFixed(1)} / ${this.maxPower}W`;
    }
    
    this.draw();
  }
  
  draw() {
    this.drawSunIcon();
    this.drawIVCurve();
  }
  
  drawSunIcon() {
    const ctx = this.ctx;
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    const baseRadius = 12;
    
    ctx.clearRect(0, 0, this.width, this.height);
    
    // Calculate ray animation based on irradiance
    const rayIntensity = this.irradiance / this.constants.IRRADIANCE_MAX;
    const numRays = 8;
    const time = Date.now() / 1000;
    
    // Draw rays
    ctx.strokeStyle = this.getIrradianceColor(this.irradiance);
    ctx.lineWidth = 2;
    
    for (let i = 0; i < numRays; i++) {
      const angle = (i / numRays) * Math.PI * 2 + time * 0.5;
      const rayLength = 8 + rayIntensity * 12 + Math.sin(time * 2 + i) * 2;
      const innerRadius = baseRadius + 4;
      const outerRadius = innerRadius + rayLength;
      
      ctx.globalAlpha = 0.3 + rayIntensity * 0.7;
      ctx.beginPath();
      ctx.moveTo(
        centerX + Math.cos(angle) * innerRadius,
        centerY + Math.sin(angle) * innerRadius
      );
      ctx.lineTo(
        centerX + Math.cos(angle) * outerRadius,
        centerY + Math.sin(angle) * outerRadius
      );
      ctx.stroke();
    }
    
    ctx.globalAlpha = 1;
    
    // Draw sun circle
    ctx.beginPath();
    ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
    ctx.fillStyle = this.getIrradianceColor(this.irradiance);
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 10 * rayIntensity;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  
  drawIVCurve() {
    const ctx = this.ivCtx;
    const w = this.ivWidth;
    const h = this.ivHeight;
    
    ctx.clearRect(0, 0, w, h);
    
    // Draw I-V curve (typical solar cell curve)
    ctx.beginPath();
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 1.5;
    
    const isc = this.current * 1.2; // Short circuit current
    const voc = this.voltage * 1.1; // Open circuit voltage
    
    // Draw characteristic curve
    for (let x = 0; x <= w; x++) {
      const v = (x / w) * voc;
      // Simplified I-V equation: I = Isc * (1 - exp((V - Voc)/Vt))
      const i = isc * (1 - Math.exp((v - voc) / 0.026));
      const y = h - (i / isc) * h;
      
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    // Draw operating point
    const opX = (this.voltage / voc) * w;
    const opY = h - (this.current / isc) * h;
    
    ctx.beginPath();
    ctx.arc(opX, opY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff00ff';
    ctx.fill();
    
    // Draw AM1.5G reference line
    const refY = h * 0.3;
    ctx.beginPath();
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = '#ffff00';
    ctx.moveTo(0, refY);
    ctx.lineTo(w, refY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ============================================
// LED ARRAY GAUGE
// ============================================

/**
 * LED status for 6-LED array:
 * - Individual LED on/off status
 * - Color indicator (red/green/blue/white/yellow)
 * - Forward voltage display
 * - Power consumption
 * - Photon flux estimate
 */
class LEDArrayGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.leds = [];
    this.totalPower = 0;
    this.totalLumens = 0;
    
    // Initialize 6 LEDs
    for (let i = 0; i < 6; i++) {
      this.leds.push({
        id: i,
        on: i < 3, // First 3 on by default
        color: ['red', 'green', 'blue', 'white', 'yellow', 'red'][i],
        power: 0,
        vf: 0
      });
    }
    
    this.constants = LED_SOLAR_CONSTANTS.LED;
    this.render();
    this.setupEventListeners();
    this.updateCalculations();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">LED Array (6x)</span>
        <span class="sci-gauge-value led-power-value">0W</span>
      </div>
      <div class="sci-gauge-container led-gauge">
        <div class="led-grid" id="led-grid">
          ${this.leds.map((led, i) => this.renderLED(led, i)).join('')}
        </div>
        <div class="led-stats">
          <div class="led-stat">
            <span class="stat-label">LED Power</span>
            <span class="stat-value led-power-total">0.0W</span>
          </div>
          <div class="led-stat">
            <span class="stat-label">Luminous Flux</span>
            <span class="stat-value led-lumens">0 lm</span>
          </div>
          <div class="led-stat">
            <span class="stat-label">Avg Vf</span>
            <span class="stat-value led-avg-vf">0.0V</span>
          </div>
        </div>
      </div>
    `;
  }
  
  renderLED(led, index) {
    const colors = {
      red: '#ff3333',
      green: '#33ff33',
      blue: '#3333ff',
      white: '#ffffff',
      yellow: '#ffff33'
    };
    
    const angle = (index / 6) * Math.PI * 2 - Math.PI / 2;
    const radius = 35;
    const x = 50 + Math.cos(angle) * radius;
    const y = 50 + Math.sin(angle) * radius;
    
    return `
      <div class="led-wrapper" style="left: ${x}px; top: ${y}px;" data-index="${index}">
        <div class="led-indicator ${led.on ? 'on' : 'off'} ${led.color}" 
             data-index="${index}"
             style="background: ${colors[led.color]}; color: ${colors[led.color]}">
        </div>
        <span class="led-label">${index + 1}</span>
        <span class="led-vf">${this.constants[led.color.toUpperCase()].vf}V</span>
      </div>
    `;
  }
  
  setupEventListeners() {
    this.container.addEventListener('click', (e) => {
      const ledEl = e.target.closest('.led-indicator');
      if (ledEl) {
        const index = parseInt(ledEl.dataset.index);
        this.toggleLED(index);
      }
    });
  }
  
  toggleLED(index) {
    this.leds[index].on = !this.leds[index].on;
    const ledEl = this.container.querySelector(`.led-indicator[data-index="${index}"]`);
    if (ledEl) {
      ledEl.classList.toggle('on', this.leds[index].on);
      ledEl.classList.toggle('off', !this.leds[index].on);
    }
    this.updateCalculations();
  }
  
  updateCalculations() {
    let totalPower = 0;
    let totalLumens = 0;
    let totalVf = 0;
    let activeCount = 0;
    
    this.leds.forEach(led => {
      if (led.on) {
        const colorData = this.constants[led.color.toUpperCase()];
        const current = 0.35; // 350mA typical
        led.power = colorData.vf * current;
        led.vf = colorData.vf;
        
        totalPower += led.power;
        totalLumens += led.power * colorData.lumensPerWatt;
        totalVf += colorData.vf;
        activeCount++;
      } else {
        led.power = 0;
        led.vf = 0;
      }
    });
    
    this.totalPower = totalPower;
    this.totalLumens = totalLumens;
    const avgVf = activeCount > 0 ? totalVf / activeCount : 0;
    
    // Update DOM
    const powerEl = this.container.querySelector('.led-power-value');
    const powerTotalEl = this.container.querySelector('.led-power-total');
    const lumensEl = this.container.querySelector('.led-lumens');
    const vfEl = this.container.querySelector('.led-avg-vf');
    
    if (powerEl) powerEl.textContent = `${this.totalPower.toFixed(1)}W`;
    if (powerTotalEl) powerTotalEl.textContent = `${this.totalPower.toFixed(1)}W`;
    if (lumensEl) lumensEl.textContent = `${Math.round(this.totalLumens)} lm`;
    if (vfEl) vfEl.textContent = `${avgVf.toFixed(1)}V`;
  }
  
  /**
   * Update LED status
   * @param {Array} leds - Array of { id, on, color, power, vf }
   */
  updateStatus(leds) {
    if (Array.isArray(leds)) {
      leds.forEach(update => {
        const led = this.leds[update.id];
        if (led) {
          led.on = update.on ?? led.on;
          led.color = update.color ?? led.color;
          led.power = update.power ?? led.power;
          led.vf = update.vf ?? led.vf;
        }
      });
      
      // Re-render LED grid
      const grid = this.container.querySelector('#led-grid');
      if (grid) {
        grid.innerHTML = this.leds.map((led, i) => this.renderLED(led, i)).join('');
      }
      
      this.updateCalculations();
    }
  }
  
  /**
   * Get current LED states
   */
  getLEDStates() {
    return this.leds.map(led => ({...led}));
  }
}

// ============================================
// ENERGY BALANCE DISPLAY
// ============================================

/**
 * Sankey-style energy flow diagram:
 * Battery → LEDs → Photons → Solar Panel → Battery
 * 
 * Show losses at each stage with efficiency percentages
 * Net loop efficiency: ~5.3%
 */
class EnergyBalanceDisplay {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.flows = {
      batteryOut: 100,     // 100W starting
      ledOptical: 0,       // After LED conversion (30%)
      panelReceived: 0,    // After transmission (85%)
      panelElectrical: 0,  // After solar conversion (22%)
      batteryIn: 0,        // After battery charge (95%)
      roundTripEff: 0      // Net efficiency
    };
    
    this.efficiency = LED_SOLAR_CONSTANTS.EFFICIENCY;
    this.render();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Energy Flow</span>
        <span class="sci-gauge-value efficiency-value">0% loop</span>
      </div>
      <div class="sci-gauge-container energy-balance">
        <svg class="energy-sankey" viewBox="0 0 280 180">
          <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7" 
                    refX="9" refY="3.5" orient="auto">
              <polygon points="0 0, 10 3.5, 0 7" fill="#00ffff" />
            </marker>
            <linearGradient id="flowGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:#00ffff;stop-opacity:0.8" />
              <stop offset="100%" style="stop-color:#00ffff;stop-opacity:0.3" />
            </linearGradient>
          </defs>
          
          <!-- Nodes -->
          <g class="sankey-node" transform="translate(20, 80)">
            <rect class="node-rect battery-out" x="0" y="-25" width="50" height="50" rx="4" />
            <text class="node-label" x="25" y="-30">Battery</text>
            <text class="node-value battery-out-val" x="25" y="5">100W</text>
          </g>
          
          <g class="sankey-node" transform="translate(90, 30)">
            <rect class="node-rect led-conversion" x="0" y="-20" width="50" height="40" rx="4" />
            <text class="node-label" x="25" y="-25">LEDs</text>
            <text class="node-value led-val" x="25" y="5">30W</text>
          </g>
          
          <g class="sankey-node" transform="translate(160, 30)">
            <rect class="node-rect transmission" x="0" y="-15" width="50" height="30" rx="4" />
            <text class="node-label" x="25" y="-20">Photons</text>
            <text class="node-value photon-val" x="25" y="5">25W</text>
          </g>
          
          <g class="sankey-node" transform="translate(160, 100)">
            <rect class="node-rect solar-conversion" x="0" y="-15" width="50" height="30" rx="4" />
            <text class="node-label" x="25" y="-20">Solar</text>
            <text class="node-value solar-val" x="25" y="5">5.5W</text>
          </g>
          
          <g class="sankey-node" transform="translate(230, 80)">
            <rect class="node-rect battery-in" x="0" y="-20" width="40" height="40" rx="4" />
            <text class="node-label" x="20" y="-25">Charge</text>
            <text class="node-value battery-in-val" x="20" y="5">5.2W</text>
          </g>
          
          <!-- Flow arrows with variable width -->
          <path class="energy-flow-arrow flow-1" d="M 70 80 Q 80 80 90 50" 
                stroke-width="20" fill="none" marker-end="url(#arrowhead)" />
          <path class="energy-flow-arrow flow-2" d="M 140 50 L 160 45" 
                stroke-width="12" fill="none" marker-end="url(#arrowhead)" />
          <path class="energy-flow-arrow flow-3" d="M 185 60 Q 180 80 160 115" 
                stroke-width="10" fill="none" marker-end="url(#arrowhead)" />
          <path class="energy-flow-arrow flow-4" d="M 210 115 Q 220 100 230 100" 
                stroke-width="6" fill="none" marker-end="url(#arrowhead)" />
          
          <!-- Efficiency labels -->
          <text class="eff-label eff-1" x="75" y="65">30%</text>
          <text class="eff-label eff-2" x="145" y="42">85%</text>
          <text class="eff-label eff-3" x="165" y="85">22%</text>
          <text class="eff-label eff-4" x="215" y="95">95%</text>
          
          <!-- Loss indicators -->
          <text class="loss-label loss-1" x="75" y="95">-70W</text>
          <text class="loss-label loss-2" x="145" y="70">-5W</text>
          <text class="loss-label loss-3" x="165" y="135">-20W</text>
          <text class="loss-label loss-4" x="220" y="120">-0.3W</text>
        </svg>
        
        <div class="energy-summary">
          <div class="summary-item">
            <span class="summary-label">Battery Output:</span>
            <span class="summary-value battery-out-summary">100W</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Recovered:</span>
            <span class="summary-value battery-in-summary">5.2W</span>
          </div>
          <div class="summary-item highlight">
            <span class="summary-label">Loop Efficiency:</span>
            <span class="summary-value round-trip-eff">5.3%</span>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Update energy balance flows
   * @param {Object} flows - Energy flow data
   * @param {number} flows.batteryOut - Battery output power (W)
   * @param {number} flows.ledOptical - LED optical output (W)
   * @param {number} flows.panelReceived - Light received by panel (W)
   * @param {number} flows.panelElectrical - Electrical output from panel (W)
   * @param {number} flows.batteryIn - Power into battery (W)
   * @param {number} flows.roundTripEff - Overall efficiency (%)
   */
  updateFlows(flows) {
    this.flows = { ...this.flows, ...flows };
    
    // Calculate derived values if not provided
    if (this.flows.batteryOut > 0) {
      this.flows.ledOptical = this.flows.batteryOut * this.efficiency.LED_CONVERSION;
      this.flows.panelReceived = this.flows.ledOptical * this.efficiency.TRANSMISSION;
      this.flows.panelElectrical = this.flows.panelReceived * this.efficiency.SOLAR_CONVERSION;
      this.flows.batteryIn = this.flows.panelElectrical * this.efficiency.BATTERY_CHARGE;
      this.flows.roundTripEff = (this.flows.batteryIn / this.flows.batteryOut) * 100;
    }
    
    this.updateDisplay();
  }
  
  updateDisplay() {
    // Update node values
    const updates = {
      '.battery-out-val': `${this.flows.batteryOut.toFixed(1)}W`,
      '.led-val': `${this.flows.ledOptical.toFixed(1)}W`,
      '.photon-val': `${this.flows.panelReceived.toFixed(1)}W`,
      '.solar-val': `${this.flows.panelElectrical.toFixed(1)}W`,
      '.battery-in-val': `${this.flows.batteryIn.toFixed(1)}W`,
      '.battery-out-summary': `${this.flows.batteryOut.toFixed(1)}W`,
      '.battery-in-summary': `${this.flows.batteryIn.toFixed(1)}W`,
      '.round-trip-eff': `${this.flows.roundTripEff.toFixed(1)}%`,
      '.efficiency-value': `${this.flows.roundTripEff.toFixed(1)}% loop`
    };
    
    Object.entries(updates).forEach(([selector, value]) => {
      const el = this.container.querySelector(selector);
      if (el) el.textContent = value;
    });
    
    // Update flow arrow widths based on relative power
    const basePower = Math.max(this.flows.batteryOut, 1);
    const widths = {
      '.flow-1': 20 * (this.flows.batteryOut / basePower),
      '.flow-2': 12 * (this.flows.ledOptical / (basePower * this.efficiency.LED_CONVERSION)),
      '.flow-3': 10 * (this.flows.panelReceived / (basePower * this.efficiency.LED_CONVERSION * this.efficiency.TRANSMISSION)),
      '.flow-4': 6 * (this.flows.panelElectrical / (basePower * this.efficiency.LED_CONVERSION * this.efficiency.TRANSMISSION * this.efficiency.SOLAR_CONVERSION))
    };
    
    Object.entries(widths).forEach(([selector, width]) => {
      const el = this.container.querySelector(selector);
      if (el) el.setAttribute('stroke-width', width);
    });
    
    // Update loss labels
    const losses = {
      '.loss-1': `-${(this.flows.batteryOut - this.flows.ledOptical).toFixed(1)}W`,
      '.loss-2': `-${(this.flows.ledOptical - this.flows.panelReceived).toFixed(1)}W`,
      '.loss-3': `-${(this.flows.panelReceived - this.flows.panelElectrical).toFixed(1)}W`,
      '.loss-4': `-${(this.flows.panelElectrical - this.flows.batteryIn).toFixed(1)}W`
    };
    
    Object.entries(losses).forEach(([selector, value]) => {
      const el = this.container.querySelector(selector);
      if (el) el.textContent = value;
    });
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
        <div id="sci-battery-gauge"></div>
        <div id="sci-solar-gauge"></div>
        <div id="sci-led-gauge"></div>
        <div id="sci-energy-flow-gauge"></div>
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
    
    // LED + Solar gauges
    this.gauges.battery = new BatteryGauge('sci-battery-gauge');
    this.gauges.solar = new SolarPanelGauge('sci-solar-gauge');
    this.gauges.led = new LEDArrayGauge('sci-led-gauge');
    this.gauges.energyFlow = new EnergyBalanceDisplay('sci-energy-flow-gauge');
    
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
      this.gauges.battery.resize();
      this.gauges.solar.resize();
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
  
  // ============================================
  // LED + SOLAR UPDATE METHODS
  // ============================================
  
  /**
   * Update battery state
   * @param {Object} state - Battery state
   * @param {number} state.chargePercent - 0-100%
   * @param {number} state.voltage - Volts (3.0-4.2V)
   * @param {number} state.current - mA (positive=charging, negative=discharging)
   * @param {number} state.temperature - Celsius
   */
  updateBatteryState(state) {
    if (this.gauges.battery) {
      this.gauges.battery.updateState(state);
    }
  }
  
  /**
   * Update solar panel output
   * @param {Object} output - Solar output data
   * @param {number} output.irradiance - W/m²
   * @param {number} output.voltage - Volts
   * @param {number} output.current - Amps
   * @param {number} output.power - Watts
   * @param {number} output.efficiency - %
   */
  updateSolarOutput(output) {
    if (this.gauges.solar) {
      this.gauges.solar.updateOutput(output);
    }
  }
  
  /**
   * Update LED array status
   * @param {Array} leds - Array of { id, on, color, power, vf }
   */
  updateLEDStatus(leds) {
    if (this.gauges.led) {
      this.gauges.led.updateStatus(leds);
    }
  }
  
  /**
   * Update energy balance flows
   * @param {Object} flows - Energy flow data
   * @param {number} flows.batteryOut - Battery output power (W)
   * @param {number} flows.ledOptical - LED optical output (W)
   * @param {number} flows.panelReceived - Light received by panel (W)
   * @param {number} flows.panelElectrical - Electrical output from panel (W)
   * @param {number} flows.batteryIn - Power into battery (W)
   * @param {number} flows.roundTripEff - Overall efficiency (%)
   */
  updateEnergyBalance(flows) {
    if (this.gauges.energyFlow) {
      this.gauges.energyFlow.updateFlows(flows);
    }
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
  WolframStatusPanel,
  BatteryGauge,
  SolarPanelGauge,
  LEDArrayGauge,
  EnergyBalanceDisplay,
  LED_SOLAR_CONSTANTS
};

// Default export for convenience
export default ScientificUIManager;
