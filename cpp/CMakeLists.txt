cmake_minimum_required(VERSION 3.20)
project(sim_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ── Source ──────────────────────────────────────────────────────
file(GLOB SIM_CORE_PLANT_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/plant/*.cpp")
set(SIM_CORE_ROOT_SOURCES
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_facade.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_embind.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_standalone.cpp"
)
add_executable(sim_core ${SIM_CORE_ROOT_SOURCES} ${SIM_CORE_PLANT_SOURCES})
target_include_directories(sim_core PRIVATE src)

# ── Emscripten / WASM build ─────────────────────────────────────
if(EMSCRIPTEN)
  set_target_properties(sim_core PROPERTIES SUFFIX ".js")

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
  # -g0/--closure 1 match the Makefile `wasm` (release) target — this
  # CMake path has no separate debug configuration, so it always builds
  # release-optimized output.
  target_link_options(sim_core PRIVATE -O3 -g0 --closure 1)

  # Output directly into the Vite public/wasm directory so the dev
  # server can serve sim_core.js and sim_core.wasm without copying.
  set_target_properties(sim_core PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../src/public/wasm"
  )
else()
  # Native build: enable standalone smoke-test (clangd / compile_commands.json).
  # CI smoke remains `make native` / `npm run wasm:native` — this path is for
  # per-TU include flags, not a replacement smoke binary.
  target_compile_definitions(sim_core PRIVATE SIM_CORE_STANDALONE)
  target_compile_options(sim_core PRIVATE -Wall -Wextra -Wpedantic)
  set_target_properties(sim_core PROPERTIES OUTPUT_NAME sim_core_test)
endif()
