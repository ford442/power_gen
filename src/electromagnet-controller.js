/**
 * ElectromagnetController - Phase-to-coil mapping and firing pattern logic
 *
 * Mirrors the Arduino commutation algorithm so the visualizer can predict
 * which coils are active and render them with emissive highlights.
 */

class ElectromagnetController {
  constructor(config = {}) {
    this.numCoils = config.numCoils || 8;
    this.offsetAngle = config.offsetAngle || 0;
    this.dwellAngle = config.dwellAngle || 67.5;
    this.advanceAngle = config.advanceAngle || 0;
    this.firingPattern = config.firingPattern || 'overlap'; // 'single' | 'overlap' | 'trapezoidal' | 'sinusoidal'
  }

  setConfig(config) {
    if (config.numCoils !== undefined) this.numCoils = config.numCoils;
    if (config.offsetAngle !== undefined) this.offsetAngle = config.offsetAngle;
    if (config.dwellAngle !== undefined) this.dwellAngle = config.dwellAngle;
    if (config.advanceAngle !== undefined) this.advanceAngle = config.advanceAngle;
    if (config.firingPattern !== undefined) this.firingPattern = config.firingPattern;
  }

  /**
   * Compute active coil bitmask for a given electrical angle.
   * @param {number} electricalAngle - degrees 0-360
   * @param {number} direction - 1 for clockwise, -1 for counter-clockwise
   * @returns {number} coilMask - bitmask of active coils
   */
  computeCoilMask(electricalAngle, direction = 1) {
    const angle = this._normalizeAngle(electricalAngle + this.advanceAngle * direction);
    let mask = 0;

    for (let i = 0; i < this.numCoils; i++) {
      const coilCenter = this._normalizeAngle(i * (360 / this.numCoils) + this.offsetAngle);
      const dist = this._angularDistance(angle, coilCenter);

      let active = false;
      switch (this.firingPattern) {
        case 'single':
          active = dist < (this.dwellAngle / 2);
          break;
        case 'overlap':
          active = dist < (this.dwellAngle / 2);
          break;
        case 'trapezoidal': {
          const half = this.dwellAngle / 2;
          const ramp = half * 0.3;
          active = dist < half;
          // PWM intensity could be modulated by trapezoid shape, but for mask we just use on/off
          break;
        }
        case 'sinusoidal': {
          active = dist < (this.dwellAngle / 2);
          break;
        }
        default:
          active = dist < (this.dwellAngle / 2);
      }

      if (active) {
        mask |= (1 << i);
      }
    }

    return mask;
  }

  /**
   * Compute per-coil PWM intensities for sinusoidal or trapezoidal patterns.
   * @param {number} electricalAngle - degrees 0-360
   * @param {number} direction - 1 or -1
   * @returns {number[]} Array of PWM values 0-255 per coil
   */
  computePwmValues(electricalAngle, direction = 1) {
    const angle = this._normalizeAngle(electricalAngle + this.advanceAngle * direction);
    const values = new Array(this.numCoils).fill(0);

    for (let i = 0; i < this.numCoils; i++) {
      const coilCenter = this._normalizeAngle(i * (360 / this.numCoils) + this.offsetAngle);
      const dist = this._angularDistance(angle, coilCenter);

      switch (this.firingPattern) {
        case 'sinusoidal': {
          const half = this.dwellAngle / 2;
          if (dist < half) {
            values[i] = Math.round(255 * Math.cos((dist / half) * (Math.PI / 2)));
          }
          break;
        }
        case 'trapezoidal': {
          const half = this.dwellAngle / 2;
          const ramp = half * 0.3;
          if (dist < half) {
            if (dist < ramp) {
              values[i] = Math.round(255 * (dist / ramp));
            } else if (dist > half - ramp) {
              values[i] = Math.round(255 * ((half - dist) / ramp));
            } else {
              values[i] = 255;
            }
          }
          break;
        }
        default:
          // On/off patterns: full PWM if within dwell
          if (dist < (this.dwellAngle / 2)) {
            values[i] = 255;
          }
      }
    }

    return values;
  }

  /**
   * Compute the visual angle for each coil in 3D space (for rendering).
   * @returns {number[]} Array of angles in radians for each coil
   */
  getCoilAngles() {
    const angles = [];
    for (let i = 0; i < this.numCoils; i++) {
      const deg = this._normalizeAngle(i * (360 / this.numCoils) + this.offsetAngle);
      angles.push((deg * Math.PI) / 180);
    }
    return angles;
  }

  /**
   * Default dwell angle for a given coil count and overlap factor.
   * @param {number} numCoils
   * @param {number} overlapFactor - 1.0 = no overlap, 1.5 = 50% overlap
   */
  static defaultDwellAngle(numCoils, overlapFactor = 1.5) {
    return (360 / numCoils) * overlapFactor;
  }

  // ============================================
  // Helpers
  // ============================================

  _normalizeAngle(deg) {
    let a = deg % 360;
    if (a < 0) a += 360;
    return a;
  }

  _angularDistance(a, b) {
    let diff = Math.abs(a - b);
    if (diff > 180) diff = 360 - diff;
    return diff;
  }
}

export { ElectromagnetController };
