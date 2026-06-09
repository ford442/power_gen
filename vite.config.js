import { defineConfig } from 'vite'

// Relative base works on GitHub Pages (/seg-webgpu-visualizer/) and Contabo (/powergen/)
// without hard-coding a deploy path. Override: VITE_BASE_PATH=/custom/ npm run build
const base = process.env.VITE_BASE_PATH || './'

export default defineConfig({
  root: 'src',
  base,
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
  assetsInclude: ['**/*.wasm'],
})
