/**
 * Shared explainer state — keeps 3D annotations, 2D diagram, and tour in sync.
 */

export type HighlightId = string | null;

type ExplainerStateListener = (s: ExplainerState) => void;

class ExplainerState {
  highlightId: HighlightId = null;
  classroomMode = false;
  reducedMotion = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** B-field experiment multiplier (1 = nominal) */
  fieldMultiplier = 1;
  baseFieldStrength = 0.5;
  tourActive = false;
  private _listeners = new Set<ExplainerStateListener>();

  subscribe(fn: ExplainerStateListener): () => void {
    this._listeners.add(fn);
    try { fn(this); } catch (e) { console.warn('[ExplainerState]', e); }
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      try { fn(this); } catch (e) { console.warn('[ExplainerState]', e); }
    }
  }

  setHighlight(id: HighlightId): void {
    this.highlightId = id || null;
    this._notify();
  }

  setClassroomMode(on: boolean): void {
    this.classroomMode = !!on;
    document.body.classList.toggle('seg-classroom-mode', this.classroomMode);
    this._notify();
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = !!on;
    this._notify();
  }

  setFieldMultiplier(mult: number): void {
    this.fieldMultiplier = Math.max(0.25, Math.min(4, mult));
    this._notify();
    this._applyField();
  }

  setBaseFieldStrength(v: number): void {
    this.baseFieldStrength = Math.max(0, Math.min(1, v));
    this._applyField();
  }

  private _applyField(): void {
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

  getEffectiveField(): number {
    return Math.min(1, this.baseFieldStrength * this.fieldMultiplier);
  }

  /** Particle cap scale when reduced motion or classroom mode is on. */
  getParticleCapScale(): number {
    if (this.reducedMotion) return 0.35;
    if (this.classroomMode) return 0.55;
    return 1;
  }
}

export const explainerState = new ExplainerState();

if (typeof window !== 'undefined') {
  window.explainerState = explainerState;
}

declare global {
  interface Window {
    explainerState: ExplainerState;
  }
}
