import tourScript from './seg-tour.json';
import vdgTourScript from './vdg-tour.json';
import lorentzTourScript from './lorentz-sled-tour.json';
import hallTourScript from './hall-tour.json';
import transformerTourScript from './transformer-tour.json';
import kelvinTourScript from './kelvin-tour.json';
import { explainerState } from './explainer-state';
import { glossaryForHighlight, SEG_GLOSSARY } from './seg-glossary';
import { getMergedDeviceConfig } from '../devices/device-registry';

interface TourCamera {
  position: number[];
  target: number[];
}

interface TourStep {
  id?: string;
  durationSec?: number;
  view?: string;
  /** Absolute world camera keyframe. */
  camera?: TourCamera;
  /**
   * Camera offset from the step's focused device, in world units — preferred
   * over `camera` for anything the auto-layout packer places (most Quanta
   * devices), whose absolute position is not stable across catalog changes.
   */
  cameraOffset?: number[];
  /** Extra height on the look-at point, relative to the device origin. */
  cameraTargetY?: number;
  title?: string;
  body?: string;
  highlights?: string[];
  highlight?: string;
  showDiagram?: boolean;
  showAnnotations?: boolean;
  glossaryTerm?: string | null;
  startPlant?: boolean;
  layoutHint?: string;
}

interface TourScript {
  tourVersion?: number;
  id?: string;
  title?: string;
  description?: string;
  steps?: TourStep[];
}

type GetVisualizer = () => Window['multiVisualizer'];

/**
 * Guided SEG tour — camera keyframes, synced highlights, diagram + annotations.
 */
export class SEGTourPlayer {
  getViz: GetVisualizer;
  script: TourScript;
  stepIndex = 0;
  playing = false;
  private _stepStart = 0;
  private _raf: number | null = null;
  private _onStepEnd: (() => void) | null = null;

  private _el!: HTMLDivElement;
  private _title!: HTMLDivElement;
  private _body!: HTMLDivElement;
  private _glossary!: HTMLDivElement;
  private _progress!: HTMLDivElement;
  private _btnPrev!: HTMLButtonElement;
  private _btnNext!: HTMLButtonElement;
  private _btnExit!: HTMLButtonElement;

  constructor(getVisualizer: GetVisualizer, script: TourScript = tourScript) {
    this.getViz = getVisualizer;
    this.script = script;
    this._buildOverlay();
  }

  private _buildOverlay(): void {
    const host = document.getElementById('canvas-wrapper') || document.body;
    this._el = document.createElement('div');
    this._el.id = 'seg-tour-overlay';
    Object.assign(this._el.style, {
      position: 'absolute', left: '12px', right: '12px', bottom: '12px', zIndex: '12',
      display: 'none', pointerEvents: 'auto',
      background: 'rgba(0,10,20,0.92)', border: '1px solid rgba(0,255,255,0.45)',
      borderRadius: '8px', padding: '12px 14px', maxWidth: '420px',
      fontFamily: 'monospace', color: '#0ff', boxShadow: '0 0 24px rgba(0,255,255,0.15)'
    });

    this._title = document.createElement('div');
    this._title.style.cssText = 'font-size:0.85rem;font-weight:700;margin-bottom:6px;letter-spacing:0.5px';
    this._body = document.createElement('div');
    this._body.style.cssText = 'font-size:0.72rem;line-height:1.45;color:#8cd;color:rgba(140,220,255,0.95)';
    this._glossary = document.createElement('div');
    this._glossary.style.cssText = 'font-size:0.62rem;margin-top:8px;padding:6px 8px;border-left:2px solid #0aa;color:#0aa;display:none';
    this._progress = document.createElement('div');
    this._progress.style.cssText = 'font-size:0.58rem;color:#5a8;margin-top:8px';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap';
    const mkBtn = (text: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      Object.assign(b.style, {
        font: '0.65rem monospace', padding: '5px 10px', cursor: 'pointer',
        background: 'rgba(0,212,255,0.12)', border: '1px solid rgba(0,255,255,0.35)',
        color: '#0ff', borderRadius: '4px'
      });
      b.addEventListener('click', fn);
      return b;
    };
    this._btnPrev = mkBtn('◀ Prev', () => this.prev());
    this._btnNext = mkBtn('Next ▶', () => this.next());
    this._btnExit = mkBtn('Exit tour', () => this.stop());
    row.append(this._btnPrev, this._btnNext, this._btnExit);

    this._el.append(this._title, this._body, this._glossary, this._progress, row);
    host.appendChild(this._el);
  }

  get steps(): TourStep[] {
    return this.script.steps || [];
  }

  start(fromStep = 0): void {
    this.goToStep(fromStep);
  }

  /**
   * Stop any other registered player that is still running.
   *
   * Every player shares the camera, the highlight, the body class and the
   * `#lab=` hash, so two live RAF loops fight over all of them and stack two
   * overlays. The explainer buttons already enforce this, but they are not the
   * only entry point — `window.startHallTour()` and friends, `applyLabState()`
   * replaying a share link, and the `window.startSEGTour` reassignment in
   * main.ts all reach a player directly. Enforcing it here covers them all.
   */
  private _stopOtherTours(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as WindowWithTours;
    for (const def of LAB_TOURS) {
      const other = w[def.key] as SEGTourPlayer | undefined;
      if (other && other !== this && other.playing) other.stop();
    }
  }

