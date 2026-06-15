/**
 * SimRateController — decouples simulation tick rate from render rate and
 * provides speed-scaled visual feedback parameters.
 *
 * At speedMult ≤ 3× the controller returns a single variable-length step per
 * render frame.  Above 3× it switches to fixed substeps (1/60 s each, up to
 * MAX_SUBSTEPS per frame) so physics and visuals scale smoothly without
 * introducing large discontinuities.
 */
export class SimRateController {
  constructor() {
    this._speedMult = 1.0;
    this._accumulator = 0;
    this.FIXED_DT = 1 / 60;
    this.MAX_SUBSTEPS = 6;
  }

  /**
   * Call once per render frame.
   * @param {number} wallDt  Real elapsed time in seconds.
   * @param {number} speedMult  Current simulation speed multiplier.
   * @returns {number[]}  Array of dt values (seconds) to simulate this frame.
   */
  tick(wallDt, speedMult) {
    this._speedMult = speedMult;

    if (speedMult <= 3) {
      return [wallDt * speedMult];
    }

    // Fixed-substep regime: accumulate scaled time and drain in FIXED_DT chunks
    this._accumulator += wallDt * speedMult;
    const steps = [];
    let count = 0;
    while (this._accumulator >= this.FIXED_DT && count < this.MAX_SUBSTEPS) {
      steps.push(this.FIXED_DT);
      this._accumulator -= this.FIXED_DT;
      count++;
    }
    // Prevent spiral-of-death: discard excess accumulation
    if (this._accumulator > this.FIXED_DT * this.MAX_SUBSTEPS) {
      this._accumulator = 0;
    }
    return steps.length ? steps : [];
  }

  get speedMult() { return this._speedMult; }

  /** Particle density scale capped at 3× (pow curve feels natural) */
  get particleScale() {
    return Math.min(3.0, Math.pow(this._speedMult, 0.6));
  }

  /** Corona / emissive intensity boost: pow(speedMult, 1.3) */
  get coronaIntensity() {
    return Math.pow(this._speedMult, 1.3);
  }

  /** Bloom extraction threshold — stays high so only bright plasma blooms */
  get bloomThreshold() {
    return Math.max(0.45, 0.72 - (this._speedMult - 1) * 0.022);
  }

  /** Bloom composite strength — restrained baseline, modest overdrive flare */
  get bloomStrength() {
    return Math.min(1.6, 0.9 + (this._speedMult - 1) * 0.07);
  }

  /**
   * Number of energy arcs to trigger this frame.
   * @param {number} base  Arc count at 1× speed.
   */
  arcCount(base = 4) {
    if (this._speedMult <= 3) return base;
    return Math.round(base * Math.pow(this._speedMult / 3, 1.5));
  }

  /** True when speedMult > 7 (overdrive) */
  get isOverdrive() { return this._speedMult > 7; }

  /** CSS hue for tachometer bar: green → amber → red */
  get tachHue() {
    if (this._speedMult < 3) return 120;
    if (this._speedMult < 7) return 60;
    return 0;
  }

  /** Tachometer bar fill fraction 0–1 */
  get tachFill() {
    return Math.min(1, this._speedMult / 20);
  }
}
