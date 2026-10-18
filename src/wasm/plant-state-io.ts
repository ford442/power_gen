/**
 * Plant snapshot I/O (#224 §2) — `plantSave` / `plantLoad` over the sim_core
 * scratch ABI, the same way the energy bus passes its arrays: the C++ side
 * owns a float scratch (`getScratchPtr`), JS reads / writes it through
 * HEAPF32, and no std::vector crosses the boundary.
 *
 * Kept out of SEGSim so the entry chunk does not carry it: the plant worker
 * and the lazy snapshot chunk (session/lab-snapshot.ts) import it. Vector
 * layout: `DEVICE_STATE_LAYOUT` in generated/device-state.ts.
 */
import { getSimCore } from './index';
import type { SEGSimulatorInstance } from './types';

function heap(): Float32Array | null {
  return getSimCore()?.HEAPF32 ?? null;
}

/** `mode`'s state vector, or null on a binary without plantSave. */
export function savePlantState(sim: SEGSimulatorInstance | null, mode: number): Float32Array | null {
  if (!sim?.plantSave || !sim.getScratchPtr) return null;
  const n = sim.plantSave(mode);
  if (!(n > 0)) return null;
  // Re-read HEAPF32 after getScratchPtr: the scratch may have grown the heap.
  const ptr = Number(sim.getScratchPtr(n)) >> 2;
  const f32 = heap();
  return f32 && ptr ? f32.slice(ptr, ptr + n) : null;
}

/** Restore `mode` from a {@link savePlantState} vector; false when sim_core refused it. */
export function loadPlantState(
  sim: SEGSimulatorInstance | null,
  mode: number,
  values: ArrayLike<number>,
  layoutHash: number
): boolean {
  if (!sim?.plantLoad || !sim.getScratchPtr) return false;
  const ptr = Number(sim.getScratchPtr(values.length)) >> 2;
  const f32 = heap();
  if (!f32 || !ptr) return false;
  f32.set(values, ptr);
  return sim.plantLoad(mode, values.length, layoutHash >>> 0);
}
