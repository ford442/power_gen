import { formatNumber } from '../../scientific-ui-utils.js';

export class TorqueGauge {
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
