/**
 * Instantiate sim_core.wasm — no Emscripten JS glue (#254 §3).
 *
 * The binary is a plain reactor module (`--no-entry`, standalone): it exports
 * its memory, `_initialize` (static constructors) and the flat C ABI that
 * cpp/abi.json declares, and imports exactly {@link SIM_CORE_IMPORTS}:
 *
 *   env.emscripten_notify_memory_growth   heap grew — the views in
 *                                          abi.generated.ts rebuild lazily,
 *                                          so nothing to do
 *   wasi_snapshot_preview1.clock_time_get  std::time() for the particle RNG
 *                                          seed (SEGSimulator's constructor)
 *
 * `npm run test:wasm-abi` fails if the shipped binary imports anything else,
 * so a new libc dependency shows up there, not as a LinkError in a browser.
 * Loaded lazily (src/wasm/index.ts `import()`s this file), like the glue was.
 */
import { bindSimCore, type SimCoreExports, type SimCoreModule } from './abi.generated';

/** `module.name` of every import the binary may have. */
export const SIM_CORE_IMPORTS: readonly string[] = [
  'env.emscripten_notify_memory_growth',
  'wasi_snapshot_preview1.clock_time_get'
];

const WASI_ESUCCESS = 0;

function imports(memory: () => WebAssembly.Memory): WebAssembly.Imports {
  return {
    env: {
      emscripten_notify_memory_growth: (): void => {}
    },
    wasi_snapshot_preview1: {
      // (clock id, precision: i64, out: *u64 ns) → errno. Wall clock is all the
      // RNG seed wants; every clock id gets it.
      clock_time_get: (_id: number, _precision: bigint, out: number): number => {
        new DataView(memory().buffer).setBigUint64(out >>> 0, BigInt(Date.now()) * 1_000_000n, true);
        return WASI_ESUCCESS;
      }
    }
  };
}

/**
 * Instantiate from bytes, or fetch `url` (streaming when the server sends
 * `application/wasm`). Rejects on a fetch / compile / link failure.
 */
export async function instantiateSimCore(source: BufferSource | string): Promise<SimCoreModule> {
  let ex: SimCoreExports | null = null;
  const imp = imports(() => {
    if (!ex) throw new Error('sim_core: import called before instantiation');
    return ex.memory;
  });
  let instance: WebAssembly.Instance;
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`sim_core.wasm: HTTP ${res.status}`);
    const streaming = typeof WebAssembly.instantiateStreaming === 'function'
      && res.headers.get('content-type')?.startsWith('application/wasm') === true;
    instance = streaming
      ? (await WebAssembly.instantiateStreaming(res, imp)).instance
      : (await WebAssembly.instantiate(await res.arrayBuffer(), imp)).instance;
  } else {
    instance = (await WebAssembly.instantiate(source, imp)).instance;
  }
  ex = instance.exports as unknown as SimCoreExports;
  // Reactor start: run static constructors before any other export.
  (instance.exports._initialize as (() => void) | undefined)?.();
  return bindSimCore(ex);
}
