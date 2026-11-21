/**
 * Field panel (ADR-0017, #255 §4): probe readout and field-volume controls for
 * the focused bench, on both renderers.
 *
 *   - Readout: B at the probe (exact kernel sum — physics/field-probe.ts) in
 *     the unit that reads best, the probe point, and the model the catalog
 *     row declares. Always says "simulated, not metrology".
 *   - WebGPU: slice axis / offset / mode, isosurfaces, charged particles; a
 *     click on the slice plane moves the probe.
 *   - WebGL2 (and WebGPU below `medium`, where the volume is skipped): a CPU
 *     |B| slice, 32² exact samples painted into a 2-D canvas — the same
 *     colour ramp as the WebGPU slice, recomputed only when the sources or
 *     the plane move. A readout, not a render path (cf. fdtd-heatmap-overlay).
 *
 * Collapsed by default; hidden off-focus and on benches without a field row.
 */
import { BenchField, FIELD_SOURCE_CATALOG, hasBenchField } from './physics/field-bench';
import { maxSourceDelta } from './physics/field-sources';
import { fieldColormap, fieldColorT } from './physics/field-colormap';
import { fieldColorRange, raySliceHit, type FieldSliceAxis, type FieldSliceMode } from './physics/field-pack';
import { fieldProbePoint, readFieldProbe, setFieldProbeContext, setFieldProbePoint } from './physics/field-probe';
import { FIELD_SPECIES, type FieldParticlePlan, type FieldSpecies } from './physics/field-particles';
import { invertMat4, rayFromScreen } from './assets/gltf/gltf-pick';
import { labConfig, setLabUrlParam } from './config/lab-config';
import { onFrame } from './frame-clock';
import type { FieldReadout, FieldViewState } from './visualizer/field-volume-drive';
import type { SegLayout } from './devices/types';

const SLICE_N = 32;
const DRAG_PX = 6;

/** The slice of either visualizer this panel reads (both expose these). */
interface VisLike {
  currentView?: string;
  devices?: Record<string, { physicsState?: Record<string, unknown> | null; position?: ArrayLike<number> } | undefined>;
  segLayout?: SegLayout | null;
  segOmega?: number;
  time?: number;
  canvas?: HTMLCanvasElement;
  cameraController?: { getViewProjMatrix?: () => Float32Array; camera?: { position?: number[] } } | null;
  camera?: { camera?: { position?: number[] } } | null;
  fieldReadout?: FieldReadout | null;
  fieldView?: FieldViewState;
  session?: { segOmega?: number };
}

/** |B| in the unit that keeps 3 significant digits readable. */
export function formatTesla(t: number): string {
  const a = Math.abs(t);
  if (!Number.isFinite(t)) return '—';
  if (a >= 1) return `${t.toFixed(3)} T`;
  if (a >= 1e-3) return `${(t * 1e3).toFixed(a >= 0.1 ? 1 : 2)} mT`;
  if (a >= 1e-6) return `${(t * 1e6).toFixed(a >= 1e-4 ? 1 : 2)} µT`;
  return `${(t * 1e9).toFixed(1)} nT`;
}

function particleNote(plan: FieldParticlePlan | null): string {
  if (!plan) return '';
  const rg = plan.gyroRadiusM;
  const rgText = rg >= 1e-3 ? `${(rg * 1e3).toFixed(1)} mm` : `${(rg * 1e6).toFixed(0)} µm`;
  const time = `1 s shown ≈ ${plan.simSecondsPerSecond.toExponential(1)} s`;
  return plan.resolved
    ? `${FIELD_SPECIES[plan.species].label}: r_g ≈ ${rgText} · ${time}`
    : `${FIELD_SPECIES[plan.species].label}: r_g ≈ ${rgText}, below a pixel — guiding-centre motion, gyration not resolved · ${time}${plan.relativisticCap ? ' · launch capped at 5 % c' : ''}`;
}

export class FieldPanel {
  private root: HTMLElement | null = null;
  private els: Record<string, HTMLElement> = {};
  private slice2d: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private off: (() => void) | null = null;
  private readonly cpuBenches = new Map<string, BenchField>();
  private cpuKey = '';
  private cpuSnap = new Float32Array(0);
  private cpuSnapCount = -1;
  /** WebGL2 has no visualizer fieldView: the panel keeps its own. */
  private localView: FieldViewState;

