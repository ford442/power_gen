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
#   make native-san  – native binary under ASan + UBSan (clang++ or g++ with
#                      the sanitizer runtimes); prefer `npm run wasm:native:san`,
#                      which probes for a working toolchain and skips cleanly
#   make tidy        – advisory clang-tidy over NATIVE_SRC (cpp/.clang-tidy);
#                      needs `make compile-db` first, never fails the build
#   make compile-db  – native CMake configure → build/compile_commands.json
#   make compile-db-wasm – emcmake configure → build-wasm/compile_commands.json
#                      (Embind TU included; needs emcmake on PATH)
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
# standalone/*.cpp are the native `--mode` runs; they compile to nothing
# without SIM_CORE_STANDALONE, so they stay out of the WASM source list.
NATIVE_SRC      := $(SIM_CORE_SHARED) $(wildcard src/standalone/*.cpp)
OUT_DIR    := ../src/public/wasm
OUT_JS     := $(OUT_DIR)/sim_core.js

# Shared link flags — keep in sync via cpp/emscripten.flags (also used by CMake)
EMCC_FLAGS := $(shell grep -vE '^\s*#' emscripten.flags | grep -vE '^\s*$$' | tr '\n' ' ') -I src

# ── Targets ─────────────────────────────────────────────────────

.PHONY: wasm wasm-dbg native native-san tidy compile-db compile-db-wasm clean

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

# ASan + UBSan over the same native sources and warning bar as `native`.
# -fno-sanitize-recover makes the first UB report fatal, so a clean exit code
# means a clean run. SAN_CXX defaults to $(CXX); scripts/native-san.sh picks
# one whose sanitizer runtimes are actually installed (a distro clang without
# compiler-rt links nothing).
SAN_CXX   ?= $(CXX)
SAN_FLAGS := -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined
SAN_ENV   := ASAN_OPTIONS=detect_leaks=1:abort_on_error=1:strict_string_checks=1 UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1

native-san:
	mkdir -p build
	$(SAN_CXX) -std=c++17 $(SAN_FLAGS) -Wall -Wextra -Wpedantic -Werror -DSIM_CORE_STANDALONE -I src $(NATIVE_SRC) -o build/sim_core_test_san
	$(SAN_ENV) ./build/sim_core_test_san
	$(SAN_ENV) ./build/sim_core_test_san --mode golden > build/golden_san.txt
	$(SAN_ENV) ./build/sim_core_test_san --mode jumping-ring
	$(SAN_ENV) ./build/sim_core_test_san --mode energy-network
	@echo "✓  ASan + UBSan clean (default, golden, jumping-ring, energy-network) — $(SAN_CXX)"

# Advisory only: cpp/.clang-tidy keeps WarningsAsErrors empty and this target
# never fails, until the finding count is near zero (see cpp/README.md).
tidy:
	@test -f build/compile_commands.json || $(MAKE) compile-db
	-clang-tidy -p build --quiet $(NATIVE_SRC)

# Native CMake configure for clangd (does not replace `make native` in CI).
compile-db:
	cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
	@echo "✓  Compilation database → build/compile_commands.json"
	@echo "    From repo root: ln -sfn cpp/build/compile_commands.json compile_commands.json"

# Emscripten CMake configure: the only database that lists sim_core_embind.cpp
# (with the emscripten.flags compile options and em++'s sysroot), so clangd can
# jump from an EMSCRIPTEN_BINDINGS entry into the method it binds. Configure
# only — nothing is compiled. See cpp/README.md → Compilation database.
compile-db-wasm:
	emcmake cmake -S . -B build-wasm -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
	@echo "✓  WASM compilation database → build-wasm/compile_commands.json"

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

clean:
	rm -f $(OUT_DIR)/sim_core.js $(OUT_DIR)/sim_core.wasm
	rm -f $(OUT_DIR)/sim_core_dbg.js $(OUT_DIR)/sim_core_dbg.wasm
	rm -f build/sim_core_test build/sim_core_test_san
