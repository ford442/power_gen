#!/usr/bin/env bash
# =============================================================
# check-wgsl.sh — validate standalone WGSL modules with naga
#
# Usage:
#   scripts/check-wgsl.sh              # skip if naga missing (exit 0)
#   REQUIRE_NAGA=1 scripts/check-wgsl.sh  # fail if naga missing
#
# Install naga:
#   cargo install naga-cli --version 0.19.0 --locked
#
# Notes:
#   • Only files with @vertex / @fragment / @compute entry points are checked
#     (include fragments like *constants.wgsl / *structs.wgsl are skipped).
#   • naga is stricter than Chrome Tint in places; known Tint-only modules
#     can be listed below until fixed.
#   • Inline generators under src/shaders/generators/ are not extracted here;
#     prefer keeping critical shaders as .wgsl files for offline validation.
# =============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHADER_DIR="$ROOT/src/shaders"

# Basenames that currently fail naga but compile under Tint (tracked debt).
# Remove entries as they are fixed.
KNOWN_NAGA_FAILURES=(
  "led-solar-compute.wgsl"  # reserved keyword `active`
  "led-solar-render.wgsl"   # depends on include fragments / irradiance_buffer
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

is_known_failure() {
  local base="$1"
  local k
  for k in "${KNOWN_NAGA_FAILURES[@]}"; do
    [[ "$k" == "$base" ]] && return 0
  done
  return 1
}

checked=0
passed=0
skipped_include=0
skipped_known=0
failed=0

shopt -s nullglob
for f in "$SHADER_DIR"/*.wgsl; do
  base="$(basename "$f")"
  if ! grep -Eq '@(vertex|fragment|compute)' "$f"; then
    echo "  skip (include/fragment): $base"
    skipped_include=$((skipped_include + 1))
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
      sed -n '1,8p' /tmp/naga-check.out | sed 's/^/    /'
      failed=$((failed + 1))
    fi
  fi
done

echo "[check-wgsl] checked=$checked passed=$passed known_fail=$skipped_known includes=$skipped_include unexpected_fail=$failed"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
exit 0
