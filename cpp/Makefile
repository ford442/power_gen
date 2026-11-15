# =============================================================
# Makefile  –  build sim_core.{js,wasm} with Emscripten
# =============================================================
#
# Prerequisites:
#   source /path/to/emsdk/emsdk_env.sh
#
# Targets:
#   make wasm        – release WASM build → src/wasm/sim-core/
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
#                      (needs emcmake on PATH)
#   make clean       – remove build artefacts
#
# The output (sim_core.wasm alone — no JS glue since #254) is written to
# ../src/wasm/sim-core/, where src/wasm/index.ts references it: Vite emits the
# .wasm under a content-hashed name and sim-core/instantiate.ts loads it.
# =============================================================

# sim_core_abi.cpp is the generated flat C ABI (cpp/abi.json →
# scripts/codegen-wasm-abi.mjs). It compiles natively too — EMSCRIPTEN_KEEPALIVE
# is empty there — so `make native` type-checks every export against
# sim_core.h under -Werror without Emscripten.
SIM_CORE_SHARED := src/sim_core_facade.cpp src/sim_core_standalone.cpp src/sim_core_abi.cpp $(wildcard src/plant/*.cpp)
SRC             := $(SIM_CORE_SHARED)
# standalone/*.cpp are the native `--mode` runs; they compile to nothing
# without SIM_CORE_STANDALONE, so they stay out of the WASM source list.
NATIVE_SRC      := $(SIM_CORE_SHARED) $(wildcard src/standalone/*.cpp)
# Imported by src/wasm/index.ts (Vite bundles the glue, hashes the .wasm URL).
OUT_DIR    := ../src/wasm/sim-core
OUT_WASM   := $(OUT_DIR)/sim_core.wasm

# Shared link flags — keep in sync via cpp/emscripten.flags (also used by CMake)
EMCC_FLAGS := $(shell grep -vE '^\s*#' emscripten.flags | grep -vE '^\s*$$' | tr '\n' ' ') -I src

# Baked into the release binary as sim_core_source_hash(); see
# scripts/sim-core-source-hash.mjs. Overridable for hermetic builds.
SIM_CORE_SOURCE_HASH ?= $(shell node ../scripts/sim-core-source-hash.mjs 2>/dev/null || echo unknown)

# ── Targets ─────────────────────────────────────────────────────

.PHONY: wasm wasm-dbg native native-san tidy compile-db compile-db-wasm clean

wasm: $(OUT_DIR)
	em++ -std=c++20 -O3 -g0 -DSIM_CORE_SOURCE_HASH='"$(SIM_CORE_SOURCE_HASH)"' $(EMCC_FLAGS) $(SRC) -o $(OUT_WASM)
	@echo "✓  WASM build complete → $(OUT_WASM)"

# Debug binary with DWARF (Chrome's C/C++ DevTools extension reads it). No
# ASSERTIONS / SAFE_HEAP: those are JS-glue features, and there is no glue.
wasm-dbg: $(OUT_DIR)
	em++ -std=c++20 -O0 -g $(EMCC_FLAGS) $(SRC) -o $(OUT_DIR)/sim_core_dbg.wasm
	@echo "✓  Debug WASM build complete → $(OUT_DIR)/sim_core_dbg.wasm"

# -Werror: the plants already build clean under -Wall -Wextra -Wpedantic,
# so a new warning here is a regression, not a backlog item.
native:
	mkdir -p build
	$(CXX) -std=c++20 -O2 -Wall -Wextra -Wpedantic -Werror -DSIM_CORE_STANDALONE -I src $(NATIVE_SRC) -o build/sim_core_test
	./build/sim_core_test
	./build/sim_core_test --mode catalog
	./build/sim_core_test --mode integrators > build/integrators.txt
	@echo "✓  Integrators vs reference → build/integrators.txt"
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
	$(SAN_CXX) -std=c++20 $(SAN_FLAGS) -Wall -Wextra -Wpedantic -Werror -DSIM_CORE_STANDALONE -I src $(NATIVE_SRC) -o build/sim_core_test_san
	$(SAN_ENV) ./build/sim_core_test_san
	$(SAN_ENV) ./build/sim_core_test_san --mode golden > build/golden_san.txt
	$(SAN_ENV) ./build/sim_core_test_san --mode jumping-ring
	$(SAN_ENV) ./build/sim_core_test_san --mode energy-network
	$(SAN_ENV) ./build/sim_core_test_san --mode integrators > build/integrators_san.txt
	@echo "✓  ASan + UBSan clean (default, golden, jumping-ring, energy-network, integrators) — $(SAN_CXX)"

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

# Emscripten CMake configure: the database with the emscripten.flags compile
# options and em++'s sysroot (so clangd resolves <emscripten/emscripten.h> in
# sim_core_abi.cpp). Configure only — nothing is compiled. See cpp/README.md →
# Compilation database.
compile-db-wasm:
	emcmake cmake -S . -B build-wasm -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
	@echo "✓  WASM compilation database → build-wasm/compile_commands.json"

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

clean:
	rm -f $(OUT_DIR)/sim_core.wasm $(OUT_DIR)/sim_core_dbg.wasm
	rm -f build/sim_core_test build/sim_core_test_san