  constructor(private readonly vis: () => VisLike | undefined, private readonly webgpu: () => boolean) {
    const c = labConfig();
    this.localView = { slice: c.fieldSlice, sliceOffset: 0.5, sliceMode: 'heat', iso: false, isoLevelsMt: null, particles: 'off' };
  }

  start(): void {
    if (typeof document === 'undefined') return;
    // SEG probes need the drawn layout; the WebGPU drive registers the same provider.
    setFieldProbeContext(() => {
      const v = this.vis();
      return v ? { time: v.time ?? 0, segLayout: v.segLayout ?? null, segOmega: v.segOmega ?? v.session?.segOmega ?? 0 } : null;
    });
    this.off = onFrame(() => this.tick(), { hz: 4 });
  }

  private view(): FieldViewState {
    const v = this.vis();
    return this.webgpu() && v?.fieldView ? v.fieldView : this.localView;
  }

  private setView(patch: Partial<FieldViewState>): void {
    const v = this.vis();
    if (this.webgpu() && v) v.fieldView = { ...this.view(), ...patch };
    else this.localView = { ...this.localView, ...patch };
    // Shareable fields follow the URL (no reload), like the layout control.
    if (patch.slice !== undefined) setLabUrlParam('fieldSlice', patch.slice);
    if (patch.sliceMode !== undefined) setLabUrlParam('fieldSliceMode', patch.sliceMode);
    if (patch.iso !== undefined) setLabUrlParam('fieldIso', patch.iso);
    if (patch.particles !== undefined) setLabUrlParam('fieldParticles', patch.particles);
    this.cpuKey = '';
  }

  private tick(): void {
    const v = this.vis();
    const id = v?.currentView ?? '';
    const device = id && id !== 'overview' ? v?.devices?.[id] : undefined;
    if (!v || !device || !hasBenchField(id)) {
      if (this.root) this.root.hidden = true;
      return;
    }
    if (!this.root) this.mount();
    this.root!.hidden = false;
    const state = device.physicsState ?? {};
    const gpu = this.webgpu();
    const readout = gpu ? v.fieldReadout : null;
    const B = readout?.deviceId === id ? readout.B : readFieldProbe(id, state).slice(0, 3);
    const point = fieldProbePoint(id, state);
    const mag = Math.hypot(B[0], B[1], B[2]);
    const view = this.view();
    const e = this.els;
    e.title.textContent = `Field · ${id}`;
    e.mag.textContent = `|B| ${formatTesla(mag)}`;
    e.comp.textContent = `Bx ${formatTesla(B[0])} · By ${formatTesla(B[1])} · Bz ${formatTesla(B[2])}`;
    e.point.textContent = `probe (${point.map((c) => c.toFixed(2)).join(', ')}) scene units`;
    e.model.textContent = `Model: ${FIELD_SOURCE_CATALOG[id]?.model ?? ''}`;
    e.model.title = e.model.textContent;
    const volumeLive = readout?.volume === 'gpu';
    e.volume.textContent = volumeLive
      ? `Volume ${readout!.n}³ on the GPU`
      : gpu ? 'Volume off below medium tier — CPU slice' : 'WebGL2: CPU slice (volume, iso, particles are WebGPU only)';
    for (const k of ['iso', 'particles', 'mode']) (e[`${k}Row`] as HTMLElement).hidden = !gpu;
    (e.slice as HTMLSelectElement).value = view.slice;
    (e.offset as HTMLInputElement).value = String(view.sliceOffset);
    (e.mode as HTMLSelectElement).value = view.sliceMode;
    (e.iso as HTMLInputElement).checked = view.iso;
    (e.particles as HTMLSelectElement).value = view.particles;
    e.particleNote.textContent = volumeLive ? particleNote(readout!.particles) : '';
    const showCpu = view.slice !== 'off' && !volumeLive;
    (e.cpu as HTMLElement).hidden = !showCpu;
    if (showCpu) this.paintCpuSlice(v, id, state, view.slice as Exclude<FieldSliceAxis, 'off'>, view.sliceOffset, readout?.bRefMt);
  }

