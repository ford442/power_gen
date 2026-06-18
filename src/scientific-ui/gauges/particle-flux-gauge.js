import { formatCompact } from '../../scientific-ui-utils.js';

export class ParticleFluxGauge {
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
