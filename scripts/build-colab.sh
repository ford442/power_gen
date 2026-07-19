#!/usr/bin/env bash
# Colab site build: optional WASM rebuild via shared /content/build_space/emsdk,
# then Vite → dist/. Prebuilt WASM in src/public/wasm/ is used when EMSDK is absent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COLAB_EMSDK="/content/build_space/emsdk"

if [[ -f "${COLAB_EMSDK}/emsdk_env.sh" ]]; then
  export EMSDK="${COLAB_EMSDK}"
  echo "[build-colab] Rebuilding WASM with Colab EMSDK at ${EMSDK}"
  npm run wasm:build
else
  echo "[build-colab] No Colab EMSDK at ${COLAB_EMSDK} — using prebuilt WASM in src/public/wasm/"
fi

npm run build:site
