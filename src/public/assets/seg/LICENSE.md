# SEG housing shell & coil former

Procedural geometry generated for the hybrid glTF + procedural pipeline:

| Asset | Command |
|-------|---------|
| `housing-shell.glb` | `npm run generate:housing-glb` |
| `coil-former.glb` | `npm run generate:coil-former-glb` |

Both: `npm run generate:seg-gltf`

- **License:** MIT (same as the power_gen repository)
- **Authoring:** parametric primitives in `scripts/generate-seg-*-glb.mjs` — replace
  with artist-authored glTF/GLB exported from Blender/Fusion when available.
- **Anchors / roles:** `extras.power_gen` on glTF nodes (see `docs/GLTF_ASSETS.md`)

No third-party mesh data is bundled beyond these repo-generated assets.
