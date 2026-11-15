cmake_minimum_required(VERSION 3.20)
project(sim_core CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ── Source ──────────────────────────────────────────────────────
# sim_core_abi.cpp is the generated flat C ABI (cpp/abi.json); it compiles on
# both targets (EMSCRIPTEN_KEEPALIVE is empty natively), so clangd and the
# native build see every export.
file(GLOB SIM_CORE_PLANT_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/plant/*.cpp")
set(SIM_CORE_ROOT_SOURCES
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_facade.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_standalone.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_abi.cpp"
)
add_executable(sim_core ${SIM_CORE_ROOT_SOURCES} ${SIM_CORE_PLANT_SOURCES})
target_include_directories(sim_core PRIVATE src)

# ── Emscripten / WASM build ─────────────────────────────────────
if(EMSCRIPTEN)
  set_target_properties(sim_core PROPERTIES SUFFIX ".wasm")

  # Shared flags — cpp/emscripten.flags (same set as Makefile wasm target).
  # Applied to both compile and link steps: CMake compiles each .cpp to its
  # own object file before linking (unlike the Makefile's single em++
  # invocation), so a codegen flag like -fno-exceptions must reach the
  # per-file compile command too, not just the final link — link-only
  # settings like `-s FILESYSTEM=0` are harmless no-ops at compile time.
  # ENCODING UTF-8: without it, file(STRINGS) treats the em-dash in this
  # file's header comment as a line terminator (it reads non-ASCII bytes
  # the way the `strings` utility does), truncating that comment line and
  # leaking its remainder in as a bogus flag.
  file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/emscripten.flags" _emcc_flag_lines ENCODING UTF-8)
  foreach(_flag IN LISTS _emcc_flag_lines)
    if(NOT _flag MATCHES "^#")
      target_compile_options(sim_core PRIVATE "SHELL:${_flag}")
      target_link_options(sim_core PRIVATE "SHELL:${_flag}")
    endif()
  endforeach()
  # Compile database ONLY (`make compile-db-wasm`, for clangd). The shipped
  # binary comes from `make -C cpp wasm` (scripts/build-wasm.sh, CI, Pages),
  # never from here. The flags match the Makefile release target, -O3 on the
  # per-file compile too, so the database shows what really compiles — but
  # linking is refused: an unoptimised CMake link once could, and did, write
  # an -O0 sim_core.wasm over the committed one.
  target_compile_options(sim_core PRIVATE -O3)
  target_link_options(sim_core PRIVATE -O3 -g0)
  set_target_properties(sim_core PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/not-shipped"
  )
  add_custom_command(TARGET sim_core PRE_LINK
    COMMAND ${CMAKE_COMMAND} -E echo
      "sim_core: the Emscripten CMake build is a compile database only. Build the shipped WASM with: make -C cpp wasm  (or npm run wasm:build)"
    COMMAND ${CMAKE_COMMAND} -E false
    VERBATIM
  )
else()
  # Native build: enable standalone smoke-test (clangd / compile_commands.json).
  # CI smoke remains `make native` / `npm run wasm:native` — this path is for
  # per-TU include flags, not a replacement smoke binary. Same flags as the
  # Makefile's `native` target so clangd sees what CI compiles.
  # standalone/*.cpp: the native `--mode` runs (native only, like the driver).
  file(GLOB SIM_CORE_STANDALONE_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/standalone/*.cpp")
  target_sources(sim_core PRIVATE ${SIM_CORE_STANDALONE_SOURCES})
  target_compile_definitions(sim_core PRIVATE SIM_CORE_STANDALONE)
  target_compile_options(sim_core PRIVATE -Wall -Wextra -Wpedantic -Werror)
  set_target_properties(sim_core PROPERTIES OUTPUT_NAME sim_core_test)
endif()
