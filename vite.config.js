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
  },
  server: {
    https: false,
    host: 'localhost',
    port: 5173,
  },
  preview: {
    https: false,
  },
  // Treat raw .wasm files as static assets so they can be imported
  // with ?url (e.g. `import wasmUrl from './public/wasm/sim_core.wasm?url'`).
  assetsInclude: ['**/*.wasm', '**/*.glb'],
})
