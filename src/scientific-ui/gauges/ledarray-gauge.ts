import { LED_SOLAR_CONSTANTS } from '../utils/index.js';

export class LEDArrayGauge {
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
