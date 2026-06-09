/**
 * WebGL2 debug controls: wireframe, particle viz, slow-motion, step simulation.
 * Exposed on window.webgl2Debug for Playwright hooks.
 */

export class WebGL2DebugControls {
  constructor() {
    this.wireframe = false;
    this.debugParticles = 0; // 0=off, 1=id/phase, 2=velocity heat
    this.debugNormals = false;
    this.slowMotion = 1.0;
    this.paused = false;
    this.stepOnce = false;
    this.particleScale = 1.0;

    window.webgl2Debug = this;
    this._bindKeys();
  }

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (!window.currentRenderer || window.currentRenderer !== 'webgl2') return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key.toLowerCase()) {
        case 'w': this.wireframe = !this.wireframe; console.log('[webgl2] wireframe:', this.wireframe); break;
        case 'p': this.debugParticles = (this.debugParticles + 1) % 3; console.log('[webgl2] particle debug:', this.debugParticles); break;
        case 'n': this.debugNormals = !this.debugNormals; console.log('[webgl2] normal debug:', this.debugNormals); break;
        case ' ': e.preventDefault(); this.paused = !this.paused; console.log('[webgl2] paused:', this.paused); break;
        case '.': this.stepOnce = true; break;
        case '[': this.slowMotion = Math.max(0.05, this.slowMotion * 0.5); console.log('[webgl2] slowMotion:', this.slowMotion); break;
        case ']': this.slowMotion = Math.min(4.0, this.slowMotion * 2.0); console.log('[webgl2] slowMotion:', this.slowMotion); break;
        default: break;
      }
    });
  }

  /**
   * @param {number} rawDelta
   * @returns {number} effective delta after pause/slow/step
   */
  effectiveDelta(rawDelta) {
    if (this.paused && !this.stepOnce) return 0;
    const dt = rawDelta * this.slowMotion;
    if (this.stepOnce) {
      this.stepOnce = false;
      return Math.min(dt, 1 / 30);
    }
    return dt;
  }

  get debugMode() {
    return this.debugNormals ? 1 : 0;
  }
}
