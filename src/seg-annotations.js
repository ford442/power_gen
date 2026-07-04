// ============================================================================
// SEG 3D Component Annotations — educational HUD callouts
// ============================================================================
// Projects labeled anchors from SEG-local space onto the canvas. Off by default;
// toggle via debug panel, `L` key, or window.toggleSEGAnnotations().

const INK = '#46f0ff';
const INK_DIM = 'rgba(70,240,255,0.55)';

/**
 * @param {() => object|null} getVisualizer
 */
export class SEGAnnotations {
  constructor(getVisualizer) {
    this.getViz = getVisualizer;
    this.enabled = false;
    this._els = new Map();
    this._host = document.getElementById('canvas-wrapper') || document.body;
    this._layer = document.createElement('div');
    Object.assign(this._layer.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '4',
      overflow: 'hidden', display: 'none'
    });
    this._layer.id = 'seg-annotations-layer';
    this._host.appendChild(this._layer);

    this._onKey = (e) => {
      if (e.key !== 'l' && e.key !== 'L') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.toggle();
    };
    window.addEventListener('keydown', this._onKey);
  }

  toggle() {
    this.enabled = !this.enabled;
    this._layer.style.display = this.enabled ? 'block' : 'none';
    if (!this.enabled) this._clearLabels();
    this._syncToggleUi();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._layer.style.display = this.enabled ? 'block' : 'none';
    if (!this.enabled) this._clearLabels();
    this._syncToggleUi();
  }

  _syncToggleUi() {
    const cb = document.getElementById('segAnnotationsToggle');
    if (cb) cb.checked = this.enabled;
  }

  _clearLabels() {
    for (const el of this._els.values()) el.remove();
    this._els.clear();
  }

  _ensureLabel(id, text) {
    if (!this._els.has(id)) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute', transform: 'translate(-50%, -100%)',
        font: '0.62rem/1.2 monospace', letterSpacing: '0.4px',
        color: INK, textShadow: '0 0 8px rgba(0,255,255,0.6)',
        whiteSpace: 'nowrap', padding: '2px 6px',
        background: 'rgba(0,10,20,0.72)', border: `1px solid ${INK_DIM}`,
        borderRadius: '3px', pointerEvents: 'none'
      });
      el.textContent = text;
      this._layer.appendChild(el);
      this._els.set(id, el);
    }
    return this._els.get(id);
  }

  /** Build annotation anchors from live layout (SEG-local metres × worldScale). */
  _anchors(layout) {
    if (!layout?.rings?.length) return [];
    const ws = layout.worldScale;
    const outerR = layout.outerRadiusM * ws;
    const shaftR = (layout.shaftRadiusM || 0.15) * ws;
    const plateY = layout.rings[0]?.statorOuterM ? layout.statorHeightM * ws * 0.5 : 2.5;
    const innerR = layout.rings[0].orbitRadiusM * ws;

    return [
      { id: 'shaft', label: 'Central Shaft', pos: [0, 0, 0] },
      { id: 'inner-ring', label: `Inner Rollers (${layout.rings[0].count}×)`, pos: [innerR * 0.85, 0.4, 0] },
      { id: 'stator', label: 'Stator Rings', pos: [outerR * 0.55, plateY * 0.3, 0] },
      { id: 'base', label: 'Base Plate', pos: [outerR * 0.9, -plateY * 0.8, outerR * 0.35] },
      { id: 'coil', label: 'Pickup Coils', pos: [outerR * 1.12, 0.2, 0] },
      { id: 'flux', label: 'Magnetic Flux (B)', pos: [outerR * 0.4, 1.8, outerR * 0.4] }
    ];
  }

  _project(worldPos, viewProj, canvas, devicePos) {
    const x = worldPos[0] + devicePos[0];
    const y = worldPos[1] + devicePos[1];
    const z = worldPos[2] + devicePos[2];
    const clipX = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    const clipY = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    const clipW = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (clipW <= 0.01) return null;
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    if (ndcX < -1.1 || ndcX > 1.1 || ndcY < -1.1 || ndcY > 1.1) return null;
    const rect = canvas.getBoundingClientRect();
    const hostRect = this._host.getBoundingClientRect();
    const px = ((ndcX + 1) * 0.5) * canvas.width;
    const py = ((1 - ndcY) * 0.5) * canvas.height;
    const sx = rect.left - hostRect.left + (px / canvas.width) * rect.width;
    const sy = rect.top - hostRect.top + (py / canvas.height) * rect.height;
    return { x: sx, y: sy, depth: clipW };
  }

  /**
   * Call once per frame from the visualizer render loop when enabled.
   */
  update() {
    if (!this.enabled) return;
    const v = this.getViz?.();
    if (!v || !v.cameraController || !v.canvas) return;
    const mode = v.currentView;
    if (mode !== 'seg' && mode !== 'overview') {
      this._layer.style.display = 'none';
      return;
    }
    this._layer.style.display = 'block';

    const layout = v.segLayout;
    const seg = v.devices?.seg;
    if (!layout || !seg) return;

    const viewProj = v.cameraController.getViewProjMatrix();
    const devicePos = seg.config?.position || [0, 0, 0];
    const anchors = this._anchors(layout);
    const seen = new Set();

    for (const a of anchors) {
      const screen = this._project(a.pos, viewProj, v.canvas, devicePos);
      const el = this._ensureLabel(a.id, a.label);
      seen.add(a.id);
      if (!screen) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'block';
      el.style.left = `${screen.x}px`;
      el.style.top = `${screen.y - 6}px`;
      el.style.opacity = String(Math.max(0.35, Math.min(1, 1.2 - screen.depth * 0.02)));
    }

    for (const [id, el] of this._els) {
      if (!seen.has(id)) el.style.display = 'none';
    }
  }

  destroy() {
    window.removeEventListener('keydown', this._onKey);
    this._clearLabels();
    this._layer?.remove();
  }
}

export function initSEGAnnotations(getVisualizer = () => window.multiVisualizer) {
  const ann = new SEGAnnotations(getVisualizer);
  if (typeof window !== 'undefined') {
    window.segAnnotations = ann;
    window.toggleSEGAnnotations = () => ann.toggle();
  }
  return ann;
}
