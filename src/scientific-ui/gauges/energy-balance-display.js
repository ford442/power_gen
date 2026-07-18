import { LED_SOLAR_CONSTANTS } from '../utils/index.js';

export class EnergyBalanceDisplay {
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
