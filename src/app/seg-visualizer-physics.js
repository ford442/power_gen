// Math & Physics Methods for SEGVisualizer
import { ValidatedConstants } from '../ValidatedConstants.js';

export const SEGVisualizerMath = {
  perspectiveMatrix: function (fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  },

  lookAt: function (eye, center, up) {
    const z = this.normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = this.normalize(this.cross(up, z));
    const y = this.cross(z, x);

    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1
    ]);
  },

  fresnelR: function (cosI, n2) {
    const n1 = 1.0;
    const ci = Math.max(0, Math.min(1, cosI));
    const sinI = Math.sqrt(Math.max(0, 1 - ci * ci));
    const sinT = (n1 / n2) * sinI;
    if (sinT >= 1) return 1;
    const ct = Math.sqrt(Math.max(0, 1 - sinT * sinT));
    const rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
    const rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
    return Math.max(0, Math.min(1, 0.5 * (rs * rs + rp * rp)));
  },

  updateParticles: function () {
    const n = this.particleCount;
    const d = new Float32Array(n * 8);

    for (let i = 0; i < n; i++) {
      const b = i * 8;
      let px = 0, py = 0, pz = 0, vx = 0, vy = 0, vz = 0, aux = 0;
      const phase = Math.random();

      if (this.mode === 'seg') {
        const ring = i % 3;
        const R = ring === 0 ? 3.5 : ring === 1 ? 5.5 : 7.5;
        const a = Math.random() * Math.PI * 2;
        px = Math.cos(a) * R; pz = Math.sin(a) * R;
        py = (Math.random() - 0.5) * 1.6;
        vx = -Math.sin(a) * 1.0; vz = Math.cos(a) * 1.0;
      } else if (this.mode === 'heron') {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.random() * 0.3;
        px = Math.cos(a) * rr; pz = Math.sin(a) * rr;
        py = 3.6 + Math.random() * 3.8;
        vy = 2.0;
      } else if (this.mode === 'kelvin') {
        const side = (i & 1) ? 1 : -1;
        px = side * 2.5 + (Math.random() - 0.5) * 0.2;
        pz = (Math.random() - 0.5) * 0.2;
        py = -2.0 + Math.random() * 7.0;
        vy = -0.5;
        aux = side * 0.3;
      } else {
        const ledIdx = i % 6;
        const ledX = (ledIdx - 2.5) * 1.6;
        const tx = (Math.random() - 0.5) * 9.0, tz = (Math.random() - 0.5) * 9.0;
        const dx = tx - ledX, dy = 0.05 - 3.5, dz = tz - 1.5;
        const len = Math.hypot(dx, dy, dz) || 1;
        const prog = Math.random();
        px = ledX + dx * prog; py = 3.5 + dy * prog; pz = 1.5 + dz * prog;
        vx = dx / len * 6.0; vy = dy / len * 6.0; vz = dz / len * 6.0;
      }

      d[b] = px; d[b + 1] = py; d[b + 2] = pz; d[b + 3] = phase;
      d[b + 4] = vx; d[b + 5] = vy; d[b + 6] = vz; d[b + 7] = aux;
    }

    if (this.particleBuffer) this.particleBuffer.destroy();

    this.particleBuffer = this.device.createBuffer({
      size: d.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.particleBuffer, 0, d);
  },

  computeSolarTransmittance: function () {
    const n2 = ValidatedConstants.SILICON_REFRACTIVE_INDEX;
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      const ledX = (i - 2.5) * 1.6;
      const dx = -ledX, dy = -3.45, dz = -1.5;      // LED → panel centre
      const len = Math.hypot(dx, dy, dz);
      const cosI = Math.abs(dy) / len;              // vs panel normal (+Y)
      sum += 1 - this.fresnelR(cosI, n2);
    }
    return sum / 6;
  },

  heronExitVelocity: function (H) {
    if (H <= 1e-3) return 0;
    const g = 9.81, D = 0.02, L = 1.2, eps = 1.5e-6, rho = 1000, mu = 1.0e-3;
    const vIdeal = Math.sqrt(2 * g * H);
    const Re = Math.max(1, rho * vIdeal * D / mu);
    let f;
    if (Re < 2000) {
      f = 64 / Re;                                  // Hagen–Poiseuille (laminar)
    } else {
      const t = Math.log10(eps / (3.7 * D) + 5.74 / Math.pow(Re, 0.9));
      f = 0.25 / (t * t);                           // Swamee–Jain (turbulent)
    }
    // H = (1 + f·L/D)·v²/2g  →  v = sqrt(2gH / (1 + f·L/D))
    return Math.sqrt(2 * g * H / (1 + f * L / D));
  },

  stepPhysics: function (dt, drive) {
    // ── SEG: rotational kinematics with eddy-current braking ──────────────
    const field = 0.4 + 0.6 * this.magneticFieldStrength;
    const tauDrive = drive * field;                  // Lorentz/Poynting thrust
    const w = this.segOmega;
    const wArm = 2.5, eddyK = 1.33, visc = 0.05, tScale = 2.5;
    const tauEddy = eddyK * w / (1 + w / wArm) + visc * w;  // Lenz + armature rolloff
    this.segOmega = Math.max(0, w + (tauDrive - tauEddy) / (this.rollerHeft * tScale) * dt);
    this.rotationSpeed = Math.min(120, this.segOmega * 100);
    this.corona = Math.max(0, Math.min(1, (this.segOmega - 0.6) / 0.4)) * field;

    // ── Heron: head dynamics + Bernoulli/Swamee–Jain exit velocity ────────
    const pump = 2.2, drain = 0.30;
    this.heronHead = Math.max(0, Math.min(this.heronHeadMax,
      this.heronHead + (pump * drive - drain * this.heronVExit) * dt));
    this.heronVExit = this.heronExitVelocity(this.heronHead);

    // ── Kelvin: capacitive voltage runaway → breakdown spark ──────────────
    const chargeRate = 8000, feedback = 2.0, leak = 0.3;
    this.kelvinV += (drive * (chargeRate + feedback * this.kelvinV) - leak * this.kelvinV) * dt;
    this.kelvinV = Math.max(0, this.kelvinV);
    if (this.kelvinV >= this.kelvinVbreak && this.kelvinSparkTimer <= 0) {
      this.kelvinV *= 0.02;                          // discharge neutralises the buckets
      this.kelvinSparkTimer = this.kelvinSparkDur;
      this.generateLightning();
    }
    this.kelvinSparkTimer = Math.max(0, this.kelvinSparkTimer - dt);
    this.kelvinVoltageN = Math.max(0, Math.min(1, this.kelvinV / this.kelvinVbreak));
    this.kelvinE = 15.0 * this.kelvinVoltageN;        // qE coefficient (levitation near breakdown)

    // ── Solar: Fresnel-gated battery loop ─────────────────────────────────
    if (this.mode === 'solar') {
      const ledPower = 0.3 + 0.7 * drive;
      const gain = this.solarTransmittance * ledPower * 0.45;
      const drainW = ledPower * 0.30;
      this.batteryCharge = Math.max(0, Math.min(1, this.batteryCharge + (gain - drainW) * dt));
    } else {
      this.batteryCharge += (0.5 - this.batteryCharge) * dt * 0.5;
    }
  },

  generateLightning: function () {
    let pts = [[-1.3, -2.6, 0.0], [1.3, -2.6, 0.0]];
    let amp = 0.9;
    const rough = 0.55;
    for (let it = 0; it < 6; it++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        mid[1] += (Math.random() - 0.5) * amp;
        mid[2] += (Math.random() - 0.5) * amp;
        next.push(mid, q);
      }
      pts = next;
      amp *= Math.pow(2, -rough);
    }
    const data = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      data[i * 3] = pts[i][0]; data[i * 3 + 1] = pts[i][1]; data[i * 3 + 2] = pts[i][2];
    }
    this.device.queue.writeBuffer(this.lightningBuffer, 0, data);
    this.lightningCount = pts.length;
  },

};
