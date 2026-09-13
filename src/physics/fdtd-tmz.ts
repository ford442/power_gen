/**
 * 2D TM_z Yee FDTD slice — shared constants, uniform packing, and a CPU
 * reference kernel (ADR-0010).
 *
 * This is a classroom "see the wave" slice, not a design tool: one plane of
 * (Ez, Hx, Hy) on a square grid in normalized units (ε = μ = c = Δx = 1), a
 * graded-loss sponge at the edges, and a soft J_z current source. There is no
 * 3D, no FEM, no material model beyond vacuum. `passes/fdtd-tmz-compute.wgsl`
 * runs the same update on the GPU; the CPU kernel here is the reference the
 * contract test (`scripts/test-fdtd-slice.mjs`) checks for stability and edge
 * absorption, and the seed for a future micro-grid fallback.
 *
 * Deliberately dependency-free so Node can import it through a bare esbuild
 * transform.
 *
 * Update (per step, Courant number S = Δt·c/Δx):
 *   Hx ← da·Hx − db·S·(Ez[x, y+1] − Ez[x, y])
 *   Hy ← da·Hy + db·S·(Ez[x+1, y] − Ez[x, y])
 *   Ez ← ca·Ez + cb·S·((Hy[x] − Hy[x−1]) − (Hx[y] − Hx[y−1]) − J)
 * with ca = da = (1 − s)/(1 + s), cb = db = 1/(1 + s), s = σ·S/2 graded
 * cubically across the sponge. Matching electric and magnetic loss keeps the
 * sponge impedance-matched to vacuum at normal incidence. Outer Ez ring is PEC.
 */

/** Cells per side. 256² ≈ 0.8 MB across the three field buffers. */
export const FDTD_GRID_N = 256;
/** Sponge depth in cells on every edge. */
export const FDTD_PML_CELLS = 28;
/** Courant number; 2D stability limit is 1/√2 ≈ 0.707. */
export const FDTD_COURANT = 0.5;
/** Peak half-step loss s = σ·S/2 at the outer edge of the sponge. */
export const FDTD_LOSS_MAX = 0.12;
/** Gaussian source blob radius, cells. Wider than one cell to keep the drive band-limited. */
export const FDTD_SOURCE_RADIUS = 1.6;
/** Uniform array capacity (`sources: array<vec4f, 16>`). */
export const FDTD_MAX_SOURCES = 16;
/** Bytes of `FdtdParams` in fdtd-tmz-compute.wgsl. */
export const FDTD_PARAMS_BYTES = 32 + FDTD_MAX_SOURCES * 16;
/** Bytes of `FdtdSliceParams` in fdtd-slice.wgsl. */
export const FDTD_SLICE_PARAMS_BYTES = 32;
/** `@workgroup_size(8, 8)` in the compute shader. */
export const FDTD_WORKGROUP = 8;
/** Yee steps per rendered frame at `high`. Wave front moves S·steps cells/frame. */
export const FDTD_STEPS_PER_FRAME = 6;

/** The only focus view that owns the slice today (drive source: coil current). */
export const FDTD_SLICE_OWNER = 'pulse-coil';

export interface FdtdSource {
  /** grid cell coordinates (float) */
  x: number;
  y: number;
  /** signed normalized current density J_z */
  amp: number;
  /**
   * Winding direction marker for the slice overlay (+1 out of the plane,
   * −1 into it). Defaults to sign(amp); set it so a zero-current winding
   * still draws with the right symbol.
   */
  polarity?: number;
}

export interface FdtdGridConfig {
  n: number;
  pmlCells: number;
  courant: number;
  lossMax: number;
  sourceRadius: number;
}

export const FDTD_DEFAULT_CONFIG: Readonly<FdtdGridConfig> = Object.freeze({
  n: FDTD_GRID_N,
  pmlCells: FDTD_PML_CELLS,
  courant: FDTD_COURANT,
  lossMax: FDTD_LOSS_MAX,
  sourceRadius: FDTD_SOURCE_RADIUS
});

/**
 * Half-step loss s at a (possibly half-integer) grid position. Mirrors
 * `lossAt` in the WGSL — keep the two in lockstep.
 */
export function fdtdLossAt(px: number, py: number, cfg: FdtdGridConfig = FDTD_DEFAULT_CONFIG): number {
  const edge = cfg.n - 1;
  const p = cfg.pmlCells;
  const d = Math.max(p - px, px - (edge - p), p - py, py - (edge - p), 0);
  const t = Math.min(d / p, 1);
  return cfg.lossMax * t * t * t;
}

/**
 * Pack `FdtdParams` (see fdtd-tmz-compute.wgsl):
 *   n u32 · pmlCells u32 · courant f32 · lossMax f32 ·
 *   sourceCount u32 · sourceRadius f32 · pad · pad ·
 *   sources array<vec4f, 16> (x, y, amp, polarity)
 */
