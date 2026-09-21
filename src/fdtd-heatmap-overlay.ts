/**
 * WebGL2 FDTD micro-grid heatmap (ADR-0012).
 *
 * ADR-0001 keeps WebGL2 a fallback, and ADR-0010 accordingly gave it no wave
 * slice at all — the WebGPU panel is a compute pass plus a scene-pass quad,
 * neither of which has a cheap GLSL equivalent worth maintaining. That left the
 * fallback with no answer to the one question the slice exists to answer.
 *
 * So instead of porting the pass, this runs the **same CPU kernel** the contract
 * test checks (`FdtdTmzGrid`, the ADR-0010 reference) on a deliberately tiny
 * grid and paints it into a 2D canvas over the corner of the viewport:
 *
 *   - {@link MICRO_GRID_N}² cells instead of 256² — ~1/16 the work per step
 *   - {@link MICRO_STEPS_PER_FRAME} Yee steps per frame, so a front still
 *     crosses the panel in about a second (the grid is 4× smaller per side)
 *   - the same material map (μ_r armature, copper turns) and the same sources,
 *     placed by world position, so it is the same picture at lower resolution
 *
 * It sits bottom-left rather than bottom-right, because the tachometer owns that
 * corner and an RPM readout matters more than a wave picture.
 *
 * It is a **readout, not a render path**: no GL state, no shader, no interaction
 * with the WebGL2 renderer beyond reading TelemetryHub. It therefore cannot
 * regress the fallback's frame budget in any way a `?fdtd=0` cannot switch off.
 *
 * Gates: WebGL2 only (the WebGPU path has the real panel), pulse-coil focus
 * only, and `?fdtd=0` kills it. Hidden — and stepped down to nothing — the
 * moment any of those stop holding.
 */
import {
  FDTD_DEFAULT_CONFIG,
  FDTD_DRIVE_DEVICE,
  FDTD_DRIVE_SOURCES,
  FDTD_SLICE_OWNER,
  FdtdTmzGrid,
  buildFdtdMaterialMap,
  type FdtdDriveSource,
  type FdtdSource
} from './physics/fdtd-tmz';
import {
  pulseCoilFdtdDrive,
  pulseCoilFdtdMaterials,
  pulseCoilFdtdSources,
  transformerFdtdDrive
} from './devices/quanta/pulse-coil';
import { parseFdtdEnabled, parseFdtdMaterialsEnabled } from './renderers/shared/url-params';
import { telemetryHub } from './telemetry-hub';
import type { TelemetrySnapshot } from './telemetry/types';

/** Cells per side. 64² × 2 steps is ~30 k stencil updates/frame on one thread. */
export const MICRO_GRID_N = 64;
/** Sponge depth, scaled from the 256² grid's 28 so the profile is the same shape. */
export const MICRO_PML_CELLS = 7;
/** Yee steps per frame. Front crosses in ~64/(0.5·2) ≈ 64 frames ≈ 1 s. */
export const MICRO_STEPS_PER_FRAME = 2;
/** Source blob radius in cells, scaled down with the grid. */
export const MICRO_SOURCE_RADIUS = 0.8;
/** Frames for the drive to cover ~63 % of a jump (matches FdtdSlicePass). */
const DRIVE_SLEW_FRAMES = 4;
/** tanh gains — same role as EZ_GAIN / H_GAIN in the WebGPU panel. */
const EZ_GAIN = 3.5;
const H_GAIN = 1.5;

export const MICRO_GRID_CONFIG = Object.freeze({
  n: MICRO_GRID_N,
  pmlCells: MICRO_PML_CELLS,
  courant: FDTD_DEFAULT_CONFIG.courant,
  lossMax: FDTD_DEFAULT_CONFIG.lossMax,
  sourceRadius: MICRO_SOURCE_RADIUS
});

export interface FdtdHeatmapOptions {
  /** Test seam: override the hub subscription. */
  subscribe?: (fn: (snap: TelemetrySnapshot) => void) => () => void;
  enabled?: boolean;
  materialsEnabled?: boolean;
  driveSource?: FdtdDriveSource;
}

/**
 * Map a field sample to the panel's colours — the same scheme as
 * `passes/fdtd-slice.wgsl` so the two backends read alike: warm for +Ez, cool
 * for −Ez, green for |H|, violet where the material map is permeable.
 */
