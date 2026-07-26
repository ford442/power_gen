# Pull Request Template

## Summary

<!-- What changed and why (1–3 bullets). -->

-

## Checklist

- [ ] No Three.js / Babylon / PlayCanvas dependency (ADR-0003)
- [ ] Docs updated if behavior or query params changed (`docs/AGENTS.md`, ADRs, topic docs)
- [ ] `npm run typecheck` passes when TS touched
- [ ] `npm run validate` / `npm run check:wgsl` when shaders or native plant touched
- [ ] E2E (`npm run test:e2e`) green for WebGL2 agent hooks when UI/bootstrap changed

## Bundle size budget (ADR-0003 / ADR-0005)

Prefer **no new runtime dependencies**. If a library is required:

| Constraint | Guidance |
|------------|----------|
| **Engine ban** | Do **not** add Three.js, Babylon, PlayCanvas, or similar |
| **glTF** | Prefer the hand-rolled loader (`src/assets/gltf/`); at most a **parser-only** package — not a scene engine |
| **CAD assets** | Lazy-load per focus; keep placeholder GLBs tiny; avoid Draco/meshopt until decode cost is measured |
| **Main chunk** | Avoid shipping large CAD or shader toolchains in the initial Vite entry |
| **PR note** | Call out any new `dependencies` / `devDependencies` and approximate gzip impact |

Approximate Pages budget (soft): keep committed `src/public/assets/seg/*.glb` placeholders under **~50 KB each** unless replacing with artist CAD intentionally.

## Test plan

- [ ] `?renderer=webgl2` — START → non-zero RPM/V/I/P
- [ ] Relevant query params exercised (list):
- [ ] WebGPU (real GPU) if post/glTF touched:
