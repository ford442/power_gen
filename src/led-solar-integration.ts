/**
 * LED/Solar Integration Layer
 * 
 * Integration layer connecting the LED/Solar physics simulation to the main visualizer
 * with real-time energy flow calculations.
 * 
 * This module provides:
 * - Complete LED/Solar/Battery system state management
 * - Real-time energy flow calculations
 * - Integration with SEGIntegrationManager for visualization
 * - Shader uniform generation for WebGPU rendering
 * 
 * Wolfram Alpha Citations:
 * - LED wall-plug efficiency: ~30% typical (Wolfram|Alpha: "LED luminous efficacy")
 * - Commercial Si solar cell efficiency: ~22% (Wolfram|Alpha: "silicon solar cell efficiency")
 * - Li-ion voltage curve: 3.0V (0%) to 4.2V (100%) (Wolfram|Alpha: "Li-ion battery voltage")
 * - Round-trip efficiency: η_total = η_LED × η_geom × η_solar × η_batt (Wolfram|Alpha: "efficiency product")
 */

import { LEDSolarPhysics, IVCurveCalculator } from './led-solar-constants';
import { ValidatedConstants } from './ValidatedConstants';
import { SEGIntegrationManager } from './integration';

// ============================================
// LED/Solar System State Interface
// ============================================

export interface LEDSolarSystemState {
  // Time
  timestamp: number;
  deltaTime: number;
  
  // Battery
  battery: {
    chargePercent: number;     // 0-100
    voltage: number;           // 3.0 - 4.2 V
    capacityAh: number;        // Amp-hours
    current: number;           // +charging, -discharging (A)
    temperature: number;       // Celsius
    cycleCount: number;        // Charge cycles
    stateOfHealth: number;     // 0-100% capacity retention
  };
  
  // LED Array (6 LEDs in hex pattern)
  leds: Array<{
    id: number;
    on: boolean;
    color: 'red' | 'green' | 'blue' | 'white' | 'yellow';
    forwardVoltage: number;    // V
    current: number;           // mA
    power: number;             // Watts
    luminousFlux: number;      // Lumens
    temperature: number;       // Junction temp (°C)
  }>;
  
  // Solar Panel
  solarPanel: {
    area: number;              // m²
    irradiance: number;        // W/m² received
    openCircuitVoltage: number; // Voc (V)
    shortCircuitCurrent: number; // Isc (A)
    operatingVoltage: number;  // Vmp (V)
    operatingCurrent: number;  // Imp (A)
    fillFactor: number;        // 0-1
    efficiency: number;        // 0-1
    temperature: number;       // Cell temp (°C)
    power: number;             // Watts output
  };
  
  // Energy Flow
  energyFlow: {
    batteryToLEDs: number;     // Electrical W
    ledsToPhotons: number;     // Optical W (30% efficient)
    photonsToPanel: number;    // Optical W received
    panelToBattery: number;    // Electrical W (22% efficient)
    roundTripEfficiency: number; // Net loop efficiency
    netPowerBalance: number;   // Positive = charging
  };
  
  // Simulation metrics
  totalPhotonsEmitted: number;
  totalPhotonsAbsorbed: number;
  quantumEfficiency: number;
}

// ============================================
// LED/Solar Simulation Class
// ============================================

class LEDSolarSimulation {
  private state: LEDSolarSystemState;
  private history: LEDSolarSystemState[]; // Last 60 seconds
  private updateCount: number = 0;
  
  constructor(initialCapacityAh: number = 2.6) { // 18650 cell
    this.history = [];
    this.state = this.initializeState(initialCapacityAh);
  }
  
  private initializeState(initialCapacityAh: number): LEDSolarSystemState {
    return {
      battery: {
        chargePercent: 50,
        voltage: 3.7,
        capacityAh: initialCapacityAh,
        current: 0,
        temperature: 25,
        cycleCount: 0,
        stateOfHealth: 100
      },
      leds: this.initializeLEDs(),
      solarPanel: this.initializeSolarPanel(),
      energyFlow: {
        batteryToLEDs: 0,
        ledsToPhotons: 0,
        photonsToPanel: 0,
        panelToBattery: 0,
        roundTripEfficiency: 0.066, // 6.6%
        netPowerBalance: 0
      },
      totalPhotonsEmitted: 0,
      totalPhotonsAbsorbed: 0,
      quantumEfficiency: 0,
      timestamp: Date.now(),
      deltaTime: 0
    };
  }
  
