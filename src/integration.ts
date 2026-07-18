/**
 * SEG Integration Manager
 * 
 * Main integration hub that coordinates:
 * - Wolfram MCP for physics calculations
 * - Scientific UI for visualization
 * - Physics state management
 * - Shader uniform generation
 */

import type {
  MCPStatus,
  SEGPhysicsState,
  Vec3,
  PhysicsValueType,
  ValidationResult,
} from './types';
import { WolframMCPManager } from './mcp-manager';
import { ValidatedConstants, formatUncertainValue } from './ValidatedConstants';
import { FallbackPhysics, validatePhysics, UNCERTAINTY_LEVELS } from './fallback-physics';
import { LEDSolarSimulation, LEDSolarSystemState, DEFAULT_BATTERY_CAPACITY } from './led-solar-integration';

// ============================================
// Physics Uniform Buffer Layout (matches WGSL)
// ============================================

/** Float count for {@link SEGIntegrationManager.getPhysicsUniforms} (96 bytes). */
export const PHYSICS_UNIFORM_FLOAT_COUNT = 24;
/** Byte size of the physics uniform buffer. */
export const PHYSICS_UNIFORM_BYTES = PHYSICS_UNIFORM_FLOAT_COUNT * 4;

export interface SEGIntegrationOptions {
  /**
   * When true, attach a small floating gauge overlay next to the canvas.
   * Multi-device dashboard already has its own telemetry UI — leave false there.
   */
  enableScientificOverlay?: boolean;
  /** Minimum ms between UI/MCP gauge refreshes (default 100). */
  updateIntervalMs?: number;
}

interface PhysicsUniforms {
  // 64 bytes: B-field parameters (16 floats)
  mu0: number;              // Vacuum permeability
  br: number;               // Remanence
  magnetRadius: number;     // Magnet radius
  magnetHeight: number;     // Magnet height
  ringRadius: number;       // Ring radius
  numRollers: number;       // Number of rollers
  magneticMoment: number;   // Magnetic moment
  padding1: number;         // Padding
  
  // Material properties (8 floats)
  innerTorque: number;      // N·m
  middleTorque: number;     // N·m
  outerTorque: number;      // N·m
  maxBField: number;        // Tesla
  avgEnergyDensity: number; // J/m³
  particleFlux: number;     // particles/second
  timestamp: number;        // Simulation time
  padding2: number;         // Padding
}

// ============================================
// UI surface (dashboard owns real gauges via TelemetryHub)
// ============================================

interface ScientificUISurface {
  updateGauge(name: string, value: number | string, uncertainty?: number, isValidated?: boolean): void;
  updateMCPStatus(status: MCPStatus): void;
  showError(message: string): void;
  destroy(): void;
}

/**
 * No-op surface. Dashboard telemetry is TelemetryHub → operator panel / scientific-ui/.
 * The former floating overlay ScientificUIManager was removed (duplicate implementation).
 */
class NoOpScientificUI implements ScientificUISurface {
  updateGauge(): void { /* no-op — use TelemetryHub subscribers */ }
  updateMCPStatus(): void { /* no-op */ }
  showError(message: string): void {
    console.error('[ScientificUI]', message);
  }
  destroy(): void { /* no-op */ }
}

// ============================================
// Main Integration Manager
// ============================================

export class SEGIntegrationManager {
  private wolfram: WolframMCPManager;
  private ui: ScientificUISurface;
  private physicsState: SEGPhysicsState;
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private uniformBuffer: GPUBuffer | null = null;
  private physicsUniformBuffer: GPUBuffer | null = null;
  private lastUpdateTime: number = 0;
  private updateInterval: number = 100; // Update every 100ms
  private pendingQueries: Set<string> = new Set();
  
