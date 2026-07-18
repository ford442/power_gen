import { clamp, formatCurrent, LED_SOLAR_CONSTANTS } from '../utils/index.js';

export class BatteryGauge {
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
