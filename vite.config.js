import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src',
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
