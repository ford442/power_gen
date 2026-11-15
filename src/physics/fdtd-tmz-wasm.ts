/**
 * The C++ FDTD TM_z kernel (cpp/src/plant/fdtd_tmz.cpp, #254 §5) behind the
 * same {@link FdtdGridLike} face as the TS reference in fdtd-tmz.ts.
 *
 * The WebGL2 micro-grid uses this under `?wasmPhysics=1` once sim_core is
 * loaded; the TS kernel stays the reference and the default. Fields are
 * zero-copy `Float32Array` views over the WASM heap, rebuilt whenever the heap
 * grows (a grown `memory.buffer` detaches the old views). `npm run test:fdtd`
 * holds this kernel, the TS one and the (transpiled) WGSL to each other.
 */
import {
  FDTD_DEFAULT_CONFIG,
  FDTD_MATERIAL_COMPONENTS,
  FDTD_MAX_SOURCES,
  buildFdtdMaterialMap,
  type FdtdGridConfig,
  type FdtdGridLike,
  type FdtdMaterialRegion,
  type FdtdSource
} from './fdtd-tmz';
import type { FdtdTmzGridInstance, SimCoreModule } from '../wasm/sim-core/abi.generated';

export class WasmFdtdTmzGrid implements FdtdGridLike {
  readonly backend = 'wasm';
  readonly cfg: FdtdGridConfig;
  private readonly native: FdtdTmzGridInstance;
  private readonly packed = new Float32Array(FDTD_MAX_SOURCES * 4);
  private views: { buffer: ArrayBufferLike; ez: Float32Array; hx: Float32Array; hy: Float32Array } | null = null;

  constructor(private readonly mod: SimCoreModule, cfg: Partial<FdtdGridConfig> = {}) {
    this.cfg = { ...FDTD_DEFAULT_CONFIG, ...cfg };
    this.native = new mod.FdtdTmzGrid();
    const { n, pmlCells, courant, lossMax, sourceRadius } = this.cfg;
    if (!this.native.init(n, pmlCells, courant, lossMax, sourceRadius)) {
      this.native.delete();
      throw new Error(`[fdtd] C++ grid refused n=${n} pml=${pmlCells} S=${courant}`);
    }
  }

  private fields(): NonNullable<WasmFdtdTmzGrid['views']> {
    const heap = this.mod.HEAPF32;
    if (!this.views || this.views.buffer !== heap.buffer) {
      const cells = this.cfg.n * this.cfg.n;
      const at = (ptr: number) => new Float32Array(heap.buffer, ptr, cells);
      this.views = { buffer: heap.buffer, ez: at(this.native.ezPtr()), hx: at(this.native.hxPtr()), hy: at(this.native.hyPtr()) };
    }
    return this.views;
  }

  get ez(): Float32Array { return this.fields().ez; }
  get hx(): Float32Array { return this.fields().hx; }
  get hy(): Float32Array { return this.fields().hy; }
  get hasMaterials(): boolean { return this.native.hasMaterials(); }

  setMaterials(materials: Float32Array | readonly FdtdMaterialRegion[] | null | undefined): void {
    if (!materials) {
      this.native.clearMaterials();
      return;
    }
    const map = materials instanceof Float32Array ? materials : buildFdtdMaterialMap(materials, this.cfg);
    const want = this.cfg.n * this.cfg.n * FDTD_MATERIAL_COMPONENTS;
    if (map.length < want) throw new Error(`[fdtd] material map has ${map.length} floats, need ${want}`);
    this.native.setMaterials(map.length === want ? map : map.subarray(0, want));
  }

  setSources(sources: readonly FdtdSource[]): void {
    const count = Math.min(sources.length, FDTD_MAX_SOURCES);
    for (let i = 0; i < count; i++) {
      const s = sources[i];
      this.packed[i * 4] = s.x;
      this.packed[i * 4 + 1] = s.y;
      this.packed[i * 4 + 2] = s.amp;
      this.packed[i * 4 + 3] = s.polarity ?? Math.sign(s.amp);
    }
    this.native.setSources(this.packed.subarray(0, count * 4));
  }

  step(count = 1): void {
    this.native.step(count);
  }

  reset(): void {
    this.native.reset();
  }

  interiorEnergy(): number {
    return this.native.interiorEnergy();
  }

  dispose(): void {
    this.native.delete();
    this.views = null;
  }
}
