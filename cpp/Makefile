# =============================================================
# Makefile  –  build sim_core.{js,wasm} with Emscripten
# =============================================================
#
# Prerequisites:
#   source /path/to/emsdk/emsdk_env.sh
#
# Targets:
#   make wasm        – release WASM build → src/public/wasm/
#   make wasm-dbg    – debug WASM build with source maps
#   make native      – native binary (smoke-test, no Emscripten needed)
#                      warning-free build: -Wall -Wextra -Wpedantic -Werror
#   make compile-db  – native CMake configure → build/compile_commands.json
#   make clean       – remove build artefacts
#
# The output (sim_core.js + sim_core.wasm) is written directly to
# ../src/public/wasm/ so Vite / the GitHub Pages root can serve it.
# =============================================================

# sim_core_embind.cpp is WASM-only — its body is entirely inside
# `#ifdef __EMSCRIPTEN__`, so `make native` was compiling an empty
# translation unit. Keep it out of the native source list (CMake does the
# same, so the compilation database clangd reads matches).
SIM_CORE_SHARED := src/sim_core_facade.cpp src/sim_core_standalone.cpp $(wildcard src/plant/*.cpp)
SRC             := $(SIM_CORE_SHARED) src/sim_core_embind.cpp
NATIVE_SRC      := $(SIM_CORE_SHARED)
OUT_DIR    := ../src/public/wasm
OUT_JS     := $(OUT_DIR)/sim_core.js

# Shared link flags — keep in sync via cpp/emscripten.flags (also used by CMake)
EMCC_FLAGS := $(shell grep -vE '^\s*#' emscripten.flags | grep -vE '^\s*$$' | tr '\n' ' ') -I src

# ── Targets ─────────────────────────────────────────────────────

.PHONY: wasm wasm-dbg native compile-db clean

wasm: $(OUT_DIR)
	em++ -std=c++17 -O3 -g0 --closure 1 $(EMCC_FLAGS) $(SRC) -o $(OUT_JS)
	@echo "✓  WASM build complete → $(OUT_JS)"

wasm-dbg: $(OUT_DIR)
	em++ -std=c++17 -O0 -g $(EMCC_FLAGS) \
	  -s ASSERTIONS=1 \
	  -s SAFE_HEAP=1 \
	  $(SRC) -o $(OUT_DIR)/sim_core_dbg.js
	@echo "✓  Debug WASM build complete → $(OUT_DIR)/sim_core_dbg.js"

# -Werror: the plants already build clean under -Wall -Wextra -Wpedantic,
# so a new warning here is a regression, not a backlog item.
native:
	mkdir -p build
	$(CXX) -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -DSIM_CORE_STANDALONE -I src $(NATIVE_SRC) -o build/sim_core_test
	./build/sim_core_test
	./build/sim_core_test --mode catalog
	./build/sim_core_test --export-csv 10 build/seg_telemetry.csv 10
	@echo "✓  CSV export smoke → build/seg_telemetry.csv"

# Native CMake configure for clangd (does not replace `make native` in CI).
compile-db:
	cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
	@echo "✓  Compilation database → build/compile_commands.json"
	@echo "    From repo root: ln -sfn cpp/build/compile_commands.json compile_commands.json"

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

clean:
	rm -f $(OUT_DIR)/sim_core.js $(OUT_DIR)/sim_core.wasm
	rm -f $(OUT_DIR)/sim_core_dbg.js $(OUT_DIR)/sim_core_dbg.wasm
	rm -f build/sim_core_test
