// ============================================================================
// SEG 2D Top-Down Diagram (plan view)
// ============================================================================
// A Canvas-2D overlay that renders the Searl Effect Generator as a live
// engineering plan view (looking straight down the +Y axis onto the X–Z plane).
//
// Design intent: this is a schematic, not a second 3D scene. It reuses the
// canonical layout math so it stays faithful to whatever preset is active
// (Searl 10/25/35, Roschin-Godin 12, Legacy) and orbits the rollers off the
// same `visualizer.time` clock that drives the GPU shaders, so the diagram and
// the 3D view never drift apart.
//
// It is fully decoupled from WebGPU: it owns its own <canvas>, its own rAF
// loop (which only runs while visible), and reads visualizer state read-only.
//
// Wire-up (see main.js):
//   import { initSEGDiagram2D } from './seg-diagram-2d.js';
//   const diagram = initSEGDiagram2D(() => window.multiVisualizer);
// Toggle: the floating button, window.toggleSEGDiagram(), or the "D" key.
// ============================================================================

import {
  computeSEGLayout,
  computeRollerPositionsXZ,
  SEG_LAYOUT_PRESETS
} from './seg-layout.js';
import { explainerState } from './seg-explainer/explainer-state.js';

// Per-ring accent colours (inner → outer). Cyan-family to match the app skin,
// shifted toward amber on the outer ring so the three rings stay legible.
const RING_COLORS = [
  { stroke: '#46f0ff', fill: 'rgba(70,240,255,0.18)', glow: 'rgba(70,240,255,0.9)' },
  { stroke: '#4ad6ff', fill: 'rgba(74,214,255,0.16)', glow: 'rgba(74,214,255,0.85)' },
  { stroke: '#ffc24a', fill: 'rgba(255,194,74,0.16)', glow: 'rgba(255,194,74,0.85)' }
];

const INK = '#0ff';
const INK_DIM = 'rgba(0,255,255,0.35)';
const INK_FAINT = 'rgba(0,255,255,0.12)';
const BG = 'rgba(2,6,12,0.92)';