export function packFdtdParams(
  sources: readonly FdtdSource[],
  cfg: FdtdGridConfig = FDTD_DEFAULT_CONFIG,
  out?: Float32Array
): Float32Array {
  const data = out && out.length >= FDTD_PARAMS_BYTES / 4 ? out : new Float32Array(FDTD_PARAMS_BYTES / 4);
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length);
  const count = Math.min(sources.length, FDTD_MAX_SOURCES);
  data.fill(0);
  u32[0] = cfg.n;
  u32[1] = cfg.pmlCells;
  data[2] = cfg.courant;
  data[3] = cfg.lossMax;
  u32[4] = count;
  data[5] = cfg.sourceRadius;
  for (let i = 0; i < count; i++) {
    const s = sources[i];
    const o = 8 + i * 4;
    data[o] = s.x;
    data[o + 1] = s.y;
    data[o + 2] = Number.isFinite(s.amp) ? s.amp : 0;
    data[o + 3] = s.polarity ?? Math.sign(data[o + 2]);
  }
  return data;
}

/** World offset within the slice square (−halfExtent..halfExtent) → grid cell. */
export function fdtdWorldToCell(w: number, halfExtent: number, n = FDTD_GRID_N): number {
  return (w / halfExtent * 0.5 + 0.5) * (n - 1);
}

export interface FdtdGateInput {
  /** `?fdtd=0` kill switch */
  enabled: boolean;
  /** pipelines + buffers built */
  ready: boolean;
  currentView: string | null | undefined;
  qualityTier: string | null | undefined;
}

/** Focus view of the owning device, at `high` (or a future `ultra`) tier only. */
export function fdtdSliceGateOpen(g: FdtdGateInput): boolean {
  return g.enabled
    && g.ready
    && g.currentView === FDTD_SLICE_OWNER
    && (g.qualityTier === 'high' || g.qualityTier === 'ultra');
}

/** CPU reference grid. Same update and indexing (`x + y·n`) as the WGSL. */
export class FdtdTmzGrid {
  readonly cfg: FdtdGridConfig;
  readonly ez: Float32Array;
  readonly hx: Float32Array;
  readonly hy: Float32Array;
  private readonly lossE: Float32Array;
  private readonly lossHx: Float32Array;
  private readonly lossHy: Float32Array;
  private readonly j: Float32Array;

  constructor(cfg: Partial<FdtdGridConfig> = {}) {
    this.cfg = { ...FDTD_DEFAULT_CONFIG, ...cfg };
    const { n } = this.cfg;
    this.ez = new Float32Array(n * n);
    this.hx = new Float32Array(n * n);
    this.hy = new Float32Array(n * n);
    this.lossE = new Float32Array(n * n);
    this.lossHx = new Float32Array(n * n);
    this.lossHy = new Float32Array(n * n);
    this.j = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = x + y * n;
        this.lossE[i] = fdtdLossAt(x, y, this.cfg);
        this.lossHx[i] = fdtdLossAt(x, y + 0.5, this.cfg);
        this.lossHy[i] = fdtdLossAt(x + 0.5, y, this.cfg);
      }
    }
  }

  reset(): void {
    this.ez.fill(0);
    this.hx.fill(0);
    this.hy.fill(0);
  }

  /** Rasterize soft sources into J (same Gaussian as the shader's `sourceJ`). */
  setSources(sources: readonly FdtdSource[]): void {
    const { n, sourceRadius: r } = this.cfg;
    this.j.fill(0);
    const inv2r2 = 1 / (2 * r * r);
    const reach = Math.ceil(r * 3);
    for (const s of sources.slice(0, FDTD_MAX_SOURCES)) {
      const x0 = Math.max(1, Math.floor(s.x) - reach);
      const x1 = Math.min(n - 2, Math.ceil(s.x) + reach);
      const y0 = Math.max(1, Math.floor(s.y) - reach);
      const y1 = Math.min(n - 2, Math.ceil(s.y) + reach);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - s.x;
          const dy = y - s.y;
          const r2 = dx * dx + dy * dy;
          if (r2 < 9 * r * r) this.j[x + y * n] += s.amp * Math.exp(-r2 * inv2r2);
        }
      }
    }
  }

  step(): void {
    const { n, courant: S } = this.cfg;
    const { ez, hx, hy, j } = this;
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const i = x + y * n;
        const sx = this.lossHx[i];
        const sy = this.lossHy[i];
        hx[i] = ((1 - sx) * hx[i] - S * (ez[i + n] - ez[i])) / (1 + sx);
        hy[i] = ((1 - sy) * hy[i] + S * (ez[i + 1] - ez[i])) / (1 + sy);
      }
    }
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = x + y * n;
        const s = this.lossE[i];
        const curl = (hy[i] - hy[i - 1]) - (hx[i] - hx[i - n]);
        ez[i] = ((1 - s) * ez[i] + S * (curl - j[i])) / (1 + s);
      }
    }
  }

  /** Σ(Ez² + Hx² + Hy²) over the interior (sponge excluded). */
  interiorEnergy(): number {
    const { n, pmlCells: p } = this.cfg;
    let e = 0;
    for (let y = p; y < n - p; y++) {
      for (let x = p; x < n - p; x++) {
        const i = x + y * n;
        e += this.ez[i] * this.ez[i] + this.hx[i] * this.hx[i] + this.hy[i] * this.hy[i];
      }
    }
    return e;
  }
}
