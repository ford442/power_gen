/**
 * Wolfram MCP Manager
 * 
 * Manages communication with Wolfram Alpha MCP with:
 * - Intelligent caching with TTL
 * - Fallback chain for offline operation
 * - Exponential backoff for retries
 * - Persistence across page reloads
 */

import type {
  MCPStatus,
  WolframCacheEntry,
  WolframMCPState,
  WolframQueryOptions,
  MCPPersistenceData,
} from './types';
import { FallbackPhysics, createUncertainValue } from './fallback-physics';

// Default configuration
const DEFAULT_OPTIONS: Required<WolframQueryOptions> = {
  timeout: 5000,
  ttl: 3600000,  // 1 hour
  retryCount: 3,
  useCache: true,
};

// Storage key for localStorage persistence
const STORAGE_KEY = 'wolfram_mcp_cache';

// Physics constants that should be pre-populated
const PHYSICS_QUERIES = [
  { key: 'MU_0', query: 'permeability of free value in H/m', default: 1.2566370614e-7 },
  { key: 'EPSILON_0', query: 'permittivity of free space value in F/m', default: 8.854187817e-12 },
  { key: 'BR_N52', query: 'N52 neodymium magnet remanent flux density', default: 1.48 },
  { key: 'E_CHARGE', query: 'elementary charge value in coulombs', default: 1.602176634e-19 },
  { key: 'K_B', query: 'Boltzmann constant value in J/K', default: 1.380649e-23 },
  { key: 'C', query: 'speed of light value in m/s', default: 299792458 },
] as const;

/**
 * Wolfram MCP Manager class
 */
export class WolframMCPManager {
  private cache: Map<string, WolframCacheEntry<unknown>> = new Map();
  private status: MCPStatus = 'disconnected';
  private fallbackValues: Map<string, unknown> = new Map();
  private state: WolframMCPState;
  private retryAttempts: Map<string, number> = new Map();
  private lastRetryTime: Map<string, number> = new Map();

  constructor() {
    this.state = {
      status: 'disconnected',
      lastQuery: 0,
      cacheHits: 0,
      cacheMisses: 0,
      fallbackCount: 0,
    };
    this.loadFromStorage();
    this.initializeFallbackValues();
  }

  /**
   * Initialize fallback values from FallbackPhysics
   */
  private initializeFallbackValues(): void {
    const summary = FallbackPhysics.getSEGPhysicsSummary();
    this.fallbackValues.set('SEG_SURFACE_B', summary.surfaceBField);
    this.fallbackValues.set('SEG_ENERGY_DENSITY', summary.surfaceEnergyDensity);
    this.fallbackValues.set('SEG_RING_TORQUE', summary.ringTorque);
    this.fallbackValues.set('SEG_ADJACENT_FORCE', summary.adjacentRollerForce);
  }

  /**
   * Get current MCP status
   */
  getStatus(): MCPStatus {
    return this.status;
  }

  /**
   * Get current state statistics
   */
  getState(): WolframMCPState {
    return { ...this.state };
  }

  /**
   * Try to connect to Wolfram MCP
   */
  async connect(): Promise<boolean> {
    try {
      // Check if WolframAlpha MCP is available (via global or window)
      const wolframMCP = (globalThis as unknown as { WolframAlpha?: { query: (q: string) => Promise<unknown> } }).WolframAlpha;
      
      if (wolframMCP) {
        this.status = 'connected';
        this.state.status = 'connected';
        console.log('[WolframMCP] Connected successfully');
        return true;
      }

      // Try a test query to verify connectivity
      await this.testConnection();
      this.status = 'connected';
      this.state.status = 'connected';
      return true;
    } catch (error) {
      this.status = 'fallback';
      this.state.status = 'fallback';
      console.warn('[WolframMCP] Connection failed, using fallback mode:', error);
      return false;
    }
  }

