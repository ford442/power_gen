/**
 * 2D TM_z Yee FDTD slice — shared constants, uniform packing, material map, and
 * a CPU reference kernel (ADR-0010, materials added by ADR-0012).
 *
 * This is a classroom "see the wave" slice, not a design tool: one plane of
 * (Ez, Hx, Hy) on a square grid in normalized units (ε = μ₀ = c = Δx = 1), a
 * graded-loss sponge at the edges, and a soft J_z current source. There is no
 * 3D and no FEM. `passes/fdtd-tmz-compute.wgsl` runs the same update on the
 * GPU; the CPU kernel here is the reference the contract test
 * (`scripts/test-fdtd-slice.mjs`) checks for stability and edge absorption, and
 * the kernel the WebGL2 micro-grid heatmap actually runs.
 *
 * Deliberately dependency-free so Node can import it through a bare esbuild
 * transform.
 *
 * Update (per step, Courant number S = Δt·c/Δx):
 *   Hx ← da·Hx − db·S·ν·(Ez[x, y+1] − Ez[x, y])
 *   Hy ← da·Hy + db·S·ν·(Ez[x+1, y] − Ez[x, y])
 *   Ez ← ca·Ez + cb·S·((Hy[x] − Hy[x−1]) − (Hx[y] − Hx[y−1]) − J)
 * with ca = da = (1 − s)/(1 + s), cb = db = 1/(1 + s).
 *
 * Two things feed `s`, and one feeds `ν`:
 *   - **Sponge:** s = σ·S/2 graded cubically across the edge band, applied to
 *     both E and H so the band stays impedance-matched to vacuum at normal
 *     incidence. Outer Ez ring is PEC behind it.
 *   - **Material σ** (ADR-0012): the cell's own electric loss, added to the
 *     sponge's. A copper winding turns into a strong absorber, so the field is
 *     pushed out of the conductor instead of passing through it.
 *   - **Material μ_r** (ADR-0012): ν = 1/μ_r on the H update, averaged across
 *     the two Ez nodes the H component sits between. A permeable armature slows
 *     the local wave (v = 1/√(εμ) < c) and bends the front — which is the whole
 *     point of the picture. μ_r ≥ 1 can only *reduce* the effective Courant
 *     number, so materials cannot destabilise a grid that was stable in vacuum.
 *
 * Vacuum is still the default: with no material map (or `?fdtdMaterials=0`) the
 * update is bit-for-bit the ADR-0010 kernel.
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
/** Floats per material cell: (1/μ_r, electric half-step loss) — an `array<vec2f>`. */
export const FDTD_MATERIAL_COMPONENTS = 2;
/** `params.materialFlags` bit 0: apply the material map at all. */
export const FDTD_FLAG_MATERIALS = 1;

/** The only focus view that owns the slice (the panel stands in front of it). */
export const FDTD_SLICE_OWNER = 'pulse-coil';

/**
 * Where the source amplitude comes from (ADR-0012). The *geometry* is always
 * the pulse coil's winding cross-sections — the panel lives in its focus view —
 * but the modulation may be borrowed from another bench:
 *
 *   coil        — the pulse coil's own capacitor-discharge current (default).
 *                 One big unipolar transient per shot.
 *   transformer — the transformer bench's normalised core flux. Continuous AC,
 *                 so the panel shows a standing pattern of successive fronts
 *                 instead of a single pulse. Honest because it is that device's
 *                 simulated flux, labelled as such — not a second solver.
 */
export const FDTD_DRIVE_SOURCES = {
  COIL: 'coil',
  TRANSFORMER: 'transformer'
} as const;

export type FdtdDriveSource = (typeof FDTD_DRIVE_SOURCES)[keyof typeof FDTD_DRIVE_SOURCES];

