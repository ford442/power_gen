# cpp/build/

This directory is created by the Emscripten build system and tracked so that
`make wasm` can run without manual setup.

The `.wasm` and `.js` artefacts are output to `../src/public/wasm/` (not here),
where Vite / GitHub Pages can serve them directly.
