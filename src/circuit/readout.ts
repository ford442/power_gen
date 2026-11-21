/**
 * The solver's readout (cpp/src/circuit/circuit.h, `_writeReadout`) as a
 * typed view: a C++-owned double buffer the WASM heap holds, read in place —
 * re-viewed whenever the heap grows (a grown `memory.buffer` detaches it).
 *
 *   [RO_HEADER]  time, status, steps, newton, rejected,
 *                W_source, W_dissipated, E_stored, E_stored_start   (this step() window)
 *   [nodes]      node voltages, index 0 = ground
 *   [elements]   READOUT_STRIDE each: i, v, p, ∫p dt, ∫i dt, ∫i² dt (window)
 */
import type { CircuitSimInstance, SimCoreModule } from '../wasm/sim-core/abi.generated';
import { RE, READOUT_STRIDE, RO, RO_HEADER } from './kinds';

/** What a bench port and the host's readers need of a readout. */
export interface ReadoutView {
  time(): number;
  nodeV(node: number): number;
  elemI(elem: number): number;
  elemV(elem: number): number;
  elemP(elem: number): number;
  wE(elem: number): number;
  wQ(elem: number): number;
  wI2(elem: number): number;
}

export class CircuitReadout implements ReadoutView {
  private view: Float64Array | null = null;
  private buffer: ArrayBufferLike | null = null;

  constructor(
    private readonly mod: Pick<SimCoreModule, 'HEAPF32'>,
    private readonly sim: CircuitSimInstance,
    private readonly nodeCount: number
  ) {}

  /** Re-view after every step (cheap: only rebuilt when the heap moved). */
  refresh(): Float64Array {
    const heap = this.mod.HEAPF32.buffer;
    const count = this.sim.readoutCount();
    if (!this.view || this.buffer !== heap || this.view.length !== count) {
      this.view = new Float64Array(heap, this.sim.readoutPtr(), count);
      this.buffer = heap;
    }
    return this.view;
  }

  private get ro(): Float64Array {
    return this.view ?? this.refresh();
  }

  time(): number { return this.ro[RO.time]; }
  status(): number { return this.ro[RO.status]; }
  steps(): number { return this.ro[RO.steps]; }
  /** Energy the sources delivered (J) over the last step() window. */
  wSource(): number { return this.ro[RO.wSource]; }
  wDissipated(): number { return this.ro[RO.wDissipated]; }
  stored(): number { return this.ro[RO.stored]; }
  storedStart(): number { return this.ro[RO.storedStart]; }

  nodeV(node: number): number {
    return node <= 0 ? 0 : this.ro[RO_HEADER + node];
  }

  private at(elem: number, col: number): number {
    return this.ro[RO_HEADER + this.nodeCount + elem * READOUT_STRIDE + col];
  }

  elemI(elem: number): number { return this.at(elem, RE.i); }
  elemV(elem: number): number { return this.at(elem, RE.v); }
  elemP(elem: number): number { return this.at(elem, RE.p); }
  /** ∫ v·i dt over the window (J; absorbed > 0). */
  wE(elem: number): number { return this.at(elem, RE.wE); }
  /** ∫ i dt over the window (C). */
  wQ(elem: number): number { return this.at(elem, RE.wQ); }
  /** ∫ i² dt over the window (A²·s). */
  wI2(elem: number): number { return this.at(elem, RE.wI2); }
}