  /**
   * Jump to a tour step by index (starts tour if not already playing).
   */
  goToStep(stepIndex: number): void {
    this._stopOtherTours();
    this.stepIndex = Math.max(0, Math.min(stepIndex, this.steps.length - 1));
    this.playing = true;
    explainerState.tourActive = true;
    this._el.style.display = 'block';
    document.body.classList.add('seg-tour-active');
    this._enterStep(this.steps[this.stepIndex]);
    this._syncLabHash();
    this._loop();
  }

  /**
   * Navigate to the tour step that highlights a component id (e.g. `coil`, `shaft`).
   * Falls back to highlight + annotations when no step matches.
   */
  goToStepForHighlight(highlightId: string): void {
    const idx = this._findStepForHighlight(highlightId);
    if (idx >= 0) {
      this.goToStep(idx);
      return;
    }
    explainerState.setHighlight(highlightId);
    window.segAnnotations?.setEnabled(true);
    window.setMode?.('seg');
    this._syncLabHash(highlightId);
  }

  _findStepForHighlight(highlightId: string): number {
    return this.steps.findIndex((s) =>
      (s.highlights || []).includes(highlightId) || s.highlight === highlightId
    );
  }

  private _syncLabHash(highlightOverride?: string | null): void {
    if (typeof window === 'undefined' || !window.shareLabLink) return;
    const hi = highlightOverride
      || explainerState.highlightId
      || this.steps[this.stepIndex]?.highlights?.[0]
      || null;
    import('./lab-url').then((m) => {
      const state = m.captureLabState();
      if (hi) state.hi = hi;
      if (this.playing) state.step = this.stepIndex;
      if (this.playing) state.tour = true;
      const hash = m.encodeLabHash(state);
      history.replaceState(null, '', hash);
    }).catch(() => {});
  }

  stop(): void {
    this.playing = false;
    explainerState.tourActive = false;
    explainerState.setHighlight(null);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._el.style.display = 'none';
    document.body.classList.remove('seg-tour-active');
    this._syncLabHash(null);
  }

  next(): void {
    if (this.stepIndex < this.steps.length - 1) {
      this.stepIndex++;
      this._enterStep(this.steps[this.stepIndex]);
    } else {
      this.stop();
    }
  }

  prev(): void {
    if (this.stepIndex > 0) {
      this.stepIndex--;
      this._enterStep(this.steps[this.stepIndex]);
    }
  }

  private _enterStep(step: TourStep | undefined): void {
    if (!step) return;
    this._stepStart = performance.now();
    const v = this.getViz?.();

    if (step.view && typeof window.setMode === 'function') {
      window.setMode(step.view);
    }

    // A device-relative offset survives layout changes; an absolute keyframe
    // is kept for the older SEG-centric scripts that were authored against
    // fixed positions.
    const relative = step.cameraOffset && step.view
      ? deviceRelativeCamera(step.view, step.cameraOffset, step.cameraTargetY ?? 0)
      : null;
    const frame = relative ?? (step.camera ? { position: step.camera.position, target: step.camera.target } : null);
    if (frame && v?.cameraController) {
      v.cameraController.startCameraTransition(frame.position, frame.target);
    }

    const hi = step.highlights?.[0] || step.highlight || null;
    explainerState.setHighlight(hi);

    if (step.showAnnotations) {
      window.segAnnotations?.setEnabled(true);
    } else {
      window.segAnnotations?.setEnabled(false);
    }
    if (step.showDiagram) {
      (window.segDiagram2D as { show?: () => void } | undefined)?.show?.();
      const cb = document.getElementById('schematicToggle') as HTMLInputElement | null;
      if (cb) {
        cb.checked = true;
        document.getElementById('seg-schematic-overlay')?.classList.add('visible');
      }
    }

    if (step.startPlant && window.segOperator && !window.segOperator.isRunning) {
      window.segOperator.start();
    }

    this._title.textContent = step.title || '';
    this._body.textContent = step.body || '';
    if (step.layoutHint) {
      this._body.textContent += `\n\n💡 ${step.layoutHint}`;
    }

    const gloss = step.glossaryTerm ? SEG_GLOSSARY[step.glossaryTerm] : glossaryForHighlight(hi);
    if (gloss) {
      this._glossary.style.display = 'block';
      this._glossary.innerHTML = `<strong>${gloss.title}</strong> — ${gloss.body}`
        + (gloss.value ? `<br><span style="color:#0ff">${gloss.value}</span>` : '');
    } else {
      this._glossary.style.display = 'none';
    }

    this._progress.textContent = `Step ${this.stepIndex + 1} / ${this.steps.length} · ${step.durationSec || 6}s`;
    this._syncLabHash();
  }

