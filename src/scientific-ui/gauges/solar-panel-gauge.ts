import { clamp, LED_SOLAR_CONSTANTS } from '../utils/index.js';

export class SolarPanelGauge {
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