  private initializeLEDs(): LEDSolarSystemState['leds'] {
    // 6 LEDs: 2 red, 2 green, 1 blue, 1 white (typical arrangement)
    return [
      { id: 0, on: true, color: 'red' as const, forwardVoltage: 2.0, current: 350, power: 0, luminousFlux: 0, temperature: 25 },
      { id: 1, on: true, color: 'red' as const, forwardVoltage: 2.0, current: 350, power: 0, luminousFlux: 0, temperature: 25 },
      { id: 2, on: true, color: 'green' as const, forwardVoltage: 3.2, current: 350, power: 0, luminousFlux: 0, temperature: 25 },
      { id: 3, on: true, color: 'green' as const, forwardVoltage: 3.2, current: 350, power: 0, luminousFlux: 0, temperature: 25 },
      { id: 4, on: true, color: 'blue' as const, forwardVoltage: 3.3, current: 350, power: 0, luminousFlux: 0, temperature: 25 },
      { id: 5, on: true, color: 'white' as const, forwardVoltage: 3.5, current: 350, power: 0, luminousFlux: 0, temperature: 25 },
    ];
  }
  
  private initializeSolarPanel() {
    return {
      area: 0.006, // 60cm x 100cm (scaled for simulation)
      irradiance: 0,
      openCircuitVoltage: 3.6, // 6 cells × 0.6V
      shortCircuitCurrent: 0,
      operatingVoltage: 0,
      operatingCurrent: 0,
      fillFactor: 0.75,
      efficiency: 0.22,
      temperature: 25,
      power: 0
    };
  }
  
  // ============================================
  // Main Update Loop - Call Every Frame
  // ============================================
  
  update(deltaTimeMs: number): LEDSolarSystemState {
    const dt = deltaTimeMs / 1000; // Convert to seconds
    this.updateCount++;
    
    // 1. Calculate LED power consumption
    this.updateLEDs(dt);
    
    // 2. Calculate photon emission and transport
    this.updatePhotonTransport(dt);
    
    // 3. Calculate solar panel output
    this.updateSolarPanel(dt);
    
    // 4. Update battery state
    this.updateBattery(dt);
    
    // 5. Calculate energy balance
    this.calculateEnergyFlow();
    
    // 6. Update quantum efficiency tracking
    this.updateQuantumEfficiency();
    
    // Store history (sample at 1Hz for efficiency)
    this.state.timestamp = Date.now();
    this.state.deltaTime = dt;
    
    if (this.updateCount % 60 === 0) { // Store every ~1 second at 60fps
      this.history.push(this.cloneState());
      if (this.history.length > 60) {
        this.history.shift();
      }
    }
    
    return this.state;
  }
  
  private updateLEDs(dt: number) {
    const LED_EFFICIENCY = 0.30; // 30% wall-plug (Wolfram validated)
    
    for (const led of this.state.leds) {
      if (!led.on) {
        led.power = 0;
        led.luminousFlux = 0;
        led.temperature = 25;
        continue;
      }
      
      // P = V × I (convert mA to A)
      led.power = led.forwardVoltage * (led.current / 1000); // Watts
      
      // Luminous flux based on efficacy and color
      const efficacy = this.getEfficacy(led.color);
      led.luminousFlux = led.power * LED_EFFICIENCY * efficacy;
      
      // Temperature rise (simplified thermal model)
      // T_junction = T_ambient + P × R_thermal
      const THERMAL_RESISTANCE = 20; // K/W
      led.temperature = 25 + led.power * THERMAL_RESISTANCE;
    }
    
    this.state.energyFlow.batteryToLEDs = 
      this.state.leds.reduce((sum, led) => sum + led.power, 0);
  }
  
