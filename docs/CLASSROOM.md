# Classroom delivery (#224 §5)

Three things a class needs that a lab bench on a projector does not: it must
**work without the school network**, it must **answer a finger** on a tablet or
touch board, and a teacher must be able to **record a clip** for students who
were not there. All three are client-side; there is still no backend (ADR-0005).

| Piece | Where | Cost to the entry bundle |
|-------|-------|--------------------------|
| Offline PWA (manifest, icons, `sw.js`, update prompt) | `src/public/manifest.webmanifest`, `src/public/icons/`, `scripts/vite-plugin-precache.mjs`, `src/classroom/sw-template.js`, `src/classroom/pwa-register.ts` | none — lazy `install` chunk |
| Touch camera | `src/camera-controller.ts` (routing), `src/camera-touch.ts` + `src/camera-gestures.ts` (lazy chunk) | a few hundred bytes of routing |
| Recording | `src/classroom/record-control.ts` (lazy `install` chunk), `src/classroom/recorder.ts` (lazy, first use), `LabAudio.createRecordingTap()` | the tap method on `LabAudio` |

`main.ts` loads `src/classroom/install.ts` with one dynamic import after boot and
calls `installClassroom({ serviceWorker, recordControl })` from the LabConfig
flags `offline` (alias `sw`) and `recordControl`, both on by default
([`LAB_CONFIG.md`](./LAB_CONFIG.md), query matrix in [`AGENTS.md`](./AGENTS.md)).

## Offline / install

**What is cached.** At build time the precache plugin walks `dist/` after Vite has
written the bundle *and* copied `src/public/`, and writes `dist/sw.js` with that
exact list: `index.html`, every hashed chunk and stylesheet (including lazy chunks
and the plant / replay / offline-WASM workers), `wasm/sim_core.{js,wasm}`, every
GLB under `assets/`, the manifest and icons — about 1.6 MB. Skipped: `sw.js`
itself, source maps, dotfiles and `*.md`. The cache name is
`seg-lab:<deploy path>:<version>`, where the version hashes every URL **and its
bytes** (`sim_core.wasm` and the GLBs keep their names across releases, so names
alone would miss a rebuilt plant).

**How it serves.**

- Precached URLs: cache-first. Anything else: the network, untouched (nothing is
  cached at runtime).
- A navigation to the deploy root or `index.html`, **with any query string**,
  gets the cached `index.html` — so `?renderer=webgl2`, `?wasmPhysics=1`,
  `#lab=…` and friends all boot offline.
- `HEAD` probes of precached files (the WASM loader checks `sim_core.wasm` this
  way) get the cached status and headers.

**Where it registers.** Only on a production build served over http(s) with
`navigator.serviceWorker` available:

| Boot | Service worker |
|------|----------------|
| `npm run dev` | never (there is no `sw.js` in dev) |
| `file://…/dist/index.html` | skipped silently — `file:` cannot register workers |
| `http://<LAN IP>/…` (plain-http classroom server) | skipped silently — not a secure context. Use https, or `localhost` |
| GitHub Pages `/power_gen/`, Contabo `/powergen/`, `vite preview` | registered |

`sw.js` is registered relative to the page (`${import.meta.env.BASE_URL}sw.js`,
which is `./sw.js` with the default relative base), so its scope is the deploy
root on any path. Two deploy paths on one origin keep separate caches.

**Install.** The manifest (`start_url` / `scope` `./`, standalone, dark theme)
links from `index.html`; icons are an SVG plus 192 / 512 px PNGs (the 512 doubles
as the maskable icon — the motif sits inside the 40 % safe circle). Chrome's
`Page.getInstallabilityErrors` reports none (checked by e2e). Regenerate icons
with `npm run generate:pwa-icons` (pure Node + `zlib`; `npm run test:classroom`
fails if the committed files drift from the generator).

**Updates never land mid-lesson.** A new deploy's `sw.js` installs in the
background, precaches into a new cache and then **waits**. The page shows a small
toast — **Update available — Reload · Later**. Only **Reload** posts
`skip-waiting`; the new worker activates, deletes the old cache, and the page
reloads onto the new version. **Later** hides the toast; the update then applies
on the next visit after every lab tab has closed (the browser default). An open
tab also checks for a new deploy hourly, but still only offers it.

**Kill switch.** `?offline=0` (`?sw=0`, i.e. `installClassroom({ serviceWorker:
false })`) skips registration and unregisters an existing worker for this deploy
path. For a broken deploy that cannot load far enough to run that, ship a
`sw.js` that calls `self.registration.unregister()`.

**Known limits.** A stale tab whose lazy chunk was deleted by a newer deploy
(another tab applied the update) can fail to load that chunk — reload it.
Storage eviction under disk pressure drops the cache like any site data; the app
then simply needs the network again.

## Touch camera

