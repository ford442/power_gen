/**
 * ElectromagnetController - Phase-to-coil mapping and firing pattern logic
 *
 * Mirrors the Arduino commutation algorithm so the visualizer can predict
 * which coils are active and render them with emissive highlights.
 */

export type FiringPattern = 'single' | 'overlap' | 'trapezoidal' | 'sinusoidal';

export interface ElectromagnetControllerConfig {
  numCoils?: number;
  offsetAngle?: number;
  dwellAngle?: number;
  advanceAngle?: number;
  firingPattern?: FiringPattern;
}

class ElectromagnetController {
  numCoils: number;
  offsetAngle: number;
  dwellAngle: number;
  advanceAngle: number;
  firingPattern: FiringPattern;

  constructor(config: ElectromagnetControllerConfig = {}) {
    this.numCoils = config.numCoils || 8;
    this.offsetAngle = config.offsetAngle || 0;
    this.dwellAngle = config.dwellAngle || 67.5;
    this.advanceAngle = config.advanceAngle || 0;
    this.firingPattern = config.firingPattern || 'overlap';
  }

  setConfig(config: ElectromagnetControllerConfig): void {
    if (config.numCoils !== undefined) this.numCoils = config.numCoils;
    if (config.offsetAngle !== undefined) this.offsetAngle = config.offsetAngle;
    if (config.dwellAngle !== undefined) this.dwellAngle = config.dwellAngle;
    if (config.advanceAngle !== undefined) this.advanceAngle = config.advanceAngle;
    if (config.firingPattern !== undefined) this.firingPattern = config.firingPattern;
  }

  /**
   * Compute active coil bitmask for a given electrical angle.
   * @param electricalAngle - degrees 0-360
   * @param direction - 1 for clockwise, -1 for counter-clockwise
   * @returns coilMask - bitmask of active coils
   */
  computeCoilMask(electricalAngle: number, direction = 1): number {
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
   * @param electricalAngle - degrees 0-360
   * @param direction - 1 or -1
   * @returns Array of PWM values 0-255 per coil
   */
  computePwmValues(electricalAngle: number, direction = 1): number[] {
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
   * @returns Array of angles in radians for each coil
   */
  getCoilAngles(): number[] {
    const angles: number[] = [];
    for (let i = 0; i < this.numCoils; i++) {
      const deg = this._normalizeAngle(i * (360 / this.numCoils) + this.offsetAngle);
      angles.push((deg * Math.PI) / 180);
    }
    return angles;
  }

  /**
   * Default dwell angle for a given coil count and overlap factor.
   * @param overlapFactor - 1.0 = no overlap, 1.5 = 50% overlap
   */
  static defaultDwellAngle(numCoils: number, overlapFactor = 1.5): number {
    return (360 / numCoils) * overlapFactor;
  }

  // ============================================
  // Helpers
  // ============================================

  _normalizeAngle(deg: number): number {
    let a = deg % 360;
    if (a < 0) a += 360;
    return a;
  }

  _angularDistance(a: number, b: number): number {
    let diff = Math.abs(a - b);
    if (diff > 180) diff = 360 - diff;
    return diff;
  }
}

export { ElectromagnetController };
