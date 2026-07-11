/**
 * Shared explainer state — keeps 3D annotations, 2D diagram, and tour in sync.
 */

/** @typedef {'inner-ring'|'outer-ring'|'stator'|'coil'|'flux'|'ionization'|'shaft'|'base'|'separator'|null} HighlightId */

class ExplainerState {
  constructor() {
    /** @type {HighlightId} */
    this.highlightId = null;
    this.classroomMode = false;
    this.reducedMotion = typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    /** B-field experiment multiplier (1 = nominal) */
    this.fieldMultiplier = 1;
    this.baseFieldStrength = 0.5;
    this.tourActive = false;
    /** @type {Set<(s: ExplainerState) => void>} */
    this._listeners = new Set();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    try { fn(this); } catch (e) { console.warn('[ExplainerState]', e); }
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (e) { console.warn('[ExplainerState]', e); }
    }
  }

  setHighlight(id) {
    this.highlightId = id || null;
    this._notify();
  }

  setClassroomMode(on) {
    this.classroomMode = !!on;
    document.body.classList.toggle('seg-classroom-mode', this.classroomMode);
    this._notify();
  }

  setReducedMotion(on) {
    this.reducedMotion = !!on;
    this._notify();
  }

  setFieldMultiplier(mult) {
    this.fieldMultiplier = Math.max(0.25, Math.min(4, mult));
    this._notify();
    this._applyField();
  }

  setBaseFieldStrength(v) {
    this.baseFieldStrength = Math.max(0, Math.min(1, v));
    this._applyField();
  }

  _applyField() {
    const op = window.segOperator;
    if (!op) return;
    const effective = Math.min(1, this.baseFieldStrength * this.fieldMultiplier);
    op.magneticFieldStrength = effective;
    const slider = document.getElementById('fieldControl');
    const label = document.getElementById('fieldVal');
    if (slider && label) {
      label.textContent = `${Math.round(effective * 100)}${this.fieldMultiplier !== 1 ? ` (×${this.fieldMultiplier.toFixed(1)})` : ''}`;
    }
  }

  getEffectiveField() {
    return Math.min(1, this.baseFieldStrength * this.fieldMultiplier);
  }

  /** Particle cap scale when reduced motion or classroom mode is on. */
  getParticleCapScale() {
    if (this.reducedMotion) return 0.35;
    if (this.classroomMode) return 0.55;
    return 1;
  }
}

export const explainerState = new ExplainerState();

if (typeof window !== 'undefined') {
  window.explainerState = explainerState;
}
