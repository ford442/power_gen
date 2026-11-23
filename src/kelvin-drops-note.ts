/**
 * Kelvin bench: a one-line note saying what its drops are (ADR-0022,
 * docs/FLUIDS.md → Kelvin) — on WebGPU in focus the liquid solver's, on the
 * fallback renderer the same law stepped on the CPU, and otherwise a train of
 * drops that falls under gravity alone — and what share of them is landing in
 * the collectors, which is what the plant is charged with.
 *
 * A readout, not a control. Both renderers. The card and its refresh are the
 * Heron note's (heron-liquid-note.ts).
 */
import { HeronLiquidNote, type HeronLiquidNoteOptions } from './heron-liquid-note';

export const KELVIN_DROPS_NOTE_OWNER = 'kelvin';

/** What the note reads: the renderer, its report on the solver, and the plant's landing share. */
export interface KelvinDropsNoteState {
  renderer: string | null | undefined;
  /** `getRendererInfo().kelvinLiquid` — absent on WebGL2. */
  liquid?: { build: string; allocated: boolean; active: boolean; live: number; substeps: number } | null;
  /** `kelvinCollectionEff` on the bench's physics state: null while not measured. */
  landingShare?: number | null;
}

const share = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)} % landing in the collectors` : 'landing share not known yet';

/** The note for a renderer state. Pure — the test and the DOM both call it. */
export function kelvinDropsNoteText(s: KelvinDropsNoteState): string {
  const drop = 'one per Rayleigh–Plateau drop (3.3 mm), charged by its ring up to the Rayleigh limit';
  if (s.renderer !== 'webgpu') {
    return `Drops: ${drop}, moved by the rings' and collectors' field on the CPU (the liquid solver needs WebGPU) · `
      + `${share(s.landingShare)} · simulated, not a measurement`;
  }
  const f = s.liquid;
  if (f && f.allocated && f.active && f.substeps > 0) {
    return `Drops on the liquid solver: ${drop} · ${f.live} in the air · ${share(s.landingShare)} · simulated, not a measurement`;
  }
  if (f && (f.active || f.build === 'pending')) return 'Liquid solver starting…';
  return 'Liquid solver off — stand-in drops falling under gravity alone: they do not feel the rings, and the plant assumes they all land.';
}

declare global {
  interface Window {
    kelvinDropsNote?: HeronLiquidNote;
  }
}

/** Mount the Kelvin note (idempotent). */
export function initKelvinDropsNote(opts: HeronLiquidNoteOptions = {}): HeronLiquidNote {
  if (typeof window !== 'undefined' && window.kelvinDropsNote) return window.kelvinDropsNote;
  const read = (): KelvinDropsNoteState => {
    const info = window.getRendererInfo?.() as { kelvinLiquid?: KelvinDropsNoteState['liquid'] } | null | undefined;
    const devices = (window.multiVisualizer as { devices?: Record<string, { physicsState?: { kelvinCollectionEff?: number | null } }> } | undefined)?.devices;
    return {
      renderer: window.currentRenderer,
      liquid: info?.kelvinLiquid ?? null,
      landingShare: devices?.kelvin?.physicsState?.kelvinCollectionEff ?? null
    };
  };
  const note = new HeronLiquidNote({
    owner: KELVIN_DROPS_NOTE_OWNER,
    rootId: 'kelvin-drops-note',
    text: () => kelvinDropsNoteText(read()),
    ...opts
  });
  if (typeof window !== 'undefined') window.kelvinDropsNote = note;
  return note;
}
