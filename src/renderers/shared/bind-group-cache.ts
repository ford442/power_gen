/**
 * Tiny stable bind-group cache keyed by string.
 * Resources (GPUBuffer / GPUTexture views) must remain valid for the key lifetime.
 * Call invalidate() after resize / buffer recreation.
 */
export class BindGroupCache {
  private _map = new Map<string, GPUBindGroup>();

  get(key: string, factory: () => GPUBindGroup): GPUBindGroup {
    let bg = this._map.get(key);
    if (!bg) {
      bg = factory();
      this._map.set(key, bg);
    }
    return bg;
  }

  /** Drop one or all cached groups (does not destroy GPU resources). */
  invalidate(key?: string): void {
    if (key === undefined) {
      this._map.clear();
      return;
    }
    this._map.delete(key);
  }

  get size(): number {
    return this._map.size;
  }
}