export function heatmapPixel(
  ez: number,
  hMag: number,
  permeable: number,
  conductive: number
): [number, number, number] {
  const e = Math.tanh(ez * EZ_GAIN);
  const h = Math.tanh(hMag * H_GAIN);
  let r = 6;
  let g = 10;
  let b = 16;
  const matA = Math.max(permeable, conductive) * 0.5;
  if (matA > 0) {
    const iron = permeable > conductive;
    const mr = iron ? 107 : 77;
    const mg = iron ? 77 : 87;
    const mb = iron ? 158 : 102;
    r += (mr - r) * matA;
    g += (mg - g) * matA;
    b += (mb - b) * matA;
  }
  const hA = h * 0.55;
  r += (77 - r) * hA;
  g += (242 - g) * hA;
  b += (140 - b) * hA;
  const eA = Math.abs(e);
  const [er, eg, eb] = e > 0 ? [255, 107, 31] : [38, 128, 255];
  r += (er - r) * eA;
  g += (eg - g) * eA;
  b += (eb - b) * eA;
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/** Signed drive from a telemetry snapshot, matching the WebGPU path's choice. */
export function heatmapDriveFromSnapshot(
  snap: TelemetrySnapshot,
  source: FdtdDriveSource
): number {
  if (source === FDTD_DRIVE_SOURCES.TRANSFORMER) {
    const t = snap.devices?.[FDTD_DRIVE_DEVICE.transformer];
    if (t) return transformerFdtdDrive(t);
  }
  return pulseCoilFdtdDrive(snap.devices?.[FDTD_SLICE_OWNER]);
}

export class FdtdHeatmapOverlay {
  readonly enabled: boolean;
  readonly driveSource: FdtdDriveSource;
  readonly materialsEnabled: boolean;
  /** True while the overlay is visible and stepping. */
  active = false;

  private grid: FdtdTmzGrid | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private readonly unitSources: FdtdSource[];
  private readonly frameSources: FdtdSource[];
  private readonly materialMap: Float32Array | null;
  private drive = 0;
  private raf = 0;
  private unsubscribe: (() => void) | null = null;
  /**
   * Drive the grid aims for, refreshed from every telemetry snapshot. Public so
   * an agent or a bug report can force the panel without running the plant —
   * `window.fdtdHeatmapOverlay.driveTarget = 1.2` then watch it propagate.
   */
  driveTarget = 0;
  private shouldRun = false;
  private steps = 0;

  constructor(opts: FdtdHeatmapOptions = {}) {
    this.enabled = opts.enabled ?? parseFdtdEnabled();
    // Always the coil, unless a caller insists. `?fdtdDrive=transformer` needs
    // the transformer's plant kept running while another bench is focused, and
    // the WebGPU pass does that from the render loop (`_stepBorrowedDrivePlant`).
    // This overlay only reads TelemetryHub — it has no device instances to step —
    // so honouring the flag here would show a value frozen at 0. A documented
    // limitation beats a panel that is quietly dead (docs/WEBGL2.md).
    this.driveSource = opts.driveSource ?? FDTD_DRIVE_SOURCES.COIL;
    this.materialsEnabled = opts.materialsEnabled ?? parseFdtdMaterialsEnabled();
    this.unitSources = pulseCoilFdtdSources(MICRO_GRID_N);
    this.frameSources = this.unitSources.map((s) => ({ ...s }));
    this.materialMap = this.materialsEnabled
      ? buildFdtdMaterialMap(pulseCoilFdtdMaterials(MICRO_GRID_N), MICRO_GRID_CONFIG)
      : null;
    const subscribe = opts.subscribe ?? ((fn) => telemetryHub.subscribe(fn));
    if (this.enabled) this.unsubscribe = subscribe((snap) => this.onSnapshot(snap));
  }

  /** WebGL2 + pulse-coil focus + `?fdtd` on. */
  private gateOpen(snap: TelemetrySnapshot): boolean {
    return this.enabled
      && snap.renderer === 'webgl2'
      && snap.view === FDTD_SLICE_OWNER;
  }

  private onSnapshot(snap: TelemetrySnapshot): void {
    this.driveTarget = heatmapDriveFromSnapshot(snap, this.driveSource);
    const open = this.gateOpen(snap);
    if (open === this.shouldRun) return;
    this.shouldRun = open;
    if (open) this.show();
    else this.hide();
  }

  private show(): void {
    if (typeof document === 'undefined') return;
    if (!this.root) this.mount();
    if (!this.grid) {
      this.grid = new FdtdTmzGrid(MICRO_GRID_CONFIG);
      this.grid.setMaterials(this.materialMap);
    } else {
      // Leaving and re-entering focus should not resume a stale wave.
      this.grid.reset();
    }
    this.drive = 0;
    this.steps = 0;
    if (this.root) this.root.hidden = false;
    this.active = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
  }

  private hide(): void {
    this.active = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.root) this.root.hidden = true;
  }

  private mount(): void {
    const root = document.createElement('div');
    root.id = 'fdtd-heatmap-overlay';
    root.hidden = true;
    root.innerHTML = `
      <div class="fdtd-heatmap-title">Wave slice · CPU micro-grid</div>
      <canvas class="fdtd-heatmap-canvas" width="${MICRO_GRID_N}" height="${MICRO_GRID_N}"></canvas>
      <div class="fdtd-heatmap-note">
        ${MICRO_GRID_N}² TM<sub>z</sub> · light slowed for display${
          this.materialsEnabled ? ' · μ<sub>r</sub> armature + copper turns' : ' · vacuum'
        }
      </div>
    `;
    const styles = document.createElement('style');
    styles.id = 'fdtd-heatmap-styles';
    styles.textContent = `
      /*
       * Bottom-LEFT, above #corner-bl's one-line mode label. Not the
       * bottom-right corner: #tachometer lives there (absolute, bottom 8px,
       * right 8px, 140px wide) and this panel is ~195px across, so it would
       * cover the RPM readout outright.
       */
      #fdtd-heatmap-overlay {
        position: absolute; left: 12px; bottom: 34px; z-index: 5;
        background: rgba(2, 10, 18, 0.88); border: 1px solid #0ff3;
        border-radius: 5px; padding: 6px 8px 5px;
        /* A readout, not a control: never eat a camera drag. */
        pointer-events: none;
        font-size: 0.62rem; color: #8ad; line-height: 1.35;
      }
      #fdtd-heatmap-overlay[hidden] { display: none; }
      .fdtd-heatmap-title { color: #9cf; margin-bottom: 4px; letter-spacing: 0.04em; }
      .fdtd-heatmap-canvas {
        display: block; width: 176px; height: 176px;
        border: 1px solid #0ff2; border-radius: 3px; background: #030810;
      }
      .fdtd-heatmap-note { margin-top: 4px; color: #567; max-width: 176px; }
    `;
    if (!document.getElementById('fdtd-heatmap-styles')) document.head.appendChild(styles);
    (document.getElementById('canvas-wrapper') ?? document.body).appendChild(root);

    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.fdtd-heatmap-canvas');
    this.ctx = this.canvas?.getContext('2d') ?? null;
    if (this.ctx) this.image = this.ctx.createImageData(MICRO_GRID_N, MICRO_GRID_N);
  }

  /** One frame: slew the drive, step the grid, repaint. Exposed for tests. */
  step(): void {
    const grid = this.grid;
    if (!grid) return;
    const target = Number.isFinite(this.driveTarget) ? this.driveTarget : 0;
    this.drive += (target - this.drive) * (1 - Math.exp(-1 / DRIVE_SLEW_FRAMES));
    for (let i = 0; i < this.unitSources.length; i++) {
      this.frameSources[i].amp = this.unitSources[i].amp * this.drive;
    }
    grid.setSources(this.frameSources);
    for (let k = 0; k < MICRO_STEPS_PER_FRAME; k++) grid.step();
    this.steps += MICRO_STEPS_PER_FRAME;
    this.paint();
  }

  /**
   * Agent / e2e hook, in the spirit of `window.getRendererInfo()`: enough to tell
   * "the panel is running and the field is alive" from "the panel is a blank
   * rectangle", without reaching into the grid.
   */
  stats(): {
    active: boolean;
    steps: number;
    peakEz: number;
    finite: boolean;
    hasMaterials: boolean;
    drive: number;
  } {
    const g = this.grid;
    let peakEz = 0;
    let finite = true;
    if (g) {
      for (let i = 0; i < g.ez.length; i++) {
        const v = Math.abs(g.ez[i]);
        if (!Number.isFinite(v)) { finite = false; break; }
        if (v > peakEz) peakEz = v;
      }
    }
    return {
      active: this.active,
      steps: this.steps,
      peakEz,
      finite,
      hasMaterials: !!g?.hasMaterials,
      drive: this.drive
    };
  }

  private paint(): void {
    const grid = this.grid;
    const img = this.image;
    if (!grid || !img || !this.ctx) return;
    const n = MICRO_GRID_N;
    const data = img.data;
    const mat = this.materialMap;
    for (let y = 0; y < n; y++) {
      // Grid y points up the slice; canvas y points down.
      const row = (n - 1 - y) * n;
      for (let x = 0; x < n; x++) {
        const i = x + y * n;
        const hMag = Math.hypot(grid.hx[i], grid.hy[i]);
        const permeable = mat ? Math.min(1, Math.max(0, 1 - mat[i * 2])) : 0;
        const conductive = mat ? Math.min(1, Math.max(0, mat[i * 2 + 1] * 4)) : 0;
        const [r, g, b] = heatmapPixel(grid.ez[i], hMag, permeable, conductive);
        const o = (row + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }

  private tick(): void {
    if (!this.active) {
      this.raf = 0;
      return;
    }
    this.step();
    this.raf = requestAnimationFrame(() => this.tick());
  }

  destroy(): void {
    this.hide();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root?.remove();
    this.root = null;
    this.canvas = null;
    this.ctx = null;
    this.image = null;
    this.grid = null;
  }
}

/**
 * Install the overlay on the WebGL2 path. Safe to call on WebGPU too — the gate
 * keeps it hidden and unstepped, so nothing is allocated beyond the material map.
 */
export function initFdtdHeatmapOverlay(opts: FdtdHeatmapOptions = {}): FdtdHeatmapOverlay {
  const overlay = new FdtdHeatmapOverlay(opts);
  if (typeof window !== 'undefined') window.fdtdHeatmapOverlay = overlay;
  return overlay;
}