  private getEfficacy(color: string): number {
    // Luminous efficacy by color (lm/W optical)
    // Source: Wolfram|Alpha - LED efficacy varies by wavelength
    switch (color) {
      case 'red': return 100;
      case 'green': return 180; // Eye most sensitive to green
      case 'blue': return 50;
      case 'white': return 150;
      case 'yellow': return 120;
      default: return 100;
    }
  }
  
  private updatePhotonTransport(dt: number) {
    const LED_EFFICIENCY = 0.30; // 30% wall-plug efficiency
    const GEOMETRIC_EFFICIENCY = 0.85; // 85% of light hits panel
    
    // Optical power emitted by LEDs
    const opticalPower = this.state.energyFlow.batteryToLEDs * LED_EFFICIENCY;
    this.state.energyFlow.ledsToPhotons = opticalPower;
    
    // Photons reaching panel (accounting for geometry)
    this.state.energyFlow.photonsToPanel = opticalPower * GEOMETRIC_EFFICIENCY;
    
    // Update irradiance on panel (W/m²)
    this.state.solarPanel.irradiance = 
      this.state.energyFlow.photonsToPanel / this.state.solarPanel.area;
    
    // Photon counting (simplified)
    // Average photon energy in visible range ~2.5 eV
    const AVG_PHOTON_ENERGY_EV = 2.5;
    const JOULES_PER_EV = 1.602176634e-19;
    const photonsPerSecond = opticalPower / (AVG_PHOTON_ENERGY_EV * JOULES_PER_EV);
    
    this.state.totalPhotonsEmitted += photonsPerSecond * dt;
    this.state.totalPhotonsAbsorbed += photonsPerSecond * GEOMETRIC_EFFICIENCY * dt;
  }
  
  private updateSolarPanel(dt: number) {
    const panel = this.state.solarPanel;
    
    // Power output: P = η × E × A
    // Source: Wolfram|Alpha - solar cell power calculation
    const outputPower = panel.efficiency * panel.irradiance * panel.area;
    panel.power = outputPower;
    
    // Update I-V curve operating point (simplified)
    // Voc × Isc × FF ≈ P_max
    if (panel.openCircuitVoltage > 0) {
      panel.shortCircuitCurrent = outputPower / (panel.openCircuitVoltage * panel.fillFactor);
    }
    
    // Maximum power point approximation
    // Vmp ≈ 0.8 × Voc, Imp ≈ Pmax / Vmp
    panel.operatingVoltage = panel.openCircuitVoltage * 0.8;
    panel.operatingCurrent = panel.power / Math.max(0.001, panel.operatingVoltage);
    
    // Temperature rise from absorbed light
    // P_absorbed = P_incident (conservation of energy)
    // Temperature increase proportional to absorbed power
    const ABSORBED_POWER = this.state.energyFlow.photonsToPanel;
    panel.temperature = 25 + ABSORBED_POWER * 10; // Simplified thermal model
    
    this.state.energyFlow.panelToBattery = outputPower;
  }
  
