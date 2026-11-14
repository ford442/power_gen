/**
 * PNG export for the analysis panel: the uPlot canvases (axes, ticks and
 * curves are drawn on canvas) stacked under a title, axis/units line, fit line
 * and a hand-drawn legend, with the disclaimer burned into the footer — a
 * shared image must not lose "Simulated — not metrology".
 */

export interface PngLegendItem {
  label: string;
  color: string;
  dashed: boolean;
}

export interface PngStrip {
  canvas: HTMLCanvasElement;
  legend: PngLegendItem[];
}

export interface PngSpec {
  title: string;
  /** View · x axis · y axes. */
  subtitle: string;
  lines: string[];
  strips: PngStrip[];
  disclaimer: string;
  footer: string;
  background: string;
  ink: string;
  muted: string;
  warn: string;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Compose the export canvas (call `toBlob` on the result). */
export function composePlotPng(spec: PngSpec): HTMLCanvasElement {
  const first = spec.strips[0]?.canvas;
  const dpr = first && first.clientWidth > 0 ? first.width / first.clientWidth : (window.devicePixelRatio || 1);
  const pad = Math.round(12 * dpr);
  const plotW = Math.max(320 * dpr, ...spec.strips.map((s) => s.canvas.width));
  const width = plotW + 2 * pad;
  const font = (px: number, weight = 'normal') => `${weight} ${Math.round(px * dpr)}px 'Segoe UI', Tahoma, sans-serif`;
  const lineH = (px: number) => Math.round(px * 1.45 * dpr);

  const out = document.createElement('canvas');
  const ctx = out.getContext('2d')!;
  // Layout pass (measureText needs the font set), then the draw pass.
  type Op = { kind: 'text'; text: string; font: string; color: string; h: number }
    | { kind: 'legend'; items: PngLegendItem[]; h: number }
    | { kind: 'image'; canvas: HTMLCanvasElement; h: number };
  const ops: Op[] = [];
  const text = (t: string, px: number, color: string, weight = 'normal') => {
    ctx.font = font(px, weight);
    for (const l of wrap(ctx, t, plotW)) ops.push({ kind: 'text', text: l, font: font(px, weight), color, h: lineH(px) });
  };
  text(spec.title, 15, spec.ink, '600');
  text(spec.subtitle, 12, spec.muted);
  for (const l of spec.lines) text(l, 12, spec.ink);
  for (const strip of spec.strips) {
    if (strip.legend.length) ops.push({ kind: 'legend', items: strip.legend, h: lineH(11) * Math.ceil(strip.legend.length / 2) });
    ops.push({ kind: 'image', canvas: strip.canvas, h: strip.canvas.height });
  }
  text(spec.disclaimer, 12, spec.warn, '600');
  text(spec.footer, 11, spec.muted);

  out.width = width;
  out.height = pad * 2 + ops.reduce((h, op) => h + op.h, 0);
  ctx.fillStyle = spec.background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.textBaseline = 'middle';
  let y = pad;
  for (const op of ops) {
    if (op.kind === 'text') {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.fillText(op.text, pad, y + op.h / 2);
    } else if (op.kind === 'legend') {
      ctx.font = font(11);
      const rowH = lineH(11);
      const colW = plotW / 2;
      op.items.forEach((item, i) => {
        const x = pad + (i % 2) * colW;
        const cy = y + Math.floor(i / 2) * rowH + rowH / 2;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash(item.dashed ? [6 * dpr, 4 * dpr] : []);
        ctx.beginPath();
        ctx.moveTo(x, cy);
        ctx.lineTo(x + 18 * dpr, cy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = spec.ink;
        const parts = wrap(ctx, item.label, colW - 30 * dpr);
        ctx.fillText(parts.length > 1 ? `${parts[0]}…` : (parts[0] ?? ''), x + 24 * dpr, cy);
      });
    } else {
      ctx.drawImage(op.canvas, pad, y);
    }
    y += op.h;
  }
  return out;
}