  // LED/Solar mode support
  private ledSolarSimulation: LEDSolarSimulation | null = null;
  private mode: 'seg' | 'ledsolar' | 'heron' | 'kelvin' = 'seg';

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    options: SEGIntegrationOptions = {}
  ) {
    this.device = device;
    this.canvas = canvas;
    this.wolfram = new WolframMCPManager();
    // Dashboard owns UI; enableScientificOverlay is retained for API compatibility only.
    this.ui = new NoOpScientificUI();
    if (options.enableScientificOverlay) {
      console.info(
        '[SEGIntegration] enableScientificOverlay ignored — use scientific-ui/index.js + TelemetryHub'
      );
    }
    if (typeof options.updateIntervalMs === 'number' && options.updateIntervalMs > 0) {
      this.updateInterval = options.updateIntervalMs;
    }
    
    // Initialize physics state with fallback values
    this.physicsState = this.initializePhysicsState();

    // GPU buffer for multi-device / shader binding (always allocated)
    this.physicsUniformBuffer = this.device.createBuffer({
      label: 'seg-physics-uniforms',
      size: PHYSICS_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Initialize MCP and UI
    this.initialize();
  }

  private initializePhysicsState(): SEGPhysicsState {
    const summary = FallbackPhysics.getSEGPhysicsSummary();
    
    return {
      timestamp: Date.now(),
      innerRingTorque: ValidatedConstants.SEG_PHYSICS.INNER_RING_TORQUE.value,
      middleRingTorque: summary.ringTorque.value,
      outerRingTorque: ValidatedConstants.SEG_PHYSICS.OUTER_RING_TORQUE.value,
      maxFieldMagnitude: ValidatedConstants.SEG_PHYSICS.B_FIELD_SURFACE.value,
      avgEnergyDensity: ValidatedConstants.SEG_PHYSICS.ENERGY_DENSITY_SURFACE.value,
      particleFlux: 1000,  // Default value
    };
  }

  private async initialize(): Promise<void> {
    // NOTE: Wolfram MCP is disabled at runtime - using pre-calculated fallback values
    // The physics constants were validated during development using Wolfram
    this.ui.updateMCPStatus('disconnected');
    
    // Skip all MCP connection attempts - use fallback physics only
    console.log('[SEGIntegration] Wolfram MCP disabled - using pre-validated fallback physics');
  }

  private async retryConnection(): Promise<void> {
    // Disabled - no runtime Wolfram MCP calls
    console.log('[SEGIntegration] MCP retry skipped - using fallback physics');
  }

  /**
   * Called every simulation frame
   */
  update(deltaTime: number, fieldData?: Float32Array): void {
    const now = Date.now();
    
    // Throttle updates to avoid overwhelming the UI
    if (now - this.lastUpdateTime < this.updateInterval) {
      return;
    }
    this.lastUpdateTime = now;

    // 1. Update physics calculations based on field data
    if (fieldData) {
      this.updatePhysicsFromFieldData(fieldData);
    }

    // 2. Query Wolfram for any new needed values (async, non-blocking)
    this.queryUpdatedValues();

    // 3. Update UI gauges
    this.updateUIGauges();

    // 4. Update timestamp
    this.physicsState.timestamp = now;
  }

  private updatePhysicsFromFieldData(fieldData: Float32Array): void {
    // Extract B-field values from GPU compute output
    // fieldData is expected to contain particle positions and field strengths
    
    let maxB = 0;
    let totalEnergy = 0;
    let count = 0;

    // Sample every 4th value (x, y, z, fieldStrength)
    for (let i = 3; i < fieldData.length; i += 4) {
      const b = Math.abs(fieldData[i]);
      maxB = Math.max(maxB, b);
      totalEnergy += FallbackPhysics.energyDensity(b);
      count++;
    }

    if (count > 0) {
      this.physicsState.maxFieldMagnitude = maxB;
      this.physicsState.avgEnergyDensity = totalEnergy / count;
    }

    // Validate physics values
    const fieldValidation = validatePhysics(maxB, 'field');
    if (!fieldValidation.isValid) {
      console.warn('[SEGIntegration] Field validation failed:', fieldValidation.message);
    }
  }

  private queryUpdatedValues(): void {
    // DISABLED: No runtime Wolfram MCP queries
    // Physics values use pre-calculated fallback constants from ValidatedConstants
    // These were validated during development using Wolfram Alpha
    return;
  }

  private updateUIGauges(): void {
    const inner = ValidatedConstants.SEG_PHYSICS.INNER_RING_TORQUE;
    const middle = FallbackPhysics.ringTorque(ValidatedConstants.SEG_CONFIG.middleRingRadius);
    const outer = ValidatedConstants.SEG_PHYSICS.OUTER_RING_TORQUE;
    const bField = ValidatedConstants.SEG_PHYSICS.B_FIELD_SURFACE;
    const energy = ValidatedConstants.SEG_PHYSICS.ENERGY_DENSITY_SURFACE;

    this.ui.updateGauge('Inner Torque', this.physicsState.innerRingTorque, inner.uncertainty, inner.isValidated);
    this.ui.updateGauge('Middle Torque', this.physicsState.middleRingTorque, middle.uncertainty, middle.isValidated);
    this.ui.updateGauge('Outer Torque', this.physicsState.outerRingTorque, outer.uncertainty, outer.isValidated);
    this.ui.updateGauge('Max B-Field', this.physicsState.maxFieldMagnitude, bField.uncertainty, bField.isValidated);
    this.ui.updateGauge('Energy Density', this.physicsState.avgEnergyDensity, energy.uncertainty, energy.isValidated);
    this.ui.updateGauge('Particle Flux', this.physicsState.particleFlux);
  }

  /**
   * Get shader uniform buffer data (ArrayBuffer of 24 floats / 96 bytes).
   */
  getPhysicsUniforms(): ArrayBuffer {
    const arr = this.getPhysicsUniformArray();
    // Explicit ArrayBuffer for TS 5.x ArrayBufferLike / WebGPU queue typing.
    return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
  }

  /**
   * Typed Float32Array of physics uniforms for CPU consumers and GPU upload.
   * Layout: [0..7] B-field params, [8..15] live state, [16..23] extras/reserved.
   */
  getPhysicsUniformArray(): Float32Array {
    // Own ArrayBuffer so .buffer is ArrayBuffer (not ArrayBufferLike) under TS 5.7+.
    const uniforms = new Float32Array(new ArrayBuffer(PHYSICS_UNIFORM_BYTES));

    // First 8 floats: B-field parameters
    uniforms[0] = ValidatedConstants.PHYSICAL_CONSTANTS.MU_0;
    uniforms[1] = ValidatedConstants.SEG_MAGNET.Br;
    uniforms[2] = ValidatedConstants.SEG_MAGNET.radius;
    uniforms[3] = ValidatedConstants.SEG_MAGNET.height;
    uniforms[4] = ValidatedConstants.SEG_CONFIG.middleRingRadius;
    uniforms[5] = ValidatedConstants.SEG_CONFIG.numRollers;
    uniforms[6] = ValidatedConstants.MAGNETIC_MOMENT.value;
    uniforms[7] = 0;  // padding

    // Next 8 floats: Physics state
    uniforms[8] = this.physicsState.innerRingTorque;
    uniforms[9] = this.physicsState.middleRingTorque;
    uniforms[10] = this.physicsState.outerRingTorque;
    uniforms[11] = this.physicsState.maxFieldMagnitude;
    uniforms[12] = this.physicsState.avgEnergyDensity;
    uniforms[13] = this.physicsState.particleFlux;
    uniforms[14] = this.physicsState.timestamp / 1000;  // Convert to seconds
    uniforms[15] = 0;  // padding

    // Last 8 floats: Additional parameters
    uniforms[16] = ValidatedConstants.PHYSICAL_CONSTANTS.K_B;
    uniforms[17] = ValidatedConstants.PHYSICAL_CONSTANTS.T_ROOM;
    uniforms[18] = ValidatedConstants.SEG_CONFIG.innerRingRadius;
    uniforms[19] = ValidatedConstants.SEG_CONFIG.outerRingRadius;
    uniforms[20] = 0;  // reserved
    uniforms[21] = 0;  // reserved
    uniforms[22] = 0;  // reserved
    uniforms[23] = 0;  // reserved

    return uniforms;
  }

  /**
   * Write physics uniforms to a GPU buffer (defaults to the manager-owned buffer).
   */
  writeUniformsToBuffer(buffer?: GPUBuffer, offset = 0): void {
    const target = buffer ?? this.physicsUniformBuffer;
    if (!target) return;
    const data = this.getPhysicsUniforms();
    this.device.queue.writeBuffer(target, offset, data);
  }

  /**
   * Manager-owned physics uniform buffer (96 bytes) for bind-group attachment.
   */
  getPhysicsUniformBuffer(): GPUBuffer | null {
    return this.physicsUniformBuffer;
  }

  /**
   * Update live particle flux estimate from the visualizer (particles/s proxy).
   */
  setParticleFlux(flux: number): void {
    this.physicsState.particleFlux = Math.max(0, flux);
  }

  /**
   * Merge live multi-device simulation stats into typed physics state.
   * Call once per frame (or throttled) before {@link writeUniformsToBuffer}.
   */
  syncFromVisualizer(stats: {
    particleFlux?: number;
    maxFieldMagnitude?: number;
    avgEnergyDensity?: number;
    innerRingTorque?: number;
    middleRingTorque?: number;
    outerRingTorque?: number;
  }): void {
    if (typeof stats.particleFlux === 'number') {
      this.physicsState.particleFlux = Math.max(0, stats.particleFlux);
    }
    if (typeof stats.maxFieldMagnitude === 'number') {
      this.physicsState.maxFieldMagnitude = stats.maxFieldMagnitude;
    }
    if (typeof stats.avgEnergyDensity === 'number') {
      this.physicsState.avgEnergyDensity = stats.avgEnergyDensity;
    }
    if (typeof stats.innerRingTorque === 'number') {
      this.physicsState.innerRingTorque = stats.innerRingTorque;
    }
    if (typeof stats.middleRingTorque === 'number') {
      this.physicsState.middleRingTorque = stats.middleRingTorque;
    }
    if (typeof stats.outerRingTorque === 'number') {
      this.physicsState.outerRingTorque = stats.outerRingTorque;
    }
  }

  /**
   * Handle MCP connection events
   */
  onMCPStatusChange(status: MCPStatus): void {
    this.ui.updateMCPStatus(status);
    
    switch (status) {
      case 'connected':
        console.log('[SEGIntegration] MCP connected - using authoritative values');
        // Re-query physics constants with authoritative source
        this.wolfram.initializePhysicsCache();
        break;
      case 'fallback':
        console.log('[SEGIntegration] MCP in fallback mode - using estimated values');
        break;
      case 'disconnected':
        console.log('[SEGIntegration] MCP disconnected - using cached/fallback values');
        break;
    }
  }

  /**
   * Get current physics state
   */
  getPhysicsState(): SEGPhysicsState {
    return { ...this.physicsState };
  }

  /**
   * Get Wolfram MCP manager for direct access
   */
  getWolframManager(): WolframMCPManager {
    return this.wolfram;
  }

  /**
   * Validate a physics value
   */
  validateValue(value: number, type: PhysicsValueType): ValidationResult {
    return validatePhysics(value, type);
  }

  /**
   * Get physics statistics
   */
  getStats(): {
    mcp: ReturnType<WolframMCPManager['getStats']>;
    physics: SEGPhysicsState;
  } {
    return {
      mcp: this.wolfram.getStats(),
      physics: this.getPhysicsState(),
    };
  }

  // ============================================
  // LED/Solar Mode Support
  // ============================================
  
  /**
   * Initialize LED/Solar simulation mode
   * @param batteryCapacityAh - Battery capacity in Ah (default: 2.6 for 18650 cell)
   */
  initializeLEDSolarMode(batteryCapacityAh: number = DEFAULT_BATTERY_CAPACITY): void {
    this.ledSolarSimulation = new LEDSolarSimulation(batteryCapacityAh);
    this.mode = 'ledsolar';
    console.log(`[SEGIntegration] LED/Solar mode initialized with ${batteryCapacityAh}Ah battery`);
  }
  
  /**
   * Update LED/Solar simulation (call every frame when in LED/Solar mode)
   * @param deltaTime - Time since last frame in milliseconds
   * @returns Current LED/Solar system state
   */
  updateLEDSolar(deltaTime: number): LEDSolarSystemState | null {
    if (!this.ledSolarSimulation) {
      console.warn('[SEGIntegration] LED/Solar mode not initialized');
      return null;
    }
    
    const state = this.ledSolarSimulation.update(deltaTime);
    
    // Update UI with LED/Solar specific data
    this.updateLEDSolarUI(state);
    
    // Update shader uniforms for LED/Solar visualization
    this.updateLEDSolarUniforms(state);
    
    return state;
  }
  
  /**
   * Update UI gauges for LED/Solar mode
   */
  private updateLEDSolarUI(state: LEDSolarSystemState): void {
    // Update battery gauge
    this.ui.updateGauge('Battery SOC', state.battery.chargePercent, 0, true);
    this.ui.updateGauge('Battery Voltage', state.battery.voltage, 0.01, true);
    this.ui.updateGauge('Battery Current', state.battery.current, 0.05, true);
    
    // Update solar panel gauge
    this.ui.updateGauge('Solar Power', state.solarPanel.power, 0.05, true);
    this.ui.updateGauge('Solar Irradiance', state.solarPanel.irradiance, 0.1, false);
    
    // Update LED power consumption
    this.ui.updateGauge('LED Power', state.energyFlow.batteryToLEDs, 0.05, true);
    
    // Update round-trip efficiency
    this.ui.updateGauge('Round-Trip Eff', state.energyFlow.roundTripEfficiency * 100, 0.1, false);
  }
  
  /**
   * Update shader uniforms for LED/Solar visualization
   * Layout matches WGSL shader expectations
   */
  private updateLEDSolarUniforms(state: LEDSolarSystemState): void {
    if (!this.uniformBuffer) {
      // Create uniform buffer if not exists
      this.uniformBuffer = this.device.createBuffer({
        size: 144, // 36 floats
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    
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
      uniforms[base + 3] = this.encodeLEDColor(led.color);
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
  private encodeLEDColor(color: string): number {
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
   * Toggle LED on/off
   * @param id - LED ID (0-5)
   */
  toggleLED(id: number): void {
    if (this.ledSolarSimulation) {
      this.ledSolarSimulation.toggleLED(id);
    }
  }
  
  /**
   * Set LED current
   * @param id - LED ID (0-5)
   * @param currentMa - Current in mA (0-1000)
   */
  setLEDCurrent(id: number, currentMa: number): void {
    if (this.ledSolarSimulation) {
      this.ledSolarSimulation.setLEDCurrent(id, currentMa);
    }
  }
  
  /**
   * Set LED color
   * @param id - LED ID (0-5)
   * @param color - LED color
   */
  setLEDColor(id: number, color: LEDSolarSystemState['leds'][0]['color']): void {
    if (this.ledSolarSimulation) {
      this.ledSolarSimulation.setLEDColor(id, color);
    }
  }
  
  /**
   * Set all LEDs on/off
   * @param on - True to turn on, false to turn off
   */
  setAllLEDs(on: boolean): void {
    if (this.ledSolarSimulation) {
      this.ledSolarSimulation.setAllLEDs(on);
    }
  }
  
  /**
   * Get current LED/Solar system state
   */
  getLEDSolarState(): LEDSolarSystemState | null {
    return this.ledSolarSimulation?.getState() ?? null;
  }
  
  /**
   * Get LED/Solar system history
   */
  getLEDSolarHistory(): LEDSolarSystemState[] {
    return this.ledSolarSimulation?.getHistory() ?? [];
  }
  
  /**
   * Get LED/Solar uniform buffer for binding to shaders
   */
  getLEDSolarUniformBuffer(): GPUBuffer | null {
    return this.uniformBuffer;
  }
  
  /**
   * Switch simulation mode
   * @param mode - Mode to switch to
   */
  setMode(mode: 'seg' | 'ledsolar' | 'heron' | 'kelvin'): void {
    this.mode = mode;
    if (mode === 'ledsolar' && !this.ledSolarSimulation) {
      this.initializeLEDSolarMode();
    }
  }
  
  /**
   * Get current simulation mode
   */
  getMode(): string {
    return this.mode;
  }
  
  /**
   * Reset LED/Solar simulation
   */
  resetLEDSolar(): void {
    this.ledSolarSimulation?.reset();
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.ui.destroy();
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
    if (this.physicsUniformBuffer) {
      this.physicsUniformBuffer.destroy();
      this.physicsUniformBuffer = null;
    }
  }
}

export default SEGIntegrationManager;
