import { formatNumber, clamp } from '../../scientific-ui-utils.js';

export class MagneticFieldGauge {
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
