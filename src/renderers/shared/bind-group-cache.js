/**
 * Tiny stable bind-group cache keyed by string.
 * Resources (GPUBuffer / GPUTexture views) must remain valid for the key lifetime.
 * Call invalidate() after resize / buffer recreation.
 */
export class BindGroupCache {
  constructor() {
    /** @type {Map<string, GPUBindGroup>} */
    this._map = new Map();
  }

  /**
   * @param {string} key
   * @param {() => GPUBindGroup} factory
   * @returns {GPUBindGroup}
   */
  get(key, factory) {
    let bg = this._map.get(key);
    if (!bg) {
      bg = factory();
      this._map.set(key, bg);
    }
    return bg;
  }

  /** Drop one or all cached groups (does not destroy GPU resources). */
  invalidate(key) {
    if (key === undefined) {
      this._map.clear();
      return;
    }
    this._map.delete(key);
  }

  get size() {
    return this._map.size;
  }
}
