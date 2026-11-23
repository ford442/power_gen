/**
 * MHD bench: a one-line note saying what the panel under the magnet is
 * (docs/FLUIDS.md → MHD duct → The slice) — on WebGPU in focus the duct's
 * mid-plane from a lattice-Boltzmann solve, with what the electrode pairs
 * deliver beside the plant's one ideal pair — and, where there is no solver,
 * that the profile card is all there is.
 *
 * A readout, not a control. Both renderers. The card and its refresh are the
 * Heron note's (heron-liquid-note.ts).
 */
import { HeronLiquidNote, type HeronLiquidNoteOptions } from './heron-liquid-note';

export const MHD_SLICE_NOTE_OWNER = 'mhd';

/** What the note reads: the renderer, its report on the slice, and the plant's current. */
export interface MhdSliceNoteState {
  renderer: string | null | undefined;
  /** `getRendererInfo().mhdSlice` — absent on WebGL2. */
  slice?: { build: string; allocated: boolean; active: boolean; steps: number; totalAmps: number | null } | null;
  /** `mhdCurrent` on the bench's physics state, A. */
  plantAmps?: number | null;
}

/** The note for a renderer state. Pure — the test and the DOM both call it. */
export function mhdSliceNoteText(s: MhdSliceNoteState): string {
  if (s.renderer !== 'webgpu') {
    return 'Flow solver needs WebGPU — here the duct is the profile card alone: the analytic Hartmann solution across the gap, at the plant\'s speed.';
  }
  const f = s.slice;
  if (f && f.allocated && f.active && f.steps > 0) {
    const what = 'Panel: the duct from above (lattice-Boltzmann, shown 10× slow) — colour is speed, lines are current, bars are the four electrode pairs';
    const plant = s.plantAmps;
    const amps = typeof f.totalAmps === 'number' && Number.isFinite(f.totalAmps) && typeof plant === 'number' && plant > 1
      ? ` · ${Math.round(f.totalAmps)} A reaches the loads of the ${Math.round(plant)} A one ideal pair would give; the rest circulates round the ends`
      : '';
    return `${what}${amps} · side layers drawn far thicker than real · simulated, not a measurement`;
  }
  if (f && (f.active || f.build === 'pending')) return 'Flow solver starting…';
  return 'Flow solver off — the duct is the profile card alone: the analytic Hartmann solution across the gap.';
}

declare global {
  interface Window {
    mhdSliceNote?: HeronLiquidNote;
  }
}

/** Mount the MHD note (idempotent). */
export function initMhdSliceNote(opts: HeronLiquidNoteOptions = {}): HeronLiquidNote {
  if (typeof window !== 'undefined' && window.mhdSliceNote) return window.mhdSliceNote;
  const read = (): MhdSliceNoteState => {
    const info = window.getRendererInfo?.() as { mhdSlice?: MhdSliceNoteState['slice'] } | null | undefined;
    const devices = (window.multiVisualizer as { devices?: Record<string, { physicsState?: { mhdCurrent?: number } }> } | undefined)?.devices;
    return {
      renderer: window.currentRenderer,
      slice: info?.mhdSlice ?? null,
      plantAmps: devices?.mhd?.physicsState?.mhdCurrent ?? null
    };
  };
  const note = new HeronLiquidNote({
    owner: MHD_SLICE_NOTE_OWNER,
    rootId: 'mhd-slice-note',
    text: () => mhdSliceNoteText(read()),
    ...opts
  });
  if (typeof window !== 'undefined') window.mhdSliceNote = note;
  return note;
}
