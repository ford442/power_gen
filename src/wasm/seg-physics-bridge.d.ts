/**
 * Ambient types for the WASM plant bridge (implementation stays JS — it owns
 * module loading, zero-copy buffer views and the JS fallback handoff).
 * Payload shapes are intentionally loose: they mirror the C++ struct returns.
 */

export interface SegWasmBridge {
  /** WASM module compiled and instantiated. */
  readonly available: boolean;
  /** Available *and* selected by the user / URL flag. */
  readonly enabled: boolean;
  /** Live metric from the zero-copy roller buffer (mean |ω|). */
  readonly lastRollerMeanOmega: number;

  init(): Promise<unknown>;
  dispose(): void;
  setEnabled(enabled: boolean): void;
  getVersion(): Promise<unknown>;

  step(dt: number, loadTorque?: number, drive?: number): unknown;
  getRollerState(loadTorque?: number): Promise<unknown>;
  runBenchmark(steps?: number, loadTorque?: number): Promise<unknown>;
  runJsVsWasmBenchmark(steps?: number): Promise<unknown>;

  setRingLoadTorque(ring: number, torque: number): void;
  setRingLoadTorques(t0: number, t1: number, t2: number): void;
  stepWithPerRingTorques(dt?: number): Promise<unknown>;

  setMode(mode: number): void;
  getMode(): number;
  setDrive(drive: number): void;
  getModePlant(): unknown;

  getParticles(maxCount?: number): unknown;
  getParticleFloatView(): Float32Array | null;
  getRollerStateFloatView(): Float32Array | null;
  meanParticleRadius(sample?: number): number;
  seedParticles(count: number): void;
  stepParticles(dt: number): void;

  setNetworkEdges(edges: unknown): void;
  updateEnergyNetwork(opts: {
    couplingEnabled?: boolean;
    segPowerW?: number;
    segEfficiencyPct?: number;
    energyByDevice?: Record<string, number>;
    enabledByDevice?: Record<string, boolean>;
  }): void;
  getNetworkSummary(): unknown;
  getNetworkEdgeAllocatedW(edgeIndex: number): number;
  getNetworkDevicePower(deviceId: string): number;
}

export const segWasm: SegWasmBridge;
export default segWasm;
