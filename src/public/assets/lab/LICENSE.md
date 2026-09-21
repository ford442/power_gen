# Lab bench CAD placeholders (Heron vessels, Kelvin jars)

Procedural geometry generated for the hybrid glTF + procedural pipeline. These
are the benches that live outside `src/devices/quanta/`, hence the separate
directory.

| Asset | Bench | Command |
|-------|-------|---------|
| `heron-vessels.glb` | `heron` (`heronLayout=classic` only) | `npm run generate:heron-vessels-glb` |
| `kelvin-jars.glb` | `kelvin` | `npm run generate:kelvin-jars-glb` |

Both: `npm run generate:lab-gltf`

- **License:** MIT (same as the power_gen repository)
- **Authoring:** parametric primitives in `scripts/generate-*-glb.mjs` — replace
  with artist-authored glTF/GLB exported from Blender/Fusion when available.
- **Anchors / roles:** `extras.power_gen` on glTF nodes (see `docs/GLTF_ASSETS.md`)
- **Units:** device-local *render* units, not metres — see the per-bench note in
  `docs/GLTF_ASSETS.md`.
- **KTX2:** neither embeds a compressed albedo; both are untextured primitives
  shaded by the registry's material override.

No third-party mesh data is bundled beyond these repo-generated assets.
