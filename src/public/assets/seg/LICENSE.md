# SEG CAD placeholders (housing, coil former, stand, base plate)

Procedural geometry generated for the hybrid glTF + procedural pipeline:

| Asset | Command |
|-------|---------|
| `housing-shell.glb` | `npm run generate:housing-glb` |
| `coil-former.glb` | `npm run generate:coil-former-glb` |
| `stand.glb` | `npm run generate:stand-glb` |
| `base-plate.glb` | `npm run generate:base-plate-glb` |

All four: `npm run generate:seg-gltf`

- **License:** MIT (same as the power_gen repository)
- **Authoring:** parametric primitives in `scripts/generate-seg-*-glb.mjs` — replace
  with artist-authored glTF/GLB exported from Blender/Fusion when available.
- **Anchors / roles:** `extras.power_gen` on glTF nodes (see `docs/GLTF_ASSETS.md`)
- **KTX2:** `stand.glb` embeds tiny GPU-native 4×4 albedo KTX2 (RGBA + BC1 + ETC2 + ASTC).
  No third-party mesh or Basis/UASTC payload.

No third-party mesh data is bundled beyond these repo-generated assets.
