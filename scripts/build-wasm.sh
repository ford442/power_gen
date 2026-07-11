#!/usr/bin/env bash
# =============================================================
# build-wasm.sh — portable wrapper around cpp/Makefile
#
# Usage (from repo root, or any cwd):
#   scripts/build-wasm.sh           # release WASM → src/public/wasm/
#   scripts/build-wasm.sh --debug   # debug WASM
#   scripts/build-wasm.sh --native  # native smoke test (no Emscripten)
#
# Emscripten discovery (first match wins):
#   1. emcc already on PATH
#   2. EMSDK env var pointing at an emsdk root (sources emsdk_env.sh)
#   3. $HOME/emsdk/emsdk_env.sh if present
#
# Prebuilt artefacts live at src/public/wasm/ — Pages/deploy does not need
# this script. Prefer: npm run build:site
# Full rebuild with WASM: npm run build  (requires emcc)
# =============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="wasm"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug|-d) MODE="debug" ;;
    --native|-n) MODE="native" ;;
    --help|-h) usage 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage 1
      ;;
  esac
  shift
done

mkdir -p "$ROOT/cpp/build"

if [[ "$MODE" == "native" ]]; then
  echo "[build-wasm] Native smoke test (g++/clang, no Emscripten)"
  (cd "$ROOT/cpp" && make native)
  exit 0
fi

activate_emsdk() {
  local env_sh="$1"
  if [[ -f "$env_sh" ]]; then
    # shellcheck disable=SC1090
    source "$env_sh"
    return 0
  fi
  return 1
}

if command -v emcc >/dev/null 2>&1; then
  echo "[build-wasm] Using emcc on PATH: $(command -v emcc)"
elif [[ -n "${EMSDK:-}" ]]; then
  echo "[build-wasm] Sourcing EMSDK=$EMSDK"
  if ! activate_emsdk "${EMSDK}/emsdk_env.sh"; then
    echo "error: EMSDK is set but ${EMSDK}/emsdk_env.sh was not found" >&2
    exit 1
  fi
elif activate_emsdk "${HOME}/emsdk/emsdk_env.sh"; then
  echo "[build-wasm] Sourced \$HOME/emsdk/emsdk_env.sh"
else
  cat >&2 <<'EOF'
error: emcc not found.

Install Emscripten (https://emscripten.org/docs/getting_started/downloads.html), then either:
  • add emcc to PATH, or
  • export EMSDK=/path/to/emsdk  (this script sources $EMSDK/emsdk_env.sh)

Prebuilt WASM is already committed under src/public/wasm/.
For site deploy without rebuilding WASM use:
  npm run build:site
EOF
  exit 1
fi

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc still not on PATH after activating EMSDK" >&2
  exit 1
fi

echo "[build-wasm] emcc: $(emcc --version | head -1)"
mkdir -p "$ROOT/src/public/wasm"

case "$MODE" in
  debug)
    echo "[build-wasm] Building debug WASM (make wasm-dbg)"
    (cd "$ROOT/cpp" && make wasm-dbg)
    ;;
  *)
    echo "[build-wasm] Building release WASM (make wasm)"
    (cd "$ROOT/cpp" && make wasm)
    ;;
esac

echo "[build-wasm] Done."
