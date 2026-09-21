# Quanta bench CAD placeholders (transformer core, VDG terminal, Thomson stand)

Procedural geometry generated for the hybrid glTF + procedural pipeline:

| Asset | Bench | Command |
|-------|-------|---------|
| `transformer-core.glb` | `transformer` | `npm run generate:transformer-core-glb` |
| `vdg-terminal.glb` | `vdg` | `npm run generate:vdg-terminal-glb` |
| `thomson-stand.glb` | `jumping-ring` | `npm run generate:thomson-stand-glb` |

All three: `npm run generate:quanta-gltf`

- **License:** MIT (same as the power_gen repository)
- **Authoring:** parametric primitives in `scripts/generate-*-glb.mjs` — replace
  with artist-authored glTF/GLB exported from Blender/Fusion when available.
- **Anchors / roles:** `extras.power_gen` on glTF nodes (see `docs/GLTF_ASSETS.md`)
- **KTX2:** none of these embed a compressed albedo; they are untextured
  primitives shaded by the registry's material override.

No third-party mesh data is bundled beyond these repo-generated assets.