/** Catalog device each drive source reads its telemetry from. */
export const FDTD_DRIVE_DEVICE: Record<FdtdDriveSource, string> = {
  coil: 'pulse-coil',
  transformer: 'transformer'
};

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
 * One material patch stamped into the grid (ADR-0012).
 *
 * `muR` and `sigma` are **display** numbers, not SI: the grid runs in
 * normalized units, so σ is "how many half-steps of loss per cell" once scaled
 * by the Courant number, and μ_r is a straight ratio. Values are chosen so the
 * picture reads correctly at 256², not so a solver would agree — see
 * {@link FDTD_MATERIAL_PRESETS}.
 */
export interface FdtdMaterialRegion {
  /** Axis-aligned box (`halfW`/`halfH`) or a circle (`radius`), in cells. */
  shape: 'rect' | 'disk';
  x: number;
  y: number;
  halfW?: number;
  halfH?: number;
  radius?: number;
  /** Relative permeability, ≥ 1. Slows and bends the local wave. */
  muR?: number;
  /** Normalized conductivity, ≥ 0. Damps E, so the field avoids the cell. */
  sigma?: number;
  /** Label for the legend / docs. Not used by the kernel. */
  label?: string;
}

/**
 * Display material values for the two things the pulse coil is actually made of.
 *
 * Real soft iron is μ_r ≈ 2000–5000 and real copper is σ ≈ 6·10⁷ S/m. Neither
 * number belongs on a 256² normalized grid: μ_r = 2000 would slow the wave by
 * ~45× and the armature would simply go black within a frame, and a σ that large
 * is a perfect mirror one cell thick. These are the *teaching* values — enough
 * μ_r to visibly refract and enough σ to visibly exclude — and the UI says so.
 */
export const FDTD_MATERIAL_PRESETS = Object.freeze({
  /** Soft-iron armature slug: refracts and holds flux. */
  IRON_MU_R: 24,
  /** Copper winding cross-section: strong absorber, field excluded. */
  COPPER_SIGMA: 3.0,
  /** Vacuum / air. */
  VACUUM_MU_R: 1,
  VACUUM_SIGMA: 0
});

/** σ (normalized) → half-step electric loss s = σ·S/2, matching the sponge. */
export function fdtdSigmaToLoss(sigma: number, courant = FDTD_COURANT): number {
  const s = Number.isFinite(sigma) ? Math.max(0, sigma) : 0;
  return (s * courant) / 2;
}

/** μ_r → the 1/μ_r factor the H update multiplies the Ez curl by. */
export function fdtdMuToInv(muR: number): number {
  const m = Number.isFinite(muR) ? Math.max(1, muR) : 1;
  return 1 / m;
}

/**
 * Rasterize material regions into an interleaved `(1/μ_r, eLoss)` map, i.e. the
 * `array<vec2f>` the shader binds. Later regions win where they overlap, so a
 * winding drawn after the armature reads as copper, not iron.
 *
 * Vacuum cells stay exactly `(1, 0)`, which makes the update identical to the
 * ADR-0010 kernel wherever no region was stamped.
 */
export function buildFdtdMaterialMap(
  regions: readonly FdtdMaterialRegion[],
  cfg: FdtdGridConfig = FDTD_DEFAULT_CONFIG,
  out?: Float32Array
): Float32Array {
  const { n } = cfg;
  const len = n * n * FDTD_MATERIAL_COMPONENTS;
  const map = out && out.length >= len ? out : new Float32Array(len);
  for (let i = 0; i < len; i += FDTD_MATERIAL_COMPONENTS) {
    map[i] = 1;      // 1/μ_r
    map[i + 1] = 0;  // electric loss
  }
  for (const r of regions) {
    const invMu = fdtdMuToInv(r.muR ?? 1);
    const eLoss = fdtdSigmaToLoss(r.sigma ?? 0, cfg.courant);
    const reachX = r.shape === 'disk' ? (r.radius ?? 0) : (r.halfW ?? 0);
    const reachY = r.shape === 'disk' ? (r.radius ?? 0) : (r.halfH ?? 0);
    const x0 = Math.max(0, Math.floor(r.x - reachX));
    const x1 = Math.min(n - 1, Math.ceil(r.x + reachX));
    const y0 = Math.max(0, Math.floor(r.y - reachY));
    const y1 = Math.min(n - 1, Math.ceil(r.y + reachY));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (r.shape === 'disk') {
          const dx = x - r.x;
          const dy = y - r.y;
          const rad = r.radius ?? 0;
          if (dx * dx + dy * dy > rad * rad) continue;
        }
        const i = (x + y * n) * FDTD_MATERIAL_COMPONENTS;
        map[i] = invMu;
        map[i + 1] = eLoss;
      }
    }
  }
  return map;
}

