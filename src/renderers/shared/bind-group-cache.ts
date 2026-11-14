/**
 * Tiny stable bind-group cache keyed by string.
 * Resources (GPUBuffer / GPUTexture views) must remain valid for the key lifetime.
 * Call invalidate() after resize / buffer recreation — or pass the resource
 * that varies under a key as `token`, and the group is rebuilt when it changes.
 */
export class BindGroupCache {
  private _map = new Map<string, { bg: GPUBindGroup; token: unknown }>();

  /**
   * @param token Identity of the resource the group was built from. A
   *   different token under the same key rebuilds the group. Without it, a
   *   key reused for a recreated buffer (focus-only glTF props are destroyed
   *   on leaving SEG and re-uploaded on return) kept a group pointing at the
   *   destroyed one: "Buffer used in submit while destroyed" every frame.
   */
  get(key: string, factory: () => GPUBindGroup, token?: unknown): GPUBindGroup {
    const hit = this._map.get(key);
    if (hit && hit.token === token) return hit.bg;
    const bg = factory();
    this._map.set(key, { bg, token });
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
