import tourScript from './seg-tour.json';
import { explainerState } from './explainer-state.js';
import { glossaryForHighlight, SEG_GLOSSARY } from './seg-glossary.js';

/**
 * Guided SEG tour — camera keyframes, synced highlights, diagram + annotations.
 */
export class SEGTourPlayer {
  /**
   * @param {() => object|null} getVisualizer
   * @param {object} [script]
   */
  constructor(getVisualizer, script = tourScript) {
    this.getViz = getVisualizer;
    this.script = script;
    this.stepIndex = 0;
    this.playing = false;
    this._stepStart = 0;
    this._raf = null;
    this._onStepEnd = null;

    this._buildOverlay();
  }

  _buildOverlay() {
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
    const mkBtn = (text, fn) => {
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

  get steps() {
    return this.script.steps || [];
  }

  start(fromStep = 0) {
    this.stepIndex = Math.max(0, Math.min(fromStep, this.steps.length - 1));
    this.playing = true;
    explainerState.tourActive = true;
    this._el.style.display = 'block';
    document.body.classList.add('seg-tour-active');
    this._enterStep(this.steps[this.stepIndex]);
    this._loop();
  }

  stop() {
    this.playing = false;
    explainerState.tourActive = false;
    explainerState.setHighlight(null);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._el.style.display = 'none';
    document.body.classList.remove('seg-tour-active');
  }

  next() {
    if (this.stepIndex < this.steps.length - 1) {
      this.stepIndex++;
      this._enterStep(this.steps[this.stepIndex]);
    } else {
      this.stop();
    }
  }

  prev() {
    if (this.stepIndex > 0) {
      this.stepIndex--;
      this._enterStep(this.steps[this.stepIndex]);
    }
  }

  _enterStep(step) {
    if (!step) return;
    this._stepStart = performance.now();
    const v = this.getViz?.();

    if (step.view && typeof window.setMode === 'function') {
      window.setMode(step.view);
    }

    if (step.camera && v?.cameraController) {
      v.cameraController.startCameraTransition(step.camera.position, step.camera.target);
    }

    const hi = step.highlights?.[0] || step.highlight || null;
    explainerState.setHighlight(hi);

    if (step.showAnnotations) {
      window.segAnnotations?.setEnabled(true);
    }
    if (step.showDiagram) {
      window.segDiagram2D?.show?.();
      const cb = document.getElementById('schematicToggle');
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
  }

  _loop() {
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

export function initSEGTour(getVisualizer = () => window.multiVisualizer) {
  const player = new SEGTourPlayer(getVisualizer);
  if (typeof window !== 'undefined') {
    window.segTour = player;
    window.startSEGTour = () => player.start(0);
  }
  return player;
}
