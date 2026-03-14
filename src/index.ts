/**
 * SEG WebGPU Visualizer - TypeScript Module Exports
 * 
 * This is the main entry point for the TypeScript integration layer.
 * All modules are designed to work alongside the existing JavaScript codebase.
 */

// ============================================
// Core Types
// ============================================

export type {
  // Physics types
  Vec3,
  MagneticFieldVector,
  SEGPhysicsState,
  
  // Wolfram MCP types
  MCPStatus,
  WolframCacheEntry,
  WolframMCPState,
  WolframQueryOptions,
  
  // Shader types
  ShaderModule,
  ComputePipelineConfig,
  RenderPipelineConfig,
  
  // Integration types
  PhysicsConstants,
  SEGMagnetSpec,
  UncertaintyFlag,
  ValidationResult,
  PhysicsValueType,
  MCPPersistenceData,
} from './types';

// ============================================
// Validated Constants
// ============================================

export {
  ValidatedConstants,
  PHYSICAL_CONSTANTS,
  SEG_MAGNET,
  SEG_CONFIG,
  SEG_PHYSICS,
  KELVIN_CONSTANTS,
  HERON_CONSTANTS,
  MU_0,
  EPSILON_0,
  K_B,
  MAGNET_BR,
  MAGNETIC_MOMENT,
  getConstant,
  areAllValidated,
  getMaxUncertainty,
  formatUncertainValue,
} from './ValidatedConstants';

// ============================================
// Fallback Physics
// ============================================

export {
  FallbackPhysics,
  UNCERTAINTY_LEVELS,
  PHYSICAL_BOUNDS,
  FALLBACK_CONSTANTS,
  FALLBACK_SEG_SPECS,
  createUncertainValue,
  validatePhysics,
} from './fallback-physics';

// ============================================
// MCP Manager
// ============================================

export {
  WolframMCPManager,
  getWolframMCPManager,
} from './mcp-manager';

// ============================================
// Integration Manager
// ============================================

export { SEGIntegrationManager } from './integration';

// ============================================
// Re-export all as default namespace
// ============================================

import { ValidatedConstants } from './ValidatedConstants';
import { FallbackPhysics } from './fallback-physics';
import { WolframMCPManager, getWolframMCPManager } from './mcp-manager';
import { SEGIntegrationManager } from './integration';

/**
 * Default export with all major components
 */
export default {
  ValidatedConstants,
  FallbackPhysics,
  WolframMCPManager,
  getWolframMCPManager,
  SEGIntegrationManager,
};

// ============================================
// Version
// ============================================

export const VERSION = '1.0.0';

// ============================================
// Module initialization helper
// ============================================

/**
 * Initialize the SEG TypeScript integration layer
 * Call this from your main JavaScript code before using any TypeScript features
 */
export async function initializeSEGIntegration(
  device: GPUDevice,
  canvas: HTMLCanvasElement
): Promise<SEGIntegrationManager> {
  const manager = new SEGIntegrationManager(device, canvas);
  
  // Give it a moment to initialize async components
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.log('[SEGIntegration] TypeScript integration layer initialized');
  return manager;
}

// ============================================
// Global type declarations for browser
// ============================================

declare global {
  interface Window {
    SEGIntegration?: {
      manager: SEGIntegrationManager | null;
      initialize: typeof initializeSEGIntegration;
    };
  }
}

// Auto-attach to window if in browser
if (typeof window !== 'undefined') {
  window.SEGIntegration = {
    manager: null,
    initialize: initializeSEGIntegration,
  };
}
