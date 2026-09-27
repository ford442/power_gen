#!/usr/bin/env bash
# =============================================================
# native-san.sh — sim_core_test under AddressSanitizer + UBSan
#
# Usage (from repo root, or any cwd):
#   npm run wasm:native:san
#   SAN_CXX=clang++ npm run wasm:native:san   # force a compiler
#   SAN_REQUIRED=1 npm run wasm:native:san    # fail instead of skip
#
# Probes each candidate compiler by building *and running* a tiny program
# with -fsanitize=address,undefined. A distro clang without compiler-rt (or a
# gcc without libasan/libubsan) fails that probe, and the script skips with
# exit 0 so gcc-only / minimal CI images are not turned red by a missing
# runtime. When a toolchain passes, `make native-san` must be clean.
# =============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_DIR="$(mktemp -d)"
trap 'rm -rf "$PROBE_DIR"' EXIT

cat > "$PROBE_DIR/probe.cpp" <<'CPP'
#include <vector>
int main() { std::vector<int> v(4, 1); return v[3] - 1; }
CPP

candidates=()
[[ -n "${SAN_CXX:-}" ]] && candidates+=("$SAN_CXX")
candidates+=(clang++ g++ "${CXX:-c++}")

picked=""
for cxx in "${candidates[@]}"; do
  command -v "$cxx" >/dev/null 2>&1 || continue
  if "$cxx" -std=c++17 -fsanitize=address,undefined "$PROBE_DIR/probe.cpp" \
       -o "$PROBE_DIR/probe" >/dev/null 2>&1 \
     && "$PROBE_DIR/probe" >/dev/null 2>&1; then
    picked="$cxx"
    break
  fi
  echo "[native-san] $cxx: sanitizer runtimes unavailable — trying next"
done

if [[ -z "$picked" ]]; then
  echo "[native-san] No compiler with working ASan + UBSan runtimes found."
  if [[ "${SAN_REQUIRED:-0}" == "1" ]]; then
    echo "[native-san] SAN_REQUIRED=1 — failing." >&2
    exit 1
  fi
  echo "[native-san] Skipping (install clang + compiler-rt, or gcc + libasan/libubsan)."
  exit 0
fi

echo "[native-san] Using $picked"
mkdir -p "$ROOT/cpp/build"
make -C "$ROOT/cpp" native-san SAN_CXX="$picked"