  private updateBattery(dt: number) {
    const battery = this.state.battery;
    const CHARGE_EFFICIENCY = 0.95;
    
    // Net current: charging - discharging
    const dischargePower = this.state.energyFlow.batteryToLEDs;
    const chargePower = this.state.energyFlow.panelToBattery * CHARGE_EFFICIENCY;
    
    const netPower = chargePower - dischargePower;
    battery.current = netPower / battery.voltage; // Amps
    
    // Update charge percentage
    // dSOC/dt = (P_net / V) / (Ah × 3600) × 100
    const capacityWh = battery.capacityAh * 3.7; // Nominal voltage
    const deltaWh = netPower * (dt / 3600); // Watt-hours changed
    const deltaPercent = (deltaWh / capacityWh) * 100;
    
    battery.chargePercent = Math.max(0, Math.min(100, 
      battery.chargePercent + deltaPercent));
    
    // Update voltage based on charge curve (simplified Li-ion)
    // Source: Wolfram|Alpha - Li-ion discharge curve
    // 3.0V at 0%, 3.7V at 50%, 4.2V at 100%
    if (battery.chargePercent < 20) {
      // Deep discharge region: steep slope
      battery.voltage = 3.0 + (battery.chargePercent / 20) * 0.5;
    } else if (battery.chargePercent < 80) {
      // Flat region: nominal operation
      battery.voltage = 3.5 + ((battery.chargePercent - 20) / 60) * 0.4;
    } else {
      // Charge termination region
      battery.voltage = 3.9 + ((battery.chargePercent - 80) / 20) * 0.3;
    }
    
    // Count cycles (every 100% discharge = 1 cycle)
    if (battery.chargePercent <= 0 && netPower < 0) {
      battery.cycleCount += 0.001; // Partial cycle tracking
    }
    
    // Update state of health (simplified degradation model)
    // Capacity fades ~0.05% per cycle
    battery.stateOfHealth = Math.max(80, 100 - battery.cycleCount * 0.05);
    
    // Battery temperature from internal resistance heating
    const INTERNAL_RESISTANCE = 0.05; // Ohms (typical 18650)
    const heatPower = battery.current * battery.current * INTERNAL_RESISTANCE;
    battery.temperature = 25 + heatPower * 5; // Simplified thermal model
  }
  
  private calculateEnergyFlow() {
    const flow = this.state.energyFlow;
    
    // Round-trip efficiency calculation
    // Source: Wolfram|Alpha - cascade efficiency
    if (flow.batteryToLEDs > 0.001) {
      flow.roundTripEfficiency = flow.panelToBattery / flow.batteryToLEDs;
    } else {
      flow.roundTripEfficiency = 0;
    }
    
    // Net power balance
    // Positive = charging, Negative = discharging
    flow.netPowerBalance = flow.panelToBattery - flow.batteryToLEDs;
  }
  
  private updateQuantumEfficiency() {
    // Quantum efficiency = photons absorbed / photons emitted
    if (this.state.totalPhotonsEmitted > 0) {
      this.state.quantumEfficiency = 
        this.state.totalPhotonsAbsorbed / this.state.totalPhotonsEmitted;
    }
  }
  
  private cloneState(): LEDSolarSystemState {
    // Deep clone the state for history
    return {
      timestamp: this.state.timestamp,
      deltaTime: this.state.deltaTime,
      battery: { ...this.state.battery },
      leds: this.state.leds.map(led => ({ ...led })),
      solarPanel: { ...this.state.solarPanel },
      energyFlow: { ...this.state.energyFlow },
      totalPhotonsEmitted: this.state.totalPhotonsEmitted,
      totalPhotonsAbsorbed: this.state.totalPhotonsAbsorbed,
      quantumEfficiency: this.state.quantumEfficiency
    };
  }
  
  // ============================================
  // Public Control Methods
  // ============================================
  
  /**
   * Toggle LED on/off
   */
  toggleLED(id: number): void {
    const led = this.state.leds.find(l => l.id === id);
    if (led) {
      led.on = !led.on;
    }
  }
  
  /**
   * Set LED current (0-1000 mA)
   */
  setLEDCurrent(id: number, currentMa: number): void {
    const led = this.state.leds.find(l => l.id === id);
    if (led) {
      led.current = Math.max(0, Math.min(1000, currentMa));
    }
  }
  
  /**
   * Set LED color
   */
  setLEDColor(id: number, color: LEDSolarSystemState['leds'][0]['color']): void {
    const led = this.state.leds.find(l => l.id === id);
    if (led) {
      led.color = color;
      // Update forward voltage based on color
      switch (color) {
        case 'red': led.forwardVoltage = 2.0; break;
        case 'green': led.forwardVoltage = 3.2; break;
        case 'blue': led.forwardVoltage = 3.3; break;
        case 'white': led.forwardVoltage = 3.5; break;
        case 'yellow': led.forwardVoltage = 2.1; break;
      }
    }
  }
  