  private paintCpuSlice(v: VisLike, id: string, state: Record<string, unknown>, axis: Exclude<FieldSliceAxis, 'off'>, offset: number, bRefMt?: number): void {
    let bench = this.cpuBenches.get(id);
    if (!bench) this.cpuBenches.set(id, (bench = new BenchField(id)));
    const seg = id === 'seg' && v.segLayout;
    bench.rebuild({ state, time: v.time ?? 0, segLayout: v.segLayout ?? null, segOmega: v.segOmega ?? 0, unitM: seg ? 1 / v.segLayout!.worldScale : undefined });
    const key = `${id}:${axis}:${offset.toFixed(3)}`;
    const changed = this.cpuSnapCount < 0 || maxSourceDelta(bench.sources.data, bench.sources.count, this.cpuSnap, this.cpuSnapCount) > 1e-3;
    if (key === this.cpuKey && !changed) return;
    this.cpuKey = key;
    this.cpuSnap = bench.sources.data.slice(0, bench.sources.count * 16);
    this.cpuSnapCount = bench.sources.count;
    const [lo, hi] = bounds(bench);
    const a = 'xyz'.indexOf(axis), ua = a === 0 ? 2 : 0, va = a === 1 ? 2 : 1;
    const ref = bRefMt ?? Math.max(1e-9, Math.hypot(...bench.probeT(...bench.decl.probe)) * 1000);
    const [cLo, cHi] = fieldColorRange(ref);
    const img = this.image!, data = img.data, p: [number, number, number] = [0, 0, 0], rgb: [number, number, number] = [0, 0, 0];
    p[a] = lo[a] + offset * (hi[a] - lo[a]);
    for (let j = 0; j < SLICE_N; j++) {
      p[va] = lo[va] + ((j + 0.5) / SLICE_N) * (hi[va] - lo[va]);
      for (let i = 0; i < SLICE_N; i++) {
        p[ua] = lo[ua] + ((i + 0.5) / SLICE_N) * (hi[ua] - lo[ua]);
        const B = bench.probeT(p[0], p[1], p[2]);
        fieldColormap(fieldColorT(Math.hypot(B[0], B[1], B[2]) * 1000, cLo, cHi), rgb);
        const o = ((SLICE_N - 1 - j) * SLICE_N + i) * 4;
        data[o] = rgb[0] * 255; data[o + 1] = rgb[1] * 255; data[o + 2] = rgb[2] * 255; data[o + 3] = 255;
      }
    }
    this.slice2d?.putImageData(img, 0, 0);
  }

  /** Click on the slice plane (WebGPU or WebGL2 camera) → move the probe there. */
  private onCanvasClick(e: MouseEvent): void {
    const v = this.vis();
    const view = this.view();
    const id = v?.currentView ?? '';
    const device = v?.devices?.[id];
    if (!v?.canvas || !device?.physicsState || view.slice === 'off' || !hasBenchField(id)) return;
    const viewProj = v.cameraController?.getViewProjMatrix?.();
    const cam = v.camera?.camera?.position ?? v.cameraController?.camera?.position;
    const inv = viewProj ? invertMat4(viewProj) : null;
    if (!inv || !cam) return;
    const ray = rayFromScreen(v.canvas, e.clientX, e.clientY, inv, cam);
    const d = FIELD_SOURCE_CATALOG[id].bounds;
    const b: [number[], number[]] = [[...d[0]], [...d[1]]];
    const hit = raySliceHit(ray.origin, ray.direction, b, view.slice, view.sliceOffset, device.position ?? [0, 0, 0]);
    if (hit) setFieldProbePoint(id, device.physicsState, hit);
  }

