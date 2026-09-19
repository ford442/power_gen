// Per-pane refresh methods for the F3 debug overlay panel.
// Extracted from debug-panel.ts (mechanical split to respect the 700-line cap).
// Methods here are merged onto DebugPanel.prototype via Object.assign in debug-panel.ts,
// so `this` behaves exactly as it did when these were declared directly on the class.
import { SEG_DATA, KELVIN_DATA, HERON_DATA, MICROVOLT_DATA } from './scientific-data';
import type { DebugPanel } from './debug-panel';

export const paneMethods = {
  updateDevicePhysicsData(this: DebugPanel): void {
    const el = document.getElementById('devicePhysicsData');
    const viz = window.multiVisualizer;
    if (!el || !viz?.devices) return;

    const row = (label: string, value: string | number) =>
      `<div><span style="color:#666">${label}:</span> ${value}</div>`;

    const parts: string[] = [];
    for (const id of ['heron', 'kelvin', 'solar']) {
      const d = viz.devices[id];
      // WebGPU: physicsState; WebGL2: physics (aliased as physicsState too)
      const ps = d?.physicsState || d?.physics;
      if (!d || !ps) continue;
      parts.push(`<div style="color:#0cc;margin-top:4px;text-transform:uppercase">${id}</div>`);
      if (id === 'heron') {
        parts.push(row('Head', `${ps.heronHead.toFixed(2)} / ${ps.heronHeadMax.toFixed(1)} m`));
        parts.push(row('v_exit', `${ps.heronVExit.toFixed(2)} m/s`));
        parts.push(row('Flow', `${ps.heronFlowRateLmin.toFixed(1)} L/min`));
        parts.push(row('Pressure', `${ps.heronPressureKPa.toFixed(1)} kPa`));
        parts.push(row('Re', `${ps.heronReynolds.toFixed(0)}`));
        parts.push(row('Flow E', `${((d.flowEnergyLevel ?? 0) * 100).toFixed(0)}%`));
      } else if (id === 'kelvin') {
        parts.push(row('Voltage', `${(ps.kelvinVoltageN * ps.kelvinVbreak).toFixed(0)} V`));
        parts.push(row('Spark', ps.kelvinSparkTimer > 0 ? 'ACTIVE' : 'idle'));
      } else if (id === 'solar') {
        parts.push(row('Battery', `${(ps.batteryCharge * 100).toFixed(0)}%`));
      }
    }

    const pipeFlow = viz.energyPipes?.reduce((s, p) => s + (p.flowLevel || 0), 0) ?? 0;
    const net = viz.energyNetwork?.getSnapshot?.();
    parts.push(`<div style="color:#0cc;margin-top:6px">ENERGY PIPES</div>`);
    parts.push(row('Mode', net?.couplingEnabled ? 'coupled budget' : 'visual only'));
    if (net?.couplingEnabled) {
      parts.push(row('Lab budget', `${net.labBudgetW.toFixed(0)} W`));
      parts.push(row('Allocated', `${net.totalAllocatedW.toFixed(0)} W`));
      parts.push(row('Residual', `${net.residualW.toFixed(0)} W`));
    }
    parts.push(row('Total flow', `${(pipeFlow / Math.max(1, viz.energyPipes?.length || 1) * 100).toFixed(0)}% avg`));

    el.innerHTML = parts.join('') || '<div style="color:#666">No alternate devices active</div>';
  },

  drawFPSGraph(this: DebugPanel): void {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const points = this.profiler.getFPSGraphData(width, height);

    ctx.fillStyle = 'rgba(0, 20, 40, 1)';
    ctx.fillRect(0, 0, width, height);

    // Grid lines
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (i / 4) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // FPS line
    ctx.strokeStyle = '#0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) ctx.moveTo(p.x, Math.max(0, Math.min(height, p.y)));
      else ctx.lineTo(p.x, Math.max(0, Math.min(height, p.y)));
    }
    ctx.stroke();

    // Target FPS line (60fps)
    const targetY = height - (60 / 80) * height;
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(width, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('80 FPS', 4, 12);
    ctx.fillText('40 FPS', 4, height / 2);
    ctx.fillText('0 FPS', 4, height - 4);
  },

  drawCorrelationGraph(this: DebugPanel): void {
    const ctx = this.correlationCtx;
    const width = this.correlationCanvas.width;
    const height = this.correlationCanvas.height;
    const data = this.profiler.getParticleFPSCorrelation();

    ctx.fillStyle = 'rgba(0, 20, 40, 1)';
    ctx.fillRect(0, 0, width, height);

    if (data.length === 0) return;

    // Find ranges
    const maxParticles = Math.max(...data.map(d => d.particles));
    const maxFPS = 80;

    // Draw points
    for (const point of data) {
      const x = (point.particles / maxParticles) * width;
      const y = height - (point.fps / maxFPS) * height;

      const intensity = point.fps / 60;
      const r = Math.floor((1 - intensity) * 255);
      const g = Math.floor(intensity * 255);

      ctx.fillStyle = `rgba(${r}, ${g}, 100, 0.6)`;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }

    // Labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('0', 4, height - 4);
    ctx.fillText(maxParticles.toLocaleString(), width - 40, height - 4);
    ctx.fillText('80 FPS', 4, 12);
    ctx.fillText('Part', width / 2 - 15, height - 4);
  },

  updateMemoryDetails(this: DebugPanel): void {
    const memoryDiv = document.getElementById('memoryDetails')!;
    const recentBuffers = this.profiler.bufferAllocations.slice(-5);
    const recentTextures = this.profiler.textureAllocations.slice(-5);

    let html = '<div style="color: #888; margin-bottom: 8px;">Recent Allocations:</div>';

    html += '<div style="color: #0aa;">Buffers:</div>';
    for (const buf of recentBuffers) {
      const size = (buf.size / 1024 / 1024).toFixed(2);
      html += `<div style="margin-left: 8px; color: #888;">${buf.name}: ${size}MB</div>`;
    }

    html += '<div style="color: #0aa; margin-top: 8px;">Textures:</div>';
    for (const tex of recentTextures) {
      const size = (tex.size / 1024 / 1024).toFixed(2);
      html += `<div style="margin-left: 8px; color: #888;">${tex.name}: ${tex.width}x${tex.height} (${size}MB)</div>`;
    }

    memoryDiv.innerHTML = html;
  },

  updateScientificData(this: DebugPanel): void {
    const dataDiv = document.getElementById('validatedPhysicsData');
    if (!dataDiv) return;

    let html = '';

    // SEG Data
    html += '<div style="color: #0ff; margin-top: 8px;">SEG (Magnetic):</div>';
    html += `<div style="margin-left: 8px; color: #888;">B-field @ surface: <span style="color: #0ff">${SEG_DATA.B_FIELD.surface.toFixed(3)} T</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Magnetic moment: <span style="color: #0ff">${(SEG_DATA.MAGNETIC_MOMENT / 1e6).toFixed(2)} MA·m²</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Energy density: <span style="color: #0ff">${(SEG_DATA.ENERGY_DENSITY.surface / 1e6).toFixed(2)} MJ/m³</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Adjacent force: <span style="color: #0ff">${(SEG_DATA.ADJACENT_FORCE / 1e6).toFixed(1)} MN</span></div>`;

    // Kelvin Data
    html += '<div style="color: #f0f; margin-top: 8px;">Kelvin (Electrostatic):</div>';
    html += `<div style="margin-left: 8px; color: #888;">Bucket capacitance: <span style="color: #f0f">${(KELVIN_DATA.BUCKET.capacitance * 1e12).toFixed(1)} pF</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Droplet charge: <span style="color: #f0f">${(KELVIN_DATA.DROPLET.charge * 1e9).toFixed(0)} nC</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">V @ 1s: <span style="color: #f0f">${(KELVIN_DATA.VOLTAGE_BUILDUP.at1s / 1e3).toFixed(0)} kV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Spark gap @ 10kV: <span style="color: #f0f">${(KELVIN_DATA.SPARK_GAPS.at10kV * 1e3).toFixed(2)} mm</span></div>`;

    // Heron Data
    html += '<div style="color: #08f; margin-top: 8px;">Heron (SPH Fluid):</div>';
    html += `<div style="margin-left: 8px; color: #888;">Smoothing length: <span style="color: #08f">${(HERON_DATA.SPH.smoothingLength * 1e3).toFixed(1)} mm</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Gas constant: <span style="color: #08f">${(HERON_DATA.SPH.gasConstant / 1e3).toFixed(0)} kPa</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Siphon velocity (1m): <span style="color: #08f">${HERON_DATA.SIPHON_VELOCITY.at1m.toFixed(2)} m/s</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Pressure @ 2m: <span style="color: #08f">${(HERON_DATA.PRESSURE.at2m / 1e3).toFixed(1)} kPa</span></div>`;

    // Microvolt Data
    html += '<div style="color: #ff4; margin-top: 8px;">Microvolt Precision:</div>';
    html += `<div style="margin-left: 8px; color: #888;">Thermal noise (1Hz): <span style="color: #ff4">${(MICROVOLT_DATA.THERMAL_NOISE.at1Hz_1MOhm * 1e6).toFixed(3)} μV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Single e- on 1pF: <span style="color: #ff4">${(MICROVOLT_DATA.SINGLE_ELECTRON.at1pF * 1e6).toFixed(0)} nV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Min detectable: <span style="color: #ff4">${(MICROVOLT_DATA.SIMULATION.minVoltageStep * 1e6).toFixed(1)} μV</span></div>`;

    dataDiv.innerHTML = html;
  },
};