  /**
   * Set all LEDs on/off
   */
  setAllLEDs(on: boolean): void {
    for (const led of this.state.leds) {
      led.on = on;
    }
  }
  
  /**
   * Set battery charge percentage directly (for initialization)
   */
  setBatteryCharge(percent: number): void {
    this.state.battery.chargePercent = Math.max(0, Math.min(100, percent));
    // Recalculate voltage
    this.updateBattery(0);
  }
  
  /**
   * Get current system state
   */
  getState(): LEDSolarSystemState {
    return this.state;
  }
  
  /**
   * Get state history (last 60 seconds)
   */
  getHistory(): LEDSolarSystemState[] {
    return this.history;
  }
  
  /**
   * Get current energy balance summary
   */
  getEnergyBalance(): {
    inputPower: number;
    outputPower: number;
    efficiency: number;
    batteryCharging: boolean;
    timeToEmpty: number; // hours
    timeToFull: number;  // hours
  } {
    const flow = this.state.energyFlow;
    const battery = this.state.battery;
    
    // Calculate time estimates
    const remainingCapacityWh = battery.capacityAh * battery.voltage * 
                               (battery.chargePercent / 100);
    
    let timeToEmpty = Infinity;
    let timeToFull = Infinity;
    
    if (flow.netPowerBalance < 0) {
      // Discharging
      timeToEmpty = remainingCapacityWh / Math.abs(flow.netPowerBalance);
    } else if (flow.netPowerBalance > 0) {
      // Charging
      const capacityToFill = battery.capacityAh * battery.voltage * 
                            (1 - battery.chargePercent / 100);
      timeToFull = capacityToFill / flow.netPowerBalance;
    }
    
    return {
      inputPower: flow.panelToBattery,
      outputPower: flow.batteryToLEDs,
      efficiency: flow.roundTripEfficiency,
      batteryCharging: flow.netPowerBalance > 0,
      timeToEmpty,
      timeToFull
    };
  }
  
  /**
   * Reset simulation to initial state
   */
  reset(): void {
    const capacity = this.state.battery.capacityAh;
    this.state = this.initializeState(capacity);
    this.history = [];
    this.updateCount = 0;
  }
}

// ============================================
// Default Battery Capacity Export
// ============================================

const DEFAULT_BATTERY_CAPACITY = 2.6; // 18650 cell in Ah

// ============================================
// LED/Solar Integration Manager Extension
// ============================================

/**
 * LEDSolarIntegration - Extends SEGIntegrationManager with LED/Solar mode
 * 
 * This class provides the integration layer between the LED/Solar simulation
 * and the main WebGPU visualizer.
 */
class LEDSolarIntegration {
  private simulation: LEDSolarSimulation;
  private integrationManager: SEGIntegrationManager | null = null;
  private isRunning: boolean = false;
  private uniformBuffer: GPUBuffer | null = null;
  private device: GPUDevice | null = null;
  
  constructor(initialCapacityAh: number = DEFAULT_BATTERY_CAPACITY) {
    this.simulation = new LEDSolarSimulation(initialCapacityAh);
  }
  
  /**
   * Initialize the LED/Solar mode with WebGPU device
   */
  initialize(device: GPUDevice): void {
    this.device = device;
    
    // Create uniform buffer for shader data
    // Layout: battery (4 floats) + leds (6 × 4 floats) + solar (4 floats) + flow (4 floats)
    // Total: 4 + 24 + 4 + 4 = 36 floats = 144 bytes
    this.uniformBuffer = device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    this.isRunning = true;
  }
  
  /**
   * Connect to main integration manager
   */
  connect(integrationManager: SEGIntegrationManager): void {
    this.integrationManager = integrationManager;
  }
  
  /**
   * Main update loop - call every frame
   */
  update(deltaTime: number): LEDSolarSystemState {
    // Update simulation
    const state = this.simulation.update(deltaTime);
    
    // Update shader uniforms
    this.updateUniforms(state);
    
    // Update UI if available
    this.updateUI(state);
    
    return state;
  }
  
