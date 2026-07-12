#!/usr/bin/env bash
# =============================================================
# check-wgsl.sh — validate WGSL with naga (standalone + generators)
#
# Usage:
#   scripts/check-wgsl.sh              # skip if naga missing (exit 0)
#   REQUIRE_NAGA=1 scripts/check-wgsl.sh  # fail if naga missing
#
# Install naga:
#   cargo install naga-cli --version 0.19.0 --locked
#
# Pipeline:
#   1. node scripts/extract-wgsl.mjs  → build/wgsl-check/*.wgsl
#      (expands #include, extracts generator templates with entry points)
#   2. naga each extracted module
#
# Known Tint-only / WIP modules can be allowlisted below until fixed.
# See docs/SHADERS.md for naga vs Chrome differences.
# =============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/build/wgsl-check"

# Basenames (under build/wgsl-check) or original ids that currently fail naga
# but compile under Tint. Prefer fixing over growing this list.
KNOWN_NAGA_FAILURES=(
  # LED/solar suite uses reserved keyword `active` and multi-file concat layout
  "led-solar-compute.wgsl"
  "led-solar-render.wgsl"
)

if ! command -v naga >/dev/null 2>&1; then
  if [[ "${REQUIRE_NAGA:-}" == "1" ]]; then
    echo "error: naga not found (REQUIRED). Install: cargo install naga-cli --version 0.19.0 --locked" >&2
    exit 1
  fi
  echo "[check-wgsl] naga not found — skipping WGSL validation"
  echo "            install: cargo install naga-cli --version 0.19.0 --locked"
  exit 0
fi

echo "[check-wgsl] naga: $(naga --version 2>/dev/null || echo present)"

echo "[check-wgsl] extracting / expanding shaders…"
node "$ROOT/scripts/extract-wgsl.mjs"

is_known_failure() {
  local base="$1"
  local k
  for k in "${KNOWN_NAGA_FAILURES[@]}"; do
    [[ "$base" == "$k" || "$base" == *"$k"* ]] && return 0
  done
  return 1
}

checked=0
passed=0
skipped_known=0
failed=0

shopt -s nullglob
for f in "$OUT_DIR"/*.wgsl; do
  base="$(basename "$f")"
  # Skip empty placeholders
  if [[ ! -s "$f" ]]; then
    continue
  fi
  if ! grep -Eq '@(vertex|fragment|compute)' "$f"; then
    continue
  fi

  checked=$((checked + 1))
  if naga "$f" >/tmp/naga-check.out 2>&1; then
    echo "  ok: $base"
    passed=$((passed + 1))
  else
    if is_known_failure "$base"; then
      echo "  warn (known naga fail): $base"
      skipped_known=$((skipped_known + 1))
    else
      echo "  FAIL: $base"
      sed -n '1,12p' /tmp/naga-check.out | sed 's/^/    /'
      failed=$((failed + 1))
    fi
  fi
done

echo "[check-wgsl] checked=$checked passed=$passed known_fail=$skipped_known unexpected_fail=$failed"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi

# Hard gate: particle compute (shared structs) must always be present and pass
if [[ ! -f "$OUT_DIR/passes_particle-compute.wgsl" ]] && [[ ! -f "$OUT_DIR/passes_particle-compute.wgsl.wgsl" ]]; then
  # extract names: passes/particle-compute.wgsl → passes_particle-compute.wgsl
  pc=$(ls "$OUT_DIR"/*particle-compute* 2>/dev/null | head -1 || true)
  if [[ -z "${pc:-}" ]]; then
    echo "error: particle-compute module missing from extract output" >&2
    exit 1
  fi
fi

exit 0