  private _loop(): void {
    if (!this.playing) return;
    const step = this.steps[this.stepIndex];
    const elapsed = (performance.now() - this._stepStart) / 1000;
    const dur = step?.durationSec || 6;

    if (elapsed >= dur && !explainerState.reducedMotion) {
      this.next();
      if (!this.playing) return;
    }

    this._raf = requestAnimationFrame(() => this._loop());
  }
}

/**
 * Position the camera relative to a device's laid-out origin, so a tour step
 * frames the right bench even after `applyAutoLayout` moves it.
 */
function deviceRelativeCamera(
  deviceId: string,
  offset: number[],
  targetY: number
): { position: number[]; target: number[] } | null {
  const cfg = getMergedDeviceConfig()[deviceId];
  const p = cfg?.position;
  if (!p) return null;
  return {
    position: [p[0] + (offset[0] ?? 0), p[1] + (offset[1] ?? 0), p[2] + (offset[2] ?? 0)],
    target: [p[0], p[1] + targetY, p[2]]
  };
}

/**
 * Every guided tour in the lab. One row per script; the player, the window
 * hooks, the `#lab=` `tour=1` mapping and the explainer buttons are all driven
 * from here, so adding a script is one entry rather than four edits.
 *
 * `mode` is the device whose `#lab=mode=` share link replays this tour; `null`
 * marks the SEG tour, which is also the fallback for devices with no script.
 */
export interface LabTourDefinition {
  /** `window[key]` handle, e.g. `hallTour`. */
  key: LabTourKey;
  /** `window[startFn]()` hook used by share links, e2e smokes and the buttons. */
  startFn: string;
  /** `window[stepFn](highlightId)` hook. */
  stepFn: string;
  /** Device id this tour belongs to; null for the SEG/default tour. */
  mode: string | null;
  /** Explainer-panel button id. */
  buttonId: string;
  /** Status line shown while playing. */
  status: string;
  script: TourScript;
}

export type LabTourKey =
  | 'segTour' | 'vdgTour' | 'lorentzTour' | 'hallTour' | 'transformerTour' | 'kelvinTour';

export const LAB_TOURS: readonly LabTourDefinition[] = [
  {
    key: 'segTour',
    startFn: 'startSEGTour',
    stepFn: 'goToSEGStep',
    mode: null,
    buttonId: 'explainerTourBtn',
    status: 'Tour playing — Space to pause sim',
    script: tourScript
  },
  {
    key: 'vdgTour',
    startFn: 'startVdgTour',
    stepFn: 'goToVdgStep',
    mode: 'vdg',
    buttonId: 'explainerVdgTourBtn',
    status: 'Van de Graaff tour playing',
    script: vdgTourScript
  },
  {
    key: 'lorentzTour',
    startFn: 'startLorentzTour',
    stepFn: 'goToLorentzStep',
    mode: 'lorentz-sled',
    buttonId: 'explainerLorentzTourBtn',
    status: 'Lorentz sled tour playing',
    script: lorentzTourScript
  },
  {
    key: 'hallTour',
    startFn: 'startHallTour',
    stepFn: 'goToHallStep',
    mode: 'hall',
    buttonId: 'explainerHallTourBtn',
    status: 'Hall-effect tour playing',
    script: hallTourScript
  },
  {
    key: 'transformerTour',
    startFn: 'startTransformerTour',
    stepFn: 'goToTransformerStep',
    mode: 'transformer',
    buttonId: 'explainerTransformerTourBtn',
    status: 'Mutual-induction tour playing',
    script: transformerTourScript
  },
  {
    key: 'kelvinTour',
    startFn: 'startKelvinTour',
    stepFn: 'goToKelvinStep',
    mode: 'kelvin',
    buttonId: 'explainerKelvinTourBtn',
    status: 'Kelvin dropper tour playing',
    script: kelvinTourScript
  }
];

type WindowWithTours = Record<string, unknown>;

/** Build one tour's player and publish its `window` hooks. */
export function initLabTour(
  def: LabTourDefinition,
  getVisualizer: GetVisualizer = () => window.multiVisualizer
): SEGTourPlayer {
  const player = new SEGTourPlayer(getVisualizer, def.script);
  if (typeof window !== 'undefined') {
    const w = window as unknown as WindowWithTours;
    w[def.key] = player;
    w[def.startFn] = () => player.start(0);
    w[def.stepFn] = (id: string) => player.goToStepForHighlight(id);
  }
  return player;
}

/** Build every tour in `LAB_TOURS`, keyed by its window handle. */
export function initLabTours(
  getVisualizer: GetVisualizer = () => window.multiVisualizer
): Record<LabTourKey, SEGTourPlayer> {
  const out = {} as Record<LabTourKey, SEGTourPlayer>;
  for (const def of LAB_TOURS) out[def.key] = initLabTour(def, getVisualizer);
  return out;
}

export function initSEGTour(getVisualizer?: GetVisualizer): SEGTourPlayer {
  return initLabTour(LAB_TOURS[0], getVisualizer);
}

declare global {
  interface Window {
    goToSEGStep?: (id: string) => void;
  }
}
