# cpp/build/

Native CMake configure (`cmake -S cpp -B cpp/build`) and `make native` write
here: `sim_core_test`, CMake cache, and `compile_commands.json` for clangd.

That JSON is **gitignored**. From the repo root:

```bash
cmake -S cpp -B cpp/build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
ln -sfn cpp/build/compile_commands.json compile_commands.json
```

`.clangd` at the repo root points `CompilationDatabase` at this directory.

WASM `.js` / `.wasm` artefacts are written to `../src/public/wasm/`, not here.
CI smoke remains `make native` / `npm run wasm:native` (not this CMake build).
