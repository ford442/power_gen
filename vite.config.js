import { defineConfig } from 'vite'
import wgslInclude from './src/shaders/vite-plugin-wgsl-include.js'
import precache from './scripts/vite-plugin-precache.mjs'

// Relative base works on GitHub Pages (/power_gen/) and Contabo (/powergen/)
// without hard-coding a deploy path. Override: VITE_BASE_PATH=/custom/ npm run build
const base = process.env.VITE_BASE_PATH || './'

export default defineConfig({
  root: 'src',
  base,
  // precache: writes dist/sw.js for offline classroom boots (docs/CLASSROOM.md).
  plugins: [wgslInclude(), precache()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Every WebGPU-capable browser supports ES2022.
    target: 'es2022',
    // Maps are emitted but not referenced from the bundle (no public leak).
    sourcemap: 'hidden',
    // Emits dist/.vite/manifest.json (bundle-budget baseline).
    manifest: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    https: false,
    host: 'localhost',
    port: 5173,
    // Pre-transform the entry graph at server start; cold transforms on
    // SwiftShader VMs can exceed 90 s (see playwright.config.js).
    warmup: { clientFiles: ['./main.ts'] },
  },
  preview: {
    https: false,
  },
  // Treat raw .wasm files as static assets so they can be imported
  // with ?url (e.g. `import wasmUrl from './public/wasm/sim_core.wasm?url'`).
  assetsInclude: ['**/*.wasm', '**/*.glb'],
})
