cmake_minimum_required(VERSION 3.20)
project(sim_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Source ──────────────────────────────────────────────────────
add_executable(sim_core src/sim_core.cpp)
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
  target_link_options(sim_core PRIVATE -O3)

  # Output directly into the Vite public/wasm directory so the dev
  # server can serve sim_core.js and sim_core.wasm without copying.
  set_target_properties(sim_core PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../src/public/wasm"
  )
else()
  # Native build: enable standalone smoke-test
  target_compile_definitions(sim_core PRIVATE SIM_CORE_STANDALONE)
endif()
