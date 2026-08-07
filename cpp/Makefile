# =============================================================
# Makefile  –  build sim_core.{js,wasm} with Emscripten
# =============================================================
#
# Prerequisites:
#   source /path/to/emsdk/emsdk_env.sh
#
# Targets:
#   make wasm     – release WASM build → src/public/wasm/
#   make wasm-dbg – debug WASM build with source maps
#   make native   – native binary (smoke-test, no Emscripten needed)
#   make clean    – remove build artefacts
#
# The output (sim_core.js + sim_core.wasm) is written directly to
# ../src/public/wasm/ so Vite / the GitHub Pages root can serve it.
# =============================================================

SRC        := src/sim_core.cpp $(wildcard src/plant/*.cpp)
OUT_DIR    := ../src/public/wasm
OUT_JS     := $(OUT_DIR)/sim_core.js

# Shared link flags — keep in sync via cpp/emscripten.flags (also used by CMake)
EMCC_FLAGS := $(shell grep -vE '^\s*#' emscripten.flags | grep -vE '^\s*$$' | tr '\n' ' ') -I src

# ── Targets ─────────────────────────────────────────────────────

.PHONY: wasm wasm-dbg native clean

wasm: $(OUT_DIR)
	em++ -O3 $(EMCC_FLAGS) $(SRC) -o $(OUT_JS)
	@echo "✓  WASM build complete → $(OUT_JS)"

wasm-dbg: $(OUT_DIR)
	em++ -O0 -g $(EMCC_FLAGS) \
	  -s ASSERTIONS=1 \
	  -s SAFE_HEAP=1 \
	  $(SRC) -o $(OUT_DIR)/sim_core_dbg.js
	@echo "✓  Debug WASM build complete → $(OUT_DIR)/sim_core_dbg.js"

native:
	mkdir -p build
	$(CXX) -std=c++17 -O2 -DSIM_CORE_STANDALONE -I src $(SRC) -o build/sim_core_test
	./build/sim_core_test
	./build/sim_core_test --export-csv 10 build/seg_telemetry.csv 10
	@echo "✓  CSV export smoke → build/seg_telemetry.csv"

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

clean:
	rm -f $(OUT_DIR)/sim_core.js $(OUT_DIR)/sim_core.wasm
	rm -f $(OUT_DIR)/sim_core_dbg.js $(OUT_DIR)/sim_core_dbg.wasm
	rm -f build/sim_core_test
