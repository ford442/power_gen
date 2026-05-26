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

  target_link_options(sim_core PRIVATE
    "SHELL:-s WASM=1"
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_NAME=SimCore"
    "SHELL:--bind"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=[ccall,cwrap]"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s INITIAL_MEMORY=16777216"
    "SHELL:-s ENVIRONMENT=web"
    "SHELL:-s NO_EXIT_RUNTIME=1"
    -O3
  )

  # Output directly into the Vite public/wasm directory so the dev
  # server can serve sim_core.js and sim_core.wasm without copying.
  set_target_properties(sim_core PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../src/public/wasm"
  )
else()
  # Native build: enable standalone smoke-test
  target_compile_definitions(sim_core PRIVATE SIM_CORE_STANDALONE)
endif()
