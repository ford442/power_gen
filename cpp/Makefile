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

SRC        := src/sim_core.cpp
OUT_DIR    := ../src/public/wasm
OUT_JS     := $(OUT_DIR)/sim_core.js

EMCC_FLAGS := \
  --bind \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=SimCore \
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s ENVIRONMENT=web \
  -s NO_EXIT_RUNTIME=1 \
  -I src

# ── Targets ─────────────────────────────────────────────────────

.PHONY: wasm wasm-dbg native clean

wasm: $(OUT_DIR)
	emcc -O3 $(EMCC_FLAGS) $(SRC) -o $(OUT_JS)
	@echo "✓  WASM build complete → $(OUT_JS)"

wasm-dbg: $(OUT_DIR)
	emcc -O0 -g $(EMCC_FLAGS) \
	  -s ASSERTIONS=1 \
	  -s SAFE_HEAP=1 \
	  $(SRC) -o $(OUT_DIR)/sim_core_dbg.js
	@echo "✓  Debug WASM build complete → $(OUT_DIR)/sim_core_dbg.js"

native:
	$(CXX) -std=c++17 -O2 -DSIM_CORE_STANDALONE -I src $(SRC) -o build/sim_core_test
	./build/sim_core_test

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

clean:
	rm -f $(OUT_DIR)/sim_core.js $(OUT_DIR)/sim_core.wasm
	rm -f $(OUT_DIR)/sim_core_dbg.js $(OUT_DIR)/sim_core_dbg.wasm
	rm -f build/sim_core_test