export class SEGDiagram2D {
  /**
   * @param {() => (object|null|undefined)} getVisualizer - returns the live
   *        MultiDeviceVisualizer (window.multiVisualizer) or null.
   * @param {object} [opts]
   * @param {HTMLElement} [opts.host] - element to overlay (default #canvas-wrapper).
   */
  constructor(getVisualizer, opts = {}) {
    this.getViz = getVisualizer;
    this.host = opts.host || document.getElementById('canvas-wrapper') || document.body;
    this.visible = false;
    this._raf = null;
    this._dpr = 1;
    // Fallback layout when no WebGPU visualizer is present (e.g. WebGL2 path
    // that doesn't expose segLayout).
    this._fallbackLayout = computeSEGLayout(SEG_LAYOUT_PRESETS.searl, 1.0);
    this._highlightId = null;
    this._unsub = explainerState.subscribe((s) => { this._highlightId = s.highlightId; });

    this._buildDom();
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.host);
    }
    this._resize();
  }

  _buildDom() {
    const canvas = document.createElement('canvas');
    canvas.id = 'seg-diagram-2d';
    Object.assign(canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      display: 'none', zIndex: '5', pointerEvents: 'none',
      background: 'transparent'
    });
    this.host.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Floating toggle button — lives in the same corner family as the existing
    // canvas labels so it reads as part of the instrument, not bolted on.
    const btn = document.createElement('button');
    btn.id = 'seg-diagram-2d-toggle';
    btn.type = 'button';
    btn.textContent = '⊞ Plan View';
    btn.title = 'Toggle 2D top-down diagram (D)';
    Object.assign(btn.style, {
      position: 'absolute', top: '30px', right: '8px', zIndex: '6',
      font: '0.62rem/1 monospace', letterSpacing: '0.5px',
      color: INK, background: 'rgba(0,8,16,0.78)',
      border: '1px solid rgba(0,255,255,0.3)', borderRadius: '4px',
      padding: '5px 9px', cursor: 'pointer', textTransform: 'uppercase'
    });
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(0,212,255,0.18)';
      btn.style.boxShadow = '0 0 10px rgba(0,255,255,0.4)';
    });
    btn.addEventListener('mouseleave', () => this._syncBtn());
    btn.addEventListener('click', () => this.toggle());
    this.host.appendChild(btn);
    this.btn = btn;

    // Keyboard shortcut: "D" (ignored while typing in a field).
    this._onKey = (e) => {
      if (e.key !== 'd' && e.key !== 'D') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.toggle();
    };
    window.addEventListener('keydown', this._onKey);
  }

  _syncBtn() {
    if (!this.btn) return;
    const on = this.visible;
    this.btn.style.background = on ? 'rgba(0,212,255,0.22)' : 'rgba(0,8,16,0.78)';
    this.btn.style.boxShadow = on ? '0 0 10px rgba(0,255,255,0.5)' : 'none';
    this.btn.style.borderColor = on ? INK : 'rgba(0,255,255,0.3)';
  }

  _resize() {
    const r = this.host.getBoundingClientRect();
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * this._dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this._dpr));
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.canvas.style.display = 'block';
    this._syncBtn();
    this._resize();
    const loop = () => {
      if (!this.visible) return;
      this.draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.canvas.style.display = 'none';
    this._syncBtn();
  }

  toggle() { this.visible ? this.hide() : this.show(); }

  /** Sync visibility from UI checkbox (schematic overlay). */
  setVisible(on) {
    if (on) this.show();
    else this.hide();
  }

  // --- Live state pulled read-only from the visualizer, with safe fallbacks ---
  _readState() {
    const v = this.getViz && this.getViz();
    const layout = (v && v.segLayout) || this._fallbackLayout;
    const time = (v && typeof v.time === 'number') ? v.time : (performance.now() / 1000);
    const seg = v && v.devices && v.devices.seg;
    const energy = seg && typeof seg.energyLevel === 'number' ? seg.energyLevel : 0;
    const speedMult = (v && v.simRateController && v.simRateController.speedMult) || 1;
    const mode = (v && v.currentView) || 'seg';
    return { layout, time, energy, speedMult, mode };
  }

  draw() {
    const { ctx } = this;
    const { layout, time, energy, speedMult, mode } = this._readState();
    const W = this.canvas.width, H = this.canvas.height;
    const dpr = this._dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // World fit: positions are in scene units (metres × worldScale). Frame the
    // base plate with a little margin so callouts have room.
    const ws = layout.worldScale;
    const fitRadiusScene = (layout.basePlateRadiusM || layout.outerRadiusM * 1.55) * ws * 1.06;
    const cx = W / 2, cy = H / 2;
    const margin = 56 * dpr;
    const px = (Math.min(W, H) / 2 - margin) / fitRadiusScene; // scene-units → px
    const toX = (x) => cx + x * px;
    const toY = (z) => cy + z * px;

    this._drawPolarGrid(ctx, cx, cy, fitRadiusScene * px, dpr);
    this._drawBasePlate(ctx, cx, cy, layout, ws, px, dpr);

    // Ring guides + stator bands, inner → outer.
    layout.rings.forEach((ring, i) => {
      const annId = i === 0 ? 'inner-ring' : (i === layout.rings.length - 1 ? 'outer-ring' : 'separator');
      const isHi = this._highlightId === annId
        || (this._highlightId === 'stator' && i === 0)
        || (this._highlightId === 'flux');
      this._drawRing(ctx, cx, cy, ring, RING_COLORS[i % RING_COLORS.length], ws, px, dpr, energy, isHi);
    });

    // Live rollers off the shared clock — same motion model as the GPU path.
    const positions = computeRollerPositionsXZ(time, layout, { speedMult });
    this._drawRollers(ctx, toX, toY, layout, positions, px, dpr, energy);

    this._drawScaleBar(ctx, W, H, ws, px, dpr);
    this._drawHud(ctx, layout, energy, speedMult, mode, dpr);
  }

  _drawPolarGrid(ctx, cx, cy, rOuterPx, dpr) {
    ctx.save();
    // Concentric rings.
    ctx.strokeStyle = INK_FAINT;
    ctx.lineWidth = 1 * dpr;
    for (let k = 1; k <= 4; k++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (rOuterPx * k) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Radial spokes every 30°.
    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(rad) * rOuterPx, cy + Math.sin(rad) * rOuterPx);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawBasePlate(ctx, cx, cy, layout, ws, px, dpr) {
    const plateR = (layout.basePlateRadiusM || layout.outerRadiusM * 1.55) * ws * px;
    const shaftR = (layout.shaftRadiusM || 0.15) * ws * px;
    ctx.save();
    // Base plate.
    ctx.beginPath();
    ctx.arc(cx, cy, plateR, 0, Math.PI * 2);
    ctx.strokeStyle = INK_DIM;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    // Central shaft / hub.
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(shaftR, 3 * dpr), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,255,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    // Crosshair through hub.
    ctx.strokeStyle = INK_DIM;
    ctx.lineWidth = 1 * dpr;
    const ch = Math.max(shaftR * 1.6, 7 * dpr);
    ctx.beginPath();
    ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy);
    ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch);
    ctx.stroke();
    if (this._highlightId === 'shaft' || this._highlightId === 'ionization') {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(shaftR * 1.8, 8 * dpr), 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * dpr;
      ctx.globalAlpha = 0.75;
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawRing(ctx, cx, cy, ring, color, ws, px, dpr, energy, highlighted = false) {
    const orbitR = ring.orbitRadiusM * ws * px;
    const innerR = (ring.statorInnerM || 0) * ws * px;
    const outerR = (ring.statorOuterM || 0) * ws * px;

    ctx.save();
    // Stator band (annulus the rollers run over), faint fill.
    if (outerR > innerR && outerR > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.arc(cx, cy, Math.max(innerR, 0.5), 0, Math.PI * 2, true);
      ctx.fillStyle = color.fill;
      ctx.fill('evenodd');
    }
    // Orbit guide circle (dashed) at the roller-centre radius.
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
    ctx.strokeStyle = highlighted ? '#fff' : color.stroke;
    ctx.globalAlpha = (highlighted ? 0.95 : 0.55) + energy * 0.4;
    ctx.lineWidth = (highlighted ? 2.5 : 1.25) * dpr;
    ctx.stroke();
    if (highlighted) {
      ctx.beginPath();
      ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
      ctx.strokeStyle = color.glow;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 5 * dpr;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawRollers(ctx, toX, toY, layout, positions, px, dpr, energy) {
    let flat = 0;
    layout.rings.forEach((ring, ri) => {
      const color = RING_COLORS[ri % RING_COLORS.length];
      const rollerPx = Math.max(ring.rollerRadiusM * layout.worldScale * px, 3 * dpr);
      for (let i = 0; i < ring.count; i++, flat++) {
        const wx = positions[flat * 2];
        const wz = positions[flat * 2 + 1];
        const x = toX(wx), y = toY(wz);
        const ang = Math.atan2(wz, wx); // orbital angle of this roller

        // Roller body with a soft glow scaled by live energy.
        ctx.save();
        ctx.shadowColor = color.glow;
        ctx.shadowBlur = (4 + energy * 10) * dpr;
        ctx.beginPath();
        ctx.arc(x, y, rollerPx, 0, Math.PI * 2);
        ctx.fillStyle = color.fill;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.25 * dpr;
        ctx.strokeStyle = color.stroke;
        ctx.stroke();

        // Pole-band tick: a short diameter line whose orientation advances with
        // the roller's own spin, giving a readable sense of rotation.
        const spin = ang * 3.0; // rollers counter-spin faster than they orbit
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(spin) * rollerPx, y + Math.sin(spin) * rollerPx);
        ctx.lineTo(x - Math.cos(spin) * rollerPx, y - Math.sin(spin) * rollerPx);
        ctx.strokeStyle = INK;
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
        ctx.restore();
      }

      // Ring label: count + real orbit radius in metres, parked at top of orbit.
      const labelR = ring.orbitRadiusM * layout.worldScale * px;
      ctx.save();
      ctx.fillStyle = color.stroke;
      ctx.font = `${10 * dpr}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const lx = toX(0);
      const ly = toY(-ring.orbitRadiusM * layout.worldScale) - 4 * dpr;
      ctx.fillText(`R${ri + 1} · ${ring.count}×  ${ring.orbitRadiusM.toFixed(2)} m`, lx, ly);
      ctx.restore();
    });
  }

  _drawScaleBar(ctx, W, H, ws, px, dpr) {
    // One metre in scene units = ws; in pixels = ws * px.
    const oneMeterPx = ws * px;
    // Pick a "nice" length (1, 2, 5, 10 … m) that fits comfortably.
    const targetPx = Math.min(W, H) * 0.22;
    const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10];
    let meters = 1;
    for (const s of niceSteps) { if (s * oneMeterPx <= targetPx) meters = s; }
    const barPx = meters * oneMeterPx;
    const x0 = 16 * dpr, y0 = H - 18 * dpr;

    ctx.save();
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0 + barPx, y0);
    ctx.moveTo(x0, y0 - 4 * dpr); ctx.lineTo(x0, y0 + 4 * dpr);
    ctx.moveTo(x0 + barPx, y0 - 4 * dpr); ctx.lineTo(x0 + barPx, y0 + 4 * dpr);
    ctx.stroke();
    ctx.font = `${10 * dpr}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = meters >= 1 ? `${meters} m` : `${meters * 100} cm`;
    ctx.fillText(label, x0, y0 - 6 * dpr);
    ctx.restore();
  }

  _drawHud(ctx, layout, energy, speedMult, mode, dpr) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const x = 16 * dpr;
    let y = 14 * dpr;

    ctx.fillStyle = INK;
    ctx.font = `${12 * dpr}px monospace`;
    ctx.fillText('SEG · PLAN VIEW', x, y);
    y += 17 * dpr;

    ctx.fillStyle = INK_DIM;
    ctx.font = `${10 * dpr}px monospace`;
    const lines = [
      `${layout.name}`,
      `${layout.totalRollers} rollers · ${layout.ringCount} ring(s)`,
      `Ø ${(layout.outerRadiusM * 2).toFixed(2)} m · gap ${(layout.gapM * 1000).toFixed(1)} mm`,
      `energy ${(energy * 100).toFixed(0)}% · ${speedMult.toFixed(2)}×`
    ];
    for (const l of lines) { ctx.fillText(l, x, y); y += 14 * dpr; }

    if (mode !== 'seg' && mode !== 'overview') {
      ctx.fillStyle = '#ffc24a';
      ctx.fillText(`(3D view: ${String(mode).toUpperCase()} — diagram shows SEG)`, x, y);
    }
    ctx.restore();
  }

  destroy() {
    this.hide();
    this._unsub?.();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKey);
    if (this._ro) this._ro.disconnect();
    this.canvas && this.canvas.remove();
    this.btn && this.btn.remove();
  }
}

/**
 * Convenience initialiser: builds the diagram, wires global helpers, returns it.
 * @param {() => object} getVisualizer
 */
export function initSEGDiagram2D(getVisualizer = () => window.multiVisualizer) {
  const diagram = new SEGDiagram2D(getVisualizer);
  if (typeof window !== 'undefined') {
    window.segDiagram2D = diagram;
    window.toggleSEGDiagram = () => diagram.toggle();
  }
  return diagram;
}