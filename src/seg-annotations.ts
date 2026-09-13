// ============================================================================
// SEG 3D Component Annotations — educational HUD callouts
// ============================================================================
// Projects labeled anchors from SEG-local space onto the canvas. Synced with
// 2D diagram via explainerState.highlightId (tour + experiments).

import { explainerState } from './seg-explainer/explainer-state.js';
import { glossaryForHighlight } from './seg-explainer/seg-glossary.js';

const INK = '#46f0ff';
const INK_DIM = 'rgba(70,240,255,0.55)';

/** Shared label metadata for procedural + glTF annotation ids. */
export const SEG_ANNOTATION_META = {
  shaft: { label: 'Central Shaft', hint: 'Bearing axis', labelOffset: [0, -42] },
  'inner-ring': { label: 'Inner Rollers', hint: 'NdFeB segments', labelOffset: [48, -28] },
  'outer-ring': { label: 'Outer Rollers', hint: 'Toroidal orbit', labelOffset: [44, 24] },
  stator: { label: 'Stator Rings', hint: 'Copper windings', labelOffset: [-58, -22] },
  separator: { label: 'Ring Separator', hint: 'Insulated gap', labelOffset: [-64, 12] },
  base: { label: 'Base Plate', hint: 'Structural mount', labelOffset: [52, 18] },
  coil: { label: 'Pickup Coils', hint: 'EMF induction', labelOffset: [62, -8] },
  flux: { label: 'Magnetic Flux (B)', hint: 'RK4 field lines', labelOffset: [-70, -36] },
  ionization: { label: 'Ionization Torus', hint: 'Corona @ high RPM', labelOffset: [0, -52] }
};

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

    this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    Object.assign(this._svg.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', overflow: 'visible'
    });
    this._layer.appendChild(this._svg);
    this._leaderPaths = new Map();
    this._unsub = explainerState.subscribe(() => this._syncClassroomStyles());

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
    for (const p of this._leaderPaths.values()) p.remove();
    this._leaderPaths.clear();
    while (this._svg.firstChild) this._svg.removeChild(this._svg.firstChild);
  }

  _syncClassroomStyles() {
    const large = explainerState.classroomMode;
    for (const el of this._els.values()) {
      el.style.fontSize = large ? '0.82rem' : '0.62rem';
      el.style.padding = large ? '6px 10px' : '3px 7px';
    }
  }

  _ensureLabel(id, text, hint = '') {
    if (!this._els.has(id)) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute', transform: 'translate(-50%, -100%)',
        font: '0.62rem/1.2 monospace', letterSpacing: '0.4px',
        color: INK, textShadow: '0 0 8px rgba(0,255,255,0.6)',
        whiteSpace: 'nowrap', padding: '3px 7px',
        background: 'rgba(0,10,20,0.78)', border: `1px solid ${INK_DIM}`,
        borderRadius: '3px', pointerEvents: 'auto', cursor: 'pointer',
        transition: 'opacity 0.2s, box-shadow 0.2s, transform 0.2s'
      });
      el.dataset.annotationId = id;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.title = `Open tour: ${text}`;
      const activate = (e) => {
        e.stopPropagation();
        window.segTour?.goToStepForHighlight?.(id);
      };
      el.addEventListener('click', activate);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); }
      });
      this._layer.style.pointerEvents = 'none';
      this._layer.appendChild(el);
      this._els.set(id, el);
    }
    return this._els.get(id);
  }

  _setLabelContent(el, text, hint, hotspotOnly) {
    if (hotspotOnly) {
      el.innerHTML = '';
      el.style.width = '12px';
      el.style.height = '12px';
      el.style.padding = '0';
      el.style.borderRadius = '50%';
      el.style.minWidth = '12px';
      el.style.transform = 'translate(-50%, -50%)';
    } else {
      el.style.width = '';
      el.style.height = '';
      el.style.minWidth = '';
      el.style.borderRadius = '3px';
      el.style.transform = 'translate(-50%, -100%)';
      el.innerHTML = hint
        ? `<strong>${text}</strong><span class="seg-ann-hint" style="display:block;font-size:0.55rem;color:${INK_DIM};margin-top:2px">${hint}</span>`
        : `<strong>${text}</strong>`;
    }
  }

  _ensureLeader(id) {
    if (!this._leaderPaths.has(id)) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      path.setAttribute('stroke', INK_DIM);
      path.setAttribute('stroke-width', '1');
      path.setAttribute('stroke-dasharray', '3 3');
      this._svg.appendChild(path);
      this._leaderPaths.set(id, path);
    }
    return this._leaderPaths.get(id);
  }

  /** Build annotation anchors from layout; merge glTF housing positions when loaded. */
  _anchors(layout, visualizer) {
    if (!layout?.rings?.length) return [];
    const ws = layout.worldScale;
    const outerR = layout.outerRadiusM * ws;
    const innerR = layout.rings[0].orbitRadiusM * ws;
    const midR = layout.rings.length > 1 ? layout.rings[1].orbitRadiusM * ws : innerR * 1.5;
    const plateY = layout.statorHeightM * ws * 0.5;
    const baseY = -plateY * 1.2;

    const gltfById = new Map(
      (visualizer?.gltfHousingEnabled && visualizer?.gltfAnnotationPoints || [])
        .map((p) => [p.id, p.pos])
    );

    const mk = (id, label, hint, pos, labelOffset) => ({
      id,
      label,
      hint,
      pos: gltfById.get(id) || pos,
      labelOffset,
      fromGltf: gltfById.has(id)
    });

    const anchors = [
      mk('shaft', 'Central Shaft', 'Bearing axis', [0, 0, 0], [0, -42]),
      mk('inner-ring', `Inner Rollers (${layout.rings[0].count}×)`, 'NdFeB segments', [innerR * 0.9, 0.35, 0], [48, -28]),
      mk('stator', 'Stator Rings', 'Copper windings', [outerR * 0.5, plateY * 0.25, 0], [-58, -22]),
      mk('base', 'Base Plate', 'Structural mount', [outerR * 0.85, baseY, outerR * 0.3], [52, 18]),
      mk('coil', 'Pickup Coils', 'EMF induction', [outerR * 1.1, 0.15, 0], [62, -8]),
      mk('flux', 'Magnetic Flux (B)', 'RK4 field lines', [midR * 0.55, 1.6, midR * 0.45], [-70, -36]),
      mk('ionization', 'Ionization Torus', 'Corona @ high RPM', [outerR * 0.75, 2.2, outerR * 0.55], [0, -52])
    ];

    if (layout.rings.length > 1) {
      const outerCount = layout.rings[layout.rings.length - 1].count;
      anchors.push(mk(
        'outer-ring',
        `Outer Rollers (${outerCount}×)`,
        'Toroidal orbit',
        [outerR * 0.92, 0.2, outerR * 0.35],
        [44, 24]
      ));
    }

    if (layout.ringCount >= 2) {
      anchors.push(mk(
        'separator',
        'Ring Separator',
        'Insulated gap',
        [midR, -plateY * 0.15, midR * 0.7],
        [-64, 12]
      ));
    }

    return anchors;
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
    if (ndcX < -1.15 || ndcX > 1.15 || ndcY < -1.15 || ndcY > 1.15) return null;
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
    const anchors = this._anchors(layout, v);
    const seen = new Set();
    const highlightId = explainerState.highlightId;
    const classroom = explainerState.classroomMode;
    const corona = v.corona ?? v.segOmega ?? 0;
    const ionBoost = highlightId === 'ionization' ? 1 : 0;

    for (const a of anchors) {
      const isHi = highlightId === a.id;
      const anchor = this._project(a.pos, viewProj, v.canvas, devicePos);
      const gloss = glossaryForHighlight(a.id);
      let hint = a.hint || '';
      if (gloss && (highlightId === a.id || explainerState.classroomMode)) {
        hint = gloss.body.slice(0, 72) + (gloss.body.length > 72 ? '…' : '');
      }
      const el = this._ensureLabel(a.id, a.label, hint);
      const hotspotOnly = classroom && !isHi;
      this._setLabelContent(el, a.label, hint, hotspotOnly);
      seen.add(a.id);

      if (!anchor) {
        el.style.display = 'none';
        const leader = this._leaderPaths.get(a.id);
        if (leader) leader.style.display = 'none';
        continue;
      }

      // Occlusion fade: depth-based + hide ionization when corona low
      if (a.id === 'ionization' && corona < 0.15 && !isHi) {
        el.style.display = 'none';
        const leader = this._leaderPaths.get(a.id);
        if (leader) leader.style.display = 'none';
        continue;
      }

      const off = a.labelOffset || [0, -32];
      const lx = hotspotOnly ? anchor.x : anchor.x + off[0];
      const ly = hotspotOnly ? anchor.y : anchor.y + off[1];
      const depthFade = Math.max(0.12, Math.min(1, 1.2 - anchor.depth * 0.02));
      const alpha = isHi ? 1 : depthFade * 0.85;

      el.style.display = 'block';
      el.style.left = `${lx}px`;
      el.style.top = `${ly}px`;
      el.style.opacity = String(alpha);
      el.style.borderColor = isHi ? '#0ff' : INK_DIM;
      el.style.boxShadow = isHi
        ? '0 0 16px rgba(0,255,255,0.55), 0 0 4px rgba(0,255,255,0.8)'
        : 'none';
      el.style.transform = isHi
        ? (hotspotOnly ? 'translate(-50%, -50%) scale(1.15)' : 'translate(-50%, -100%) scale(1.06)')
        : (hotspotOnly ? 'translate(-50%, -50%)' : 'translate(-50%, -100%)');

      const line = this._ensureLeader(a.id);
      if (hotspotOnly) {
        line.style.display = 'none';
      } else {
        line.style.display = 'block';
        line.setAttribute('x1', String(anchor.x));
        line.setAttribute('y1', String(anchor.y));
        line.setAttribute('x2', String(lx));
        line.setAttribute('y2', String(ly + 4));
        line.setAttribute('stroke', isHi ? '#0ff' : INK_DIM);
        line.setAttribute('stroke-width', isHi ? '1.5' : '1');
        line.setAttribute('opacity', String((isHi ? 0.85 : 0.35) * alpha + ionBoost * 0.1));
      }
    }

    for (const [id, el] of this._els) {
      if (!seen.has(id)) el.style.display = 'none';
    }
    for (const [id, line] of this._leaderPaths) {
      if (!seen.has(id)) line.style.display = 'none';
    }
  }

  destroy() {
    window.removeEventListener('keydown', this._onKey);
    this._unsub?.();
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
