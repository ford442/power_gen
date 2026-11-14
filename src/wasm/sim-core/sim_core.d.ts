// Types for the Emscripten ES-module glue next to this file (built by
// `make -C cpp wasm`; see README.md). The factory's module shape lives in
// ../types.ts.
import type { SimCoreFactory } from '../types';

declare const SimCore: SimCoreFactory;
export default SimCore;