  private mount(): void {
    const root = document.createElement('details');
    root.id = 'field-panel';
    root.innerHTML = `
      <summary><span data-k="title">Field</span> · <span data-k="mag"></span></summary>
      <div data-k="comp" class="fp-dim"></div>
      <div data-k="point" class="fp-dim"></div>
      <div class="fp-row">Slice <select data-k="slice"><option value="off">off</option><option value="x">x</option><option value="y">y</option><option value="z">z</option></select>
        <input data-k="offset" type="range" min="0" max="1" step="0.01" aria-label="Slice offset"></div>
      <div class="fp-row" data-k="modeRow">Overlay <select data-k="mode"><option value="heat">|B| heat</option><option value="arrows">arrows</option><option value="lic">LIC</option></select></div>
      <div class="fp-row" data-k="isoRow"><label><input data-k="iso" type="checkbox"> |B| isosurfaces</label></div>
      <div class="fp-row" data-k="particlesRow">Charges <select data-k="particles"><option value="off">off</option><option value="electron">electrons</option><option value="proton">protons</option><option value="alpha">α</option></select></div>
      <div data-k="particleNote" class="fp-dim"></div>
      <canvas data-k="cpu" width="${SLICE_N}" height="${SLICE_N}" hidden></canvas>
      <div class="fp-row"><button data-k="reset" type="button">Probe to default</button> <span class="fp-dim">click the slice to move it</span></div>
      <div data-k="volume" class="fp-dim"></div>
      <div data-k="model" class="fp-dim fp-model"></div>
      <div class="fp-note">Simulated, not metrology — the catalog's idealised sources in vacuum.</div>`;
    const style = document.createElement('style');
    style.id = 'field-panel-styles';
    style.textContent = `
      #field-panel { position: absolute; left: 12px; top: 12px; z-index: 6; max-width: 250px;
        background: rgba(2, 10, 18, 0.88); border: 1px solid #0ff3; border-radius: 5px; padding: 4px 8px;
        font-size: 0.64rem; color: #9cf; line-height: 1.4; }
      #field-panel[hidden], #field-panel [hidden] { display: none !important; }
      #field-panel summary { cursor: pointer; letter-spacing: 0.03em; }
      #field-panel .fp-row { margin-top: 3px; display: flex; gap: 6px; align-items: center; }
      #field-panel .fp-dim { color: #6a8a9a; }
      #field-panel .fp-model { max-height: 3.2em; overflow: hidden; }
      #field-panel .fp-note { margin-top: 3px; color: #c9a95a; }
      #field-panel select, #field-panel button { font-size: 0.62rem; background: #031520; color: #9cf; border: 1px solid #0ff3; }
      #field-panel input[type=range] { width: 110px; }
      #field-panel canvas { display: block; width: 176px; height: 176px; margin-top: 4px; image-rendering: pixelated;
        border: 1px solid #0ff2; border-radius: 3px; }`;
    if (!document.getElementById('field-panel-styles')) document.head.appendChild(style);
    (document.getElementById('canvas-wrapper') ?? document.body).appendChild(root);
    this.root = root;
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => { this.els[el.dataset.k!] = el; });
    const cpu = this.els.cpu as HTMLCanvasElement;
    this.slice2d = cpu.getContext('2d');
    this.image = this.slice2d?.createImageData(SLICE_N, SLICE_N) ?? null;
    const sel = (k: string) => this.els[k] as HTMLSelectElement;
    sel('slice').addEventListener('change', () => this.setView({ slice: sel('slice').value as FieldSliceAxis }));
    sel('mode').addEventListener('change', () => this.setView({ sliceMode: sel('mode').value as FieldSliceMode }));
    sel('particles').addEventListener('change', () => this.setView({ particles: sel('particles').value as 'off' | FieldSpecies }));
    (this.els.offset as HTMLInputElement).addEventListener('input', (ev) => this.setView({ sliceOffset: Number((ev.target as HTMLInputElement).value) }));
    (this.els.iso as HTMLInputElement).addEventListener('change', (ev) => this.setView({ iso: (ev.target as HTMLInputElement).checked }));
    this.els.reset.addEventListener('click', () => {
      const v = this.vis();
      const d = v?.devices?.[v.currentView ?? ''];
      if (d?.physicsState && v?.currentView) setFieldProbePoint(v.currentView, d.physicsState, null);
    });
    const canvas = this.vis()?.canvas;
    if (canvas) {
      let down = [0, 0];
      canvas.addEventListener('mousedown', (ev) => { down = [ev.clientX, ev.clientY]; });
      canvas.addEventListener('mouseup', (ev) => {
        if (ev.button === 0 && Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) <= DRAG_PX) this.onCanvasClick(ev);
      });
    }
  }

  destroy(): void {
    this.off?.();
    this.off = null;
    this.root?.remove();
    this.root = null;
  }
}

function bounds(b: BenchField): [number[], number[]] {
  return [[...b.decl.bounds[0]], [...b.decl.bounds[1]]];
}

/** Install on either renderer; hidden until a field bench is focused. */
export function initFieldPanel(): FieldPanel {
  const panel = new FieldPanel(
    () => window.multiVisualizer as unknown as VisLike | undefined,
    () => window.currentRenderer === 'webgpu'
  );
  panel.start();
  return panel;
}