  /**
   * Test connection with a simple query
   */
  private async testConnection(): Promise<void> {
    // This would make an actual MCP call in production
    // For now, simulate connection check
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // Simulate 50% connection success for demo
        if (Math.random() > 0.5) {
          resolve();
        } else {
          reject(new Error('Connection timeout'));
        }
      }, 100);
    });
  }

  /**
   * Main query method with fallback chain
   */
  async query<T>(
    query: string,
    fallbackValue: T,
    options: WolframQueryOptions = {}
  ): Promise<WolframCacheEntry<T>> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const cacheKey = this.hashQuery(query);

    // 1. Check cache first
    if (opts.useCache) {
      const cached = this.getFromCache<T>(cacheKey);
      if (cached) {
        this.state.cacheHits++;
        return cached;
      }
    }
    this.state.cacheMisses++;

    // 2. Check if we should retry (exponential backoff)
    if (!this.shouldRetry(cacheKey)) {
      this.state.fallbackCount++;
      return this.createFallbackEntry(query, fallbackValue);
    }

    // 3. Try Wolfram MCP if connected
    if (this.status === 'connected') {
      try {
        const result = await this.executeQuery<T>(query, opts.timeout);
        const entry = this.createCacheEntry(query, result, 'wolfram', opts.ttl);
        this.setCache(cacheKey, entry);
        this.resetRetry(cacheKey);
        this.state.lastQuery = Date.now();
        return entry;
      } catch (error) {
        console.warn(`[WolframMCP] Query failed: ${query}`, error);
        this.incrementRetry(cacheKey);
      }
    }

    // 4. Use fallback value
    this.state.fallbackCount++;
    const fallbackEntry = this.createFallbackEntry(query, fallbackValue);
    
    // Still cache fallback to avoid repeated failures
    if (opts.useCache) {
      this.setCache(cacheKey, fallbackEntry);
    }

    return fallbackEntry;
  }

  /**
   * Execute actual Wolfram query (placeholder for real MCP call)
   */
  private async executeQuery<T>(query: string, timeout: number): Promise<T> {
    // This would be replaced with actual MCP call
    // Example: return await window.mcp.wolfram.query(query, { timeout });
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Query timeout after ${timeout}ms`));
      }, timeout);

      // Simulate async query
      Promise.resolve().then(() => {
        clearTimeout(timer);
        // Return mock result for now
        resolve({ query, result: 'mock' } as T);
      });
    });
  }

  /**
   * Pre-populate cache with validated physics constants
   */
  async initializePhysicsCache(): Promise<void> {
    const now = Date.now();

    for (const { key, query, default: defaultValue } of PHYSICS_QUERIES) {
      // Populate with fallback immediately
      const fallbackEntry = this.createFallbackEntry(query, defaultValue);
      this.setCache(key, fallbackEntry);

      // Fire async Wolfram query to update with authoritative value
      if (this.status === 'connected') {
        this.query<number>(query, defaultValue)
          .then(entry => {
            console.log(`[WolframMCP] Updated ${key}:`, entry.result);
          })
          .catch(error => {
            console.warn(`[WolframMCP] Failed to update ${key}:`, error);
          });
      }
    }

    console.log('[WolframMCP] Physics cache initialized with fallback values');
  }

  /**
   * Get a physics constant (always returns something)
   */
  getPhysicsConstant(key: string): number | undefined {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && !this.isExpired(cached)) {
      return cached.result as number;
    }

    // Return fallback if available
    return this.fallbackValues.get(key) as number | undefined;
  }

  /**
   * Get cache entry with type safety
   */
  getFromCache<T>(key: string): WolframCacheEntry<T> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return null;
    }
    return entry as WolframCacheEntry<T>;
  }

  /**
   * Set cache entry
   */
  private setCache<T>(key: string, entry: WolframCacheEntry<T>): void {
    this.cache.set(key, entry);
    this.saveToStorage();
  }

  /**
   * Check if cache entry is expired
   */
  private isExpired(entry: WolframCacheEntry<unknown>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  /**
   * Create a cache entry
   */
  private createCacheEntry<T>(
    query: string,
    result: T,
    source: 'wolfram' | 'cached' | 'fallback',
    ttl: number
  ): WolframCacheEntry<T> {
    return {
      query,
      result,
      timestamp: Date.now(),
      source,
      ttl,
    };
  }

  /**
   * Create a fallback cache entry
   */
  private createFallbackEntry<T>(query: string, fallbackValue: T): WolframCacheEntry<T> {
    return this.createCacheEntry(query, fallbackValue, 'fallback', 60000); // 1 min TTL for fallbacks
  }

  /**
   * Hash query string for cache key
   */
  private hashQuery(query: string): string {
    // Simple hash for demo - use proper hashing in production
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      const char = query.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `q_${hash.toString(36)}`;
  }

  /**
   * Check if we should retry a query (exponential backoff)
   */
  private shouldRetry(key: string): boolean {
    const attempts = this.retryAttempts.get(key) || 0;
    const lastRetry = this.lastRetryTime.get(key) || 0;
    const backoffMs = Math.min(1000 * 2 ** attempts, 30000); // Max 30s
    return Date.now() - lastRetry >= backoffMs;
  }

  /**
   * Increment retry count
   */
  private incrementRetry(key: string): void {
    const attempts = (this.retryAttempts.get(key) || 0) + 1;
    this.retryAttempts.set(key, attempts);
    this.lastRetryTime.set(key, Date.now());
  }

  /**
   * Reset retry count after success
   */
  private resetRetry(key: string): void {
    this.retryAttempts.delete(key);
    this.lastRetryTime.delete(key);
  }

  /**
   * Save cache to localStorage
   */
  private saveToStorage(): void {
    try {
      const data: MCPPersistenceData = {
        cache: Array.from(this.cache.entries()),
        state: this.state,
        timestamp: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.warn('[WolframMCP] Failed to save cache:', error);
    }
  }

  /**
   * Load cache from localStorage
   */
  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;

      const data: MCPPersistenceData = JSON.parse(stored);
      
      // Check if stored data is too old (24 hours)
      if (Date.now() - data.timestamp > 86400000) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }

      // Restore cache (filter out expired entries)
      for (const [key, entry] of data.cache) {
        if (!this.isExpired(entry)) {
          this.cache.set(key, entry);
        }
      }

      // Restore state
      this.state = { ...data.state, status: 'disconnected' }; // Reset connection status
      console.log(`[WolframMCP] Restored ${this.cache.size} cached entries`);
    } catch (error) {
      console.warn('[WolframMCP] Failed to load cache:', error);
    }
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
    localStorage.removeItem(STORAGE_KEY);
    console.log('[WolframMCP] Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; hitRate: number; fallbackRate: number } {
    const total = this.state.cacheHits + this.state.cacheMisses;
    return {
      size: this.cache.size,
      hitRate: total > 0 ? this.state.cacheHits / total : 0,
      fallbackRate: total > 0 ? this.state.fallbackCount / total : 0,
    };
  }
}

// Singleton instance
let instance: WolframMCPManager | null = null;

export function getWolframMCPManager(): WolframMCPManager {
  if (!instance) {
    instance = new WolframMCPManager();
  }
  return instance;
}

export default WolframMCPManager;
