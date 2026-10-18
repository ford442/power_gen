# LabConfig — one schema for every lab knob (#224 §1)

Every URL flag, remembered preference and share-link field is one row in
[`config/lab-config.json`](../config/lab-config.json). The codegen turns that
file into:

| Output | What it is |
|--------|------------|
| `generated/lab-config.ts` | `interface LabConfig`, `LAB_CONFIG_FIELDS` (type, default, range/enum, aliases, URL aliases, storage key + codec, share/live flags), `LAB_CONFIG_DEFAULTS`, `LAB_CONFIG_SCHEMA_HASH` |
| `docs/AGENTS.md` → *Query-parameter matrix* | The table between the `lab-config:begin/end` markers |

```bash
npm run codegen:lab-config   # regenerate after editing config/lab-config.json
npm run check:lab-config     # CI: drift + raw-access gate
npm run test:lab-config      # parser, precedence, v1 mapping, #lab2= round-trip
```

## Reading config

`src/config/lab-config.ts` is the **only** module in `src/` that reads
`location.search`, `location.hash` or `localStorage` for configuration;
`check:lab-config` fails the build on raw access anywhere else (comments are
ignored; `src/config/` and `src/public/` are exempt).

```ts
import { labConfig, labConfigResolved, labConfigFor, persistLabConfig } from './config/lab-config';

labConfig().fieldCoupling;                 // typed, resolved
labConfigResolved().sources.look;          // 'url' | 'hash' | 'storage' | 'default'
labConfigFor(new URLSearchParams('fdtd=0')); // tests: that query alone over defaults
persistLabConfig('heronLayout', 'tower');  // writes the field's storage key, in its codec
```

**Precedence, for every field:** URL query > share hash (`#lab2=`, or legacy
`#lab=v1;…`) > `localStorage` > default. Window overrides set by an embedding
page (`SEG_PROTOTYPE_PRESET`, `GLTF_HOUSING`, `SEG_SSR_ENABLED`,
`SEG_LIGHTING_LOOK`, `SEG_FRAME_LEVEL`, `HERON_LAYOUT_PRESET`,
`DEBUG_RENDERER`) apply only where the resolved source is `default` — except
`DEBUG_RENDERER`, which keeps its documented place between URL and storage.

**One tolerant parser.** Booleans accept `1/0/on/off/true/false/yes/no` (any
case); enums match case-insensitively and take catalogued aliases
(`layout=godin` → `roschin`); numbers are finite-checked and clamped (`int`
fields take the whole value — `1e9`, not `parseInt`'s `1`); strings can carry
a pattern; `setpoints` clamp to each catalog setpoint's range. An unparsable
value is *absent* and falls through to the next layer — a hand-edited link can
never put NaN into a plant.

A stored value outside a field's `storage.values` allow-list is refused and
reported in `rejectedStorage` (a stored `seg-renderer=webgl2` never boots
WebGL2; the selector warns instead).

Behaviour changes from the per-module parsers this replaced:

- `?heronLayout=` now beats the remembered `heron-layout` (it used to be the
  other way round). `window.HERON_LAYOUT_PRESET` is still what the CAD prop
  reads, published by `LabSession` from the resolved value.
- `?labMode=Lab` is accepted (case-insensitive like every enum).
- `?wasmPhysics=0` now beats a stored opt-in (it used to fall through to it).
- A `?seed=` / share-link seed seeds the run without overwriting the
  remembered `seg-sim-seed`.

## Share links v2 — `#lab2=`

`src/config/share-link.ts`:

```
#lab2=z<base64url(deflate-raw(JSON))>     native CompressionStream
#lab2=j<base64url(JSON)>                  fallback where CompressionStream is missing
JSON = { "v": 2, "s": "<schema hash>", "c": { …non-default share fields… } }
```

Only fields with `"share": true` travel: seed, WASM backend, prototype, lab
mode, focused bench, layouts, look, frame, the three coupling buses, Halbach
linear, drive/field/B×, classroom, highlight, tour + step, pinned setpoints and
an experiment id. A link cannot choose the renderer or GPU flags. Defaults are
dropped, so a typical link is well under 300 characters. The schema hash is
metadata — an older link still loads field by field through the same coercion.

`#lab2=` inflates asynchronously, so `main.ts` boots through
`initLabConfig().then(bootApp)`; without a `#lab2=` hash that resolves on the
next microtask. A payload that does not decode is logged and ignored.

Legacy `#lab=v1;…` links decode in `src/config/lab-hash-v1.ts` and map onto the
same fields (`hseg` → `setpoints.halbachSegments` on the Halbach bench, `pcap`
× bank max → `setpoints.pulseCoilCharge`, `lfield` → `setpoints.lorentzField`,
`hi` → `highlight`, `step` → `tourStep`; `renderer` in a v1 hash was never
applied and still is not).

Applying is one path — `applyLabConfig(fields)` in
`src/seg-explainer/lab-url.ts` — for v1 links, v2 links, `.lab.json` files and
`window.lab.loadConfig`. Each field is idempotent (the layout that is showing
is not rebuilt); the lab-mode bundle applies first so the link's own flags win
over it.

## `.lab.json`

```json
{ "format": "seg-lab", "version": 1, "schema": "d539cbe47be9", "createdAt": "…",
  "config": { "mode": "lorentz-sled", "seed": 42, "setpoints": { "lorentzField": 0.8 } },
  "state": { "…plant snapshot (§2)…" }, "runs": [ "…RecordedRun (§4)…" ] }
```

- **Import:** drop a `*.lab.json` anywhere on the page, or
  `await window.lab.loadConfig(obj)` / `window.lab.loadFile(file)`. A bare
  config object (`{ "look": "lab" }`) works too. Live fields apply in place
  and the address bar becomes the matching `#lab2=` link (query params that
  would outrank it are removed). If a **boot-only** field differs (WASM
  backend, prototype) the page reloads through that link instead.
- **Export:** **Lab Link → Download .lab.json**, or
  `await window.lab.exportLabFile()` / `window.lab.downloadLabFile()`.

## `window.lab`

| Member | |
|--------|---|
| `config()` / `sources()` | Resolved config and where each field came from |
| `loadConfig(obj)` / `loadFile(file)` | See above; resolves `{ applied, ignored, reloading, stateRestored, runsAdded }` |
| `shareLink()` | Build, copy and return a `#lab2=` link |
| `openShareDialog()` | Link + QR code (`qrcode-generator`, lazy) + `.lab.json` download |
| `exportLabFile()` / `downloadLabFile(name?)` | `.lab.json` of the running lab |

Snapshots (§2), experiments (§3) and the analysis panel (§4) add their own
members when their chunks install.

Everything here is a simulation setup, not a measurement.