/** True when a map has anything but vacuum in it (skip the upload otherwise). */
export function fdtdMaterialMapIsVacuum(map: Float32Array | null | undefined): boolean {
  if (!map) return true;
  for (let i = 0; i < map.length; i += FDTD_MATERIAL_COMPONENTS) {
    if (map[i] !== 1 || map[i + 1] !== 0) return false;
  }
  return true;
}

/**
 * Pack `FdtdParams` (see fdtd-tmz-compute.wgsl):
 *   n u32 · pmlCells u32 · courant f32 · lossMax f32 ·
 *   sourceCount u32 · sourceRadius f32 · materialFlags u32 · pad ·
 *   sources array<vec4f, 16> (x, y, amp, polarity)
 */
export function packFdtdParams(
  sources: readonly FdtdSource[],
  cfg: FdtdGridConfig = FDTD_DEFAULT_CONFIG,
  out?: Float32Array,
  opts: { materials?: boolean } = {}
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
  u32[6] = opts.materials ? FDTD_FLAG_MATERIALS : 0;
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
  /** Interleaved (1/μ_r, eLoss) per cell, or null for vacuum everywhere. */
  private materials: Float32Array | null = null;

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

  /**
   * Install a material map from {@link buildFdtdMaterialMap} (or region list),
   * or `null` for vacuum. Passing regions rasterizes them for you.
   */
  setMaterials(
    materials: Float32Array | readonly FdtdMaterialRegion[] | null | undefined
  ): void {
    if (!materials) {
      this.materials = null;
      return;
    }
    const map = materials instanceof Float32Array
      ? materials
      : buildFdtdMaterialMap(materials, this.cfg);
    const want = this.cfg.n * this.cfg.n * FDTD_MATERIAL_COMPONENTS;
    if (map.length < want) {
      throw new Error(`[fdtd] material map has ${map.length} floats, need ${want}`);
    }
    // A vacuum map is the same as none, and skipping it keeps `step()` on the
    // ADR-0010 fast path.
    this.materials = fdtdMaterialMapIsVacuum(map) ? null : map;
  }

  /** True when `step()` is applying a material map this frame. */
  get hasMaterials(): boolean {
    return this.materials !== null;
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
    const mat = this.materials;
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const i = x + y * n;
        const sx = this.lossHx[i];
        const sy = this.lossHy[i];
        // 1/μ_r averaged across the two Ez nodes each H component sits between
        // (a one-sided value would bias the front by half a cell at a boundary).
        let nuX = 1;
        let nuY = 1;
        if (mat) {
          const m = i * FDTD_MATERIAL_COMPONENTS;
          const here = mat[m];
          nuX = 0.5 * (here + mat[m + n * FDTD_MATERIAL_COMPONENTS]);
          nuY = 0.5 * (here + mat[m + FDTD_MATERIAL_COMPONENTS]);
        }
        hx[i] = ((1 - sx) * hx[i] - S * nuX * (ez[i + n] - ez[i])) / (1 + sx);
        hy[i] = ((1 - sy) * hy[i] + S * nuY * (ez[i + 1] - ez[i])) / (1 + sy);
      }
    }
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = x + y * n;
        // Sponge loss and the cell's own σ loss add: a conductor inside the
        // sponge is absorbing for both reasons.
        const s = this.lossE[i] + (mat ? mat[i * FDTD_MATERIAL_COMPONENTS + 1] : 0);
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
