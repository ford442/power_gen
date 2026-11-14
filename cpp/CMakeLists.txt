cmake_minimum_required(VERSION 3.20)
project(sim_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ── Source ──────────────────────────────────────────────────────
# sim_core_embind.cpp is WASM-only: its whole body is inside
# `#ifdef __EMSCRIPTEN__`, so a native build compiles an empty translation
# unit and the compilation database gains an entry clangd can do nothing
# with. It is added to the Emscripten target only, below.
file(GLOB SIM_CORE_PLANT_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/plant/*.cpp")
set(SIM_CORE_ROOT_SOURCES
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_facade.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_standalone.cpp"
)
add_executable(sim_core ${SIM_CORE_ROOT_SOURCES} ${SIM_CORE_PLANT_SOURCES})
target_include_directories(sim_core PRIVATE src)

# ── Emscripten / WASM build ─────────────────────────────────────
if(EMSCRIPTEN)
  # Embind bindings: WASM build only (see the note above the source list).
  target_sources(sim_core PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src/sim_core_embind.cpp")
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
  # Compile database ONLY (`make compile-db-wasm`, for clangd). The shipped
  # binary comes from `make -C cpp wasm` (scripts/build-wasm.sh, CI, Pages),
  # never from here. The flags match the Makefile release target, -O3 on the
  # per-file compile too, so the database shows what really compiles — but
  # linking is refused: an unoptimised CMake link once could, and did, write
  # an -O0 sim_core.wasm over the committed one.
  target_compile_options(sim_core PRIVATE -O3)
  target_link_options(sim_core PRIVATE -O3 -g0 --closure 1)
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
  # Makefile's `native` target so clangd sees what CI compiles, minus the
  # Embind TU, which has no native content to jump into.
  # standalone/*.cpp: the native `--mode` runs (native only, like the driver).
  file(GLOB SIM_CORE_STANDALONE_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/standalone/*.cpp")
  target_sources(sim_core PRIVATE ${SIM_CORE_STANDALONE_SOURCES})
  target_compile_definitions(sim_core PRIVATE SIM_CORE_STANDALONE)
  target_compile_options(sim_core PRIVATE -Wall -Wextra -Wpedantic -Werror)
  set_target_properties(sim_core PROPERTIES OUTPUT_NAME sim_core_test)
endif()
