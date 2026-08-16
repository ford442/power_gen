cmake_minimum_required(VERSION 3.20)
project(sim_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

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

  # Shared link flags — cpp/emscripten.flags (same set as Makefile wasm target)
  file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/emscripten.flags" _emcc_flag_lines)
  foreach(_flag IN LISTS _emcc_flag_lines)
    if(NOT _flag MATCHES "^#")
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
  # Native build: enable standalone smoke-test
  target_compile_definitions(sim_core PRIVATE SIM_CORE_STANDALONE)
endif()
