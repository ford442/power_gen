/**
 * Core Type Definitions for SEG WebGPU Visualizer
 * Physics types, Wolfram MCP types, and Shader types
 */

// ============================================
// Physics types
// ============================================

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MagneticFieldVector {
  position: Vec3;
  bField: Vec3;           // Tesla
  magnitude: number;       // |B|
  energyDensity: number;   // J/m³
}

export interface SEGPhysicsState {
  timestamp: number;
  innerRingTorque: number;   // N·m
  middleRingTorque: number;  // N·m
  outerRingTorque: number;   // N·m
  maxFieldMagnitude: number; // Tesla
  avgEnergyDensity: number;  // J/m³
  particleFlux: number;      // particles/second
}

// ============================================
// Wolfram MCP types
// ============================================

export type MCPStatus = 'connected' | 'disconnected' | 'fallback';

export interface WolframCacheEntry<T> {
  query: string;
  result: T;
  timestamp: number;
  source: 'wolfram' | 'cached' | 'fallback';
  ttl: number;  // time to live in ms
}

export interface WolframMCPState {
  status: MCPStatus;
  lastQuery: number;
  cacheHits: number;
  cacheMisses: number;
  fallbackCount: number;
}

export interface WolframQueryOptions {
  timeout?: number;        // ms, default 5000
  ttl?: number;            // ms, default 3600000 (1 hour)
  retryCount?: number;     // default 3
  useCache?: boolean;      // default true
}

// ============================================
// Shader types
// ============================================

export interface ShaderModule {
  device: GPUDevice;
  module: GPUShaderModule;
  entryPoints: string[];
}

export interface ComputePipelineConfig {
  workgroupSize: [number, number, number];
  shaderPath: string;
  bindings: GPUBindGroupLayoutEntry[];
}

export interface RenderPipelineConfig {
  vertexShader: string;
  fragmentShader: string;
  vertexLayout: GPUVertexBufferLayout[];
  primitive?: GPUPrimitiveState;
  depthStencil?: GPUDepthStencilState;
  blend?: GPUBlendState;
}

// ============================================
// Integration types
// ============================================

export interface PhysicsConstants {
  MU_0: number;           // H/m - Vacuum permeability
  EPSILON_0: number;      // F/m - Vacuum permittivity
  C: number;              // m/s - Speed of light
  K_B: number;            // J/K - Boltzmann constant
  T_ROOM: number;         // K - Room temperature
  E_CHARGE: number;       // C - Elementary charge
  G: number;              // m/s² - Standard gravity
  RHO_WATER: number;      // kg/m³ - Water density
}

export interface SEGMagnetSpec {
  Br: number;             // Tesla - Remanence
  mu_r: number;           // Relative permeability
  radius: number;         // m
  height: number;         // m
  volume: number;         // m³
  magnetization: number;  // A/m
}

export interface UncertaintyFlag {
  value: number;
  uncertainty: number;    // percentage (e.g., 0.05 for 5%)
  isValidated: boolean;
  source: 'wolfram' | 'calculated' | 'estimated';
}

export interface ValidationResult {
  isValid: boolean;
  value: number;
  bounds: { min: number; max: number };
  message?: string;
}

export type PhysicsValueType = 'field' | 'energy' | 'torque' | 'voltage' | 'force';

export interface MCPPersistenceData {
  cache: Array<[string, WolframCacheEntry<unknown>]>;
  state: WolframMCPState;
  timestamp: number;
}