The canvas sets `touch-action: none` (CSS and inline), so the page never scrolls
or browser-zooms under a finger; every pointer is captured on `pointerdown`
(#221), so a drag that leaves the canvas still ends cleanly.

| Gesture | Camera |
|---------|--------|
| One-finger drag | Orbit — the same `orbit()` call and 0.01 rad/px as a mouse drag (see the known issue below) |
| Two-finger drag | Pan: eye and target slide together; the scene follows the fingers (one px ≈ one px of world at the target) |
| Pinch | Dolly: eye–target distance × the finger-span ratio, clamped to 0.5–150 units |
| Double-tap, overview | Focus the device whose origin is nearest the tap (within 12 % of the canvas's short side, min 40 px); empty space re-frames the overview |
| Double-tap, device view | Back to the overview |
| Mouse | Unchanged: left-drag orbit, wheel zoom, no double-click action |
| Pen | As touch |

Double-tap focus is a **screen-space centre pick** (`pickDeviceAt` in
`camera-touch.ts`): devices disabled in the overview and devices behind the eye
never match. It is not a mesh ray-cast; benches sit far enough apart in the
overview for the nearest centre to be the bench under the finger. Taps are
≤ 300 ms and ≤ 10 px; the second must follow within 350 ms and 32 px. A third
finger is ignored; lifting one of two fingers hands back to orbit without a jump.

**Known issue — pre-existing, mouse too.** `CameraController.orbit()` pivots about
the world origin rather than `camera.target`, and uses the eye's *horizontal*
radius as the sphere radius, so every drag step pulls the eye toward the origin
(from the overview pose, about six steps put it inside the bench). Touch calls
the same function so a finger and a mouse stay identical; double-tap empty space
(or a view key) re-frames. The fix — orbit about `camera.target` with the full
3-D eye–target radius — is one function, left out here because it changes mouse
behaviour.

The touch code is a lazy chunk: desktop mouse boots never fetch it; devices with
`navigator.maxTouchPoints > 0` prefetch it at boot, and any touch that arrives
first is queued and replayed. `npm run test:camera-gestures` checks the gesture
maths, pan/dolly, the pick and the router in Node; e2e drives real
`PointerEvent`s with a touch context.

## Recording

The **Video ● 10s ● 30s ● 60s** row sits above the status line in the Telemetry
Export panel (it wraps at 390 px). Press a preset to start; that button becomes
**■ Stop** and a progress bar runs; at the end (or on Stop) the clip downloads as
`seg-lab-YYYY-MM-DDTHH-MM-SS.webm` (local time; `.mp4` where WebM is missing).

```
  #gpuCanvas ──drawImage──┐
  sim clock + wall clock ─┼─ 2D composite ── captureStream(30) ─┐
  "Simulated — not metrology"                                   ├─ MediaRecorder → Blob
  LabAudio master ── createRecordingTap() ── audio track ───────┘
```

- **Burned in, every frame:** "Simulated — not metrology" and
  `sim t = <TelemetryHub sim seconds> s · <local wall time>`. A clip that leaves
  the classroom still says what it is.
- **Format:** first supported of `video/webm;codecs=vp9[,opus]`, VP8, `video/webm`,
  then `video/mp4;codecs=avc1[,mp4a.40.2]`, `video/mp4`. WebM wins where both
  exist; Safari gets MP4. Frames are the canvas backbuffer size, scaled down to
  ≤ 1920 px on the long edge, even dimensions, ~6 Mbit/s.
- **Audio:** only when lab audio is running and unmuted (`?audio=1` + a gesture).
  `LabAudio.createRecordingTap()` fans the compressor out to a
  `MediaStreamAudioDestinationNode` — the speakers get exactly what they got
  before. Muted or off → the clip has *no* audio track (not a silent one).
  Muting mid-clip silences the rest of the clip; unmuting mid-clip does not add a
  track.
- **Timing:** wall-clock seconds, not sim seconds. On a starved machine the
  encoder can still be empty at the deadline (or at Stop); the recorder then keeps
  going until the first encoded chunk arrives (at most 20 s more) rather than
  save an empty file.
- **Automation:** `await window.recordBench(seconds)` resolves the Blob without
  downloading; a second call while one runs rejects.

The recorder composites in its own `requestAnimationFrame`, registered after the
renderer's, so it reads the frame just drawn without `preserveDrawingBuffer`.
WebCodecs / muxers are out of scope.

## Tests

| Command | Covers |
|---------|--------|
| `npm run test:classroom` | Precache list + plugin, the generated worker in a sandbox (install / fetch routing / activate / skip-waiting), icons + manifest, recorder helpers, lazy-chunk structure |
| `npm run test:camera-gestures` | Gesture tracker, pan / dolly, double-tap pick, touch router, mouse path unchanged |
| `npm run test:e2e` (`e2e/classroom.spec.js`) | Touch double-tap focus ↔ overview, orbit, pinch, pan; `recordBench(2)`; Record control at 390 px + download |
| `npm run test:e2e:offline` (`e2e/offline.preview.js`, `playwright.preview.config.js`) | Against `vite preview` of a fresh build: precache = list, installability, offline reload boots WebGL2; a redeploy waits behind the toast until Reload |

Not verified here: real touch hardware, WebGPU canvas capture (the VM has no
GPU; `drawImage` of a WebGPU canvas is specified and works in Chrome), Safari's
MP4 path and iOS install.
