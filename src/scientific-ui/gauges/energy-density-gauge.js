import { formatNumber, clamp } from '../utils/index.js';

export class EnergyDensityGauge {
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