  /**
   * Update shader uniforms with current state
   */
  private updateUniforms(state: LEDSolarSystemState): void {
    if (!this.device || !this.uniformBuffer) return;
    
    // Pack data for WGSL shader
    const uniforms = new Float32Array(36);
    
    // Battery data (4 floats)
    uniforms[0] = state.battery.chargePercent / 100; // Normalized 0-1
    uniforms[1] = state.battery.voltage;
    uniforms[2] = state.battery.current;
    uniforms[3] = state.battery.temperature;
    
    // LED data (6 LEDs × 4 floats each)
    for (let i = 0; i < 6; i++) {
      const led = state.leds[i];
      const base = 4 + i * 4;
      uniforms[base + 0] = led.on ? 1.0 : 0.0;
      uniforms[base + 1] = led.power;
      uniforms[base + 2] = led.temperature;
      // Color encoding: RGB mapped to 0-3
      uniforms[base + 3] = this.encodeColor(led.color);
    }
    
    // Solar panel data (4 floats)
    uniforms[28] = state.solarPanel.irradiance;
    uniforms[29] = state.solarPanel.power;
    uniforms[30] = state.solarPanel.temperature;
    uniforms[31] = state.solarPanel.efficiency;
    
    // Energy flow data (4 floats)
    uniforms[32] = state.energyFlow.batteryToLEDs;
    uniforms[33] = state.energyFlow.panelToBattery;
    uniforms[34] = state.energyFlow.roundTripEfficiency;
    uniforms[35] = state.energyFlow.netPowerBalance;
    
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
  }
  
  /**
   * Encode LED color for shader
   */
  private encodeColor(color: string): number {
    switch (color) {
      case 'red': return 0.0;
      case 'green': return 1.0;
      case 'blue': return 2.0;
      case 'white': return 3.0;
      case 'yellow': return 4.0;
      default: return 0.0;
    }
  }
  
  /**
   * Update UI with current state
   */
  private updateUI(state: LEDSolarSystemState): void {
    // Check for global sciUI (similar to SEGIntegrationManager)
    const sciUI = (window as unknown as { sciUI?: {
      updateBatteryState?: (battery: LEDSolarSystemState['battery']) => void;
      updateSolarOutput?: (panel: LEDSolarSystemState['solarPanel']) => void;
      updateLEDStatus?: (leds: LEDSolarSystemState['leds']) => void;
      updateEnergyBalance?: (flow: LEDSolarSystemState['energyFlow']) => void;
    }}).sciUI;
    
    if (sciUI) {
      sciUI.updateBatteryState?.(state.battery);
      sciUI.updateSolarOutput?.(state.solarPanel);
      sciUI.updateLEDStatus?.(state.leds);
      sciUI.updateEnergyBalance?.(state.energyFlow);
    }
  }
  
  /**
   * Get the uniform buffer for binding to shaders
   */
  getUniformBuffer(): GPUBuffer | null {
    return this.uniformBuffer;
  }
  
  /**
   * Get the underlying simulation instance
   */
  getSimulation(): LEDSolarSimulation {
    return this.simulation;
  }
  
  /**
   * Get current system state
   */
  getState(): LEDSolarSystemState {
    return this.simulation.getState();
  }
  
  /**
   * Control methods - delegate to simulation
   */
  toggleLED(id: number): void {
    this.simulation.toggleLED(id);
  }
  
  setLEDCurrent(id: number, currentMa: number): void {
    this.simulation.setLEDCurrent(id, currentMa);
  }
  
  setLEDColor(id: number, color: LEDSolarSystemState['leds'][0]['color']): void {
    this.simulation.setLEDColor(id, color);
  }
  
  setAllLEDs(on: boolean): void {
    this.simulation.setAllLEDs(on);
  }
  
  reset(): void {
    this.simulation.reset();
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.isRunning = false;
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
  }
}

// ============================================
// Exports
// ============================================

export type { LEDSolarSystemState };
export { LEDSolarSimulation, LEDSolarIntegration, DEFAULT_BATTERY_CAPACITY };
export default LEDSolarIntegration;
