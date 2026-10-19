# Embedding the lab · teacher console (#224 §5)

Two ways for other pages to drive a running lab, with one set of request
handlers (`src/embed/lab-requests.ts`):

| | Transport | Who can talk to the lab |
|---|---|---|
| **Embed** (`?embed=1`) | `window.postMessage` between a parent page and the lab in an `<iframe>` | The origins in `embedOrigins`, plus the lab's own origin |
| **Classroom** (`?teacher=1`) | `BroadcastChannel('seg-lab')` between tabs | Tabs of the lab on the **same origin, same browser** only |

Everything a parent or teacher receives is **simulated, not metrology**: the
numbers are simulation state, not calibrated measurements. The lab says so in
`lab:hello` (`disclaimer`) and on a badge over the canvas.

Code: `src/embed/` — `embed-protocol.ts` (pure validator, origin rules,
telemetry keys), `lab-requests.ts` (handlers), `embed-endpoint.ts`
(postMessage side), `classroom-channel.ts` (BroadcastChannel side),
`embed-host.ts` / `classroom.ts` / `teacher-console.ts` (browser wiring).
Tests: `npm run test:embed` (Node) and the embed test in `e2e/app.spec.js`.

## Embed mode

```html
<iframe
  src="https://lab.example/?renderer=webgl2&embed=1&embedOrigins=https://school.example"
  width="800" height="500" allow="fullscreen"></iframe>
```

- `?embed=1` hides the dashboard chrome (header, side panels, footer, debug
  and scientific panels, corner labels) — only the canvas and a small
  **Simulated, not metrology** badge remain. The `data-lab-embed` attribute
  goes on `<html>` before first paint (`src/config/lab-api.ts`); the CSS is in
  `src/styles/seg-overlays.css`. Keyboard shortcuts and orbit / zoom still
  work inside the frame.
- The postMessage endpoint is a lazy chunk, installed only under `embed=1`
  and only once the lab has booted. It then posts **`lab:ready`** to the
  parent, so wait for that before you send anything. Messages sent earlier
  are not queued.
- **The parent must be a secure context** (`https:`, or `http://localhost`).
  A frame inherits secure-context status from its ancestors, and the lab's
  WebGPU modules use secure-context-only globals (`GPUShaderStage`, …) even
  on the WebGL2 path. A lab framed by a plain `http://` page fails to boot.
- Local development: Chrome's Local Network Access checks block a public page
  (or one on another non-local origin) from framing a `localhost` dev server.
  Use `embed-demo.html` on the same server, or a deployed lab. The e2e test
  turns those checks off for its routed parent pages.
- `embed`, `embedOrigins` and `teacher` are URL-only LabConfig fields. They
  are never part of a `#lab2=` link or `.lab.json`, never stored, and
  `lab:loadConfig` cannot change them.

### Origin rules

- `embedOrigins` is a comma-separated list of **exact origins**,
  `scheme://host[:port]`. Each entry is normalized the way browsers serialize
  `MessageEvent.origin`: lowercase, default port dropped, an optional
  trailing `/` allowed.
- Refused, with a console warning: `*` and any wildcard (`https://*.example`),
  `null`, paths, queries, fragments, credentials, and non-http(s) schemes.
  A wildcard is never treated as "allow all".
- Matching is exact string equality against `event.origin`. So
  `https://a.example.evil`, `http://a.example` (wrong scheme),
  `https://a.example:444` and `https://sub.a.example` do **not** match
  `https://a.example`.
- The lab's own origin is always allowed (a same-origin parent, or the e2e
  harness). An opaque `null` origin (`file://`, sandboxed frame without
  `allow-same-origin`) is never allowed.
- Messages from any other origin are dropped without a reply and noted with
  `console.debug`. Non-`lab:` messages (other scripts, dev tools) are
  ignored silently.
- Every reply and telemetry push goes to `event.source` with
  **`targetOrigin = event.origin`**, never `'*'`. `lab:ready` is posted once
  per allowed origin, and the browser drops the copies whose origin does not
  match the parent.

### Messages

Requests are `{ type, requestId?, ...fields }`. `requestId` is optional: a
string of at most 128 characters or a finite number, echoed back (`null` when
it was omitted). Replies are:

```js
{ type: '<request type>:result', requestId, ok: true, ...payload }
{ type: 'lab:error', requestId, ok: false, request: '<request type>', error: '…' }
```

| Request | Fields | Reply payload (`…:result`) |
|---|---|---|
| `lab:hello` | — | `protocol: 1`, `schema` (LabConfig schema hash), `capabilities: string[]` (the request types this lab serves right now), `disclaimer` |
| `lab:ping` | — | `status: { view, labMode, renderer, experiment, simTimeS, title }` |
| `lab:loadConfig` | `config`: a `.lab.json` object or a bare config object | `result: { applied, ignored, reloading, stateRestored, runsAdded }` — `window.lab.loadConfig` ([`LAB_CONFIG.md`](./LAB_CONFIG.md)). `reloading: true` means a boot-only field changed: the frame reloads, so wait for the next `lab:ready` |
| `lab:runExperiment` | `id` (a shipped experiment id) **or** `experiment` (a definition object — [`EXPERIMENTS.md`](./EXPERIMENTS.md); a sweep lives in it); `runner?` (`'offline'` default, or `'live'`) | `run`: a `RecordedRun` (`src/analysis/run-types.ts`; a sweep's summary run), from `window.lab.runExperiment(idOrDef, { runner })`. A failed or stopped run is a `lab:error` with the reason. Without the experiments chunk: `lab:error` `'experiments unavailable'` |
| `lab:snapshot` | — | `state`: the plant snapshot from `window.lab.captureSnapshot()`. Without it: `lab:error` `'snapshots unavailable'` |
| `lab:subscribe` | `keys?: string[]` (≤ 128 telemetry keys), `hz?` | `subscription` (integer id), `keys` (or `'focus'`), `hz`, clamped to **0.2–10 Hz** (default 4) |
| `lab:unsubscribe` | `subscription?` (omitted = all of yours) | `removed`: count. Only your own window's subscriptions are affected |

Pushed by the lab, with no request:

| Message | Fields |
|---|---|
| `lab:ready` | `protocol`, `schema`, `capabilities` — after install, and again after each reload |
| `lab:telemetry` | `subscription`, `t` (**simulated seconds** on the session clock, TelemetryHub `simTimeS`), `values: { key: number }` |

**Telemetry keys.** Every `DEVICE_TELEMETRY_FIELDS` key in
`generated/device-catalog.ts` (`heronHead`, `lorentzForceN`, `transformerVs`, …),
read from the device that owns it, plus the SEG catalog keys `rpm`, `omega`,
`corona`, `voltage`, `current`, `power` and `fieldSim`. An unknown key makes
`lab:subscribe` fail. With `keys` omitted the subscription **follows focus**:
each push carries the catalog keys of the focused device, or the SEG keys in
the overview. Non-finite values are left out. Pushes are throttled per
subscription on the wall clock, at most 16 subscriptions per lab.

### Parent snippet

```js
const LAB = 'https://lab.example';                  // the lab's origin
const frame = document.querySelector('iframe');
let next = 0;
const pending = new Map();

function ask(type, fields = {}) {
  const requestId = ++next;
  frame.contentWindow.postMessage({ type, requestId, ...fields }, LAB);   // never '*'
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
}

window.addEventListener('message', (ev) => {
  if (ev.origin !== LAB || ev.source !== frame.contentWindow) return;
  const msg = ev.data;
  if (msg.type === 'lab:ready') onReady(msg);
  else if (msg.type === 'lab:telemetry') console.log(msg.t.toFixed(2), msg.values);
  else if (pending.has(msg.requestId)) {
    const p = pending.get(msg.requestId);
    pending.delete(msg.requestId);
    msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
  }
});

async function onReady() {
  const hello = await ask('lab:hello');
  console.log('lab protocol', hello.protocol, hello.capabilities);
  await ask('lab:loadConfig', { config: { mode: 'lorentz-sled', setpoints: { lorentzField: 0.6 } } });
  await ask('lab:subscribe', { keys: ['lorentzForceN', 'lorentzFieldT'], hz: 5 });
}
```

The working demo is `src/public/embed-demo.html`, served at
`/embed-demo.html` in dev and on Pages. It embeds `../?renderer=webgl2&embed=1`
with its own origin as `embedOrigins`. Use it with **Hello**, **Load config**,
**Subscribe** and **Snapshot**.

## Teacher console (classroom)

- Open it with **`?teacher=1`**, or call `window.lab.openTeacherConsole()` on
  any lab tab. It is a lazy panel.
- Every tab of the lab is a student: after boot it listens on
  `BroadcastChannel('seg-lab')` (lazy chunk `classroom.ts`, started from
  `src/config/lab-post-boot.ts`).
- The console broadcasts:
  - `lab:ping` every 4 s;
  - `lab:loadConfig`, either **Send this lab** (its own `.lab.json` without
    runs) or **Send .lab.json…**;
  - `lab:runExperiment` by id.

  Ticking roster rows narrows a send to those students.
- Students answer through the same handlers as an embedded lab (`lab:hello`,
  `lab:ping`, `lab:loadConfig` and `lab:runExperiment` only). The ping reply's
  `status` gives the roster its **view** (focus) and **lab mode**. A student
  shows what the teacher did in its status line. Students announce
  themselves on join and send `lab:bye` on `pagehide`. One silent for 30 s
  drops off the roster.
- Runs from `lab:runExperiment` are collected in the console. **Download
  runs** saves them as `seg-class-runs.json`. **Open in analysis** passes
  them to `window.lab.importRuns`, if the analysis panel is installed.

Channel messages carry `from` (the sender's random tab id) and, from the
teacher, an optional `to: string[]` of student ids. Student replies are
addressed `to: [teacherId]`, and a tab ignores messages from its own id, so
the teacher's own tab never obeys its own broadcast.

**Same-origin only.** A BroadcastChannel never crosses origins or browsers.
The console reaches the tabs of this lab on this origin in this browser
profile, such as a demo machine with several windows or a kiosk. It is not a
network classroom: there is no server, and nothing leaves the browser. Any
same-origin tab could already script the lab, so the channel adds no new
trust. Note that `lab:loadConfig` with a boot-only change reloads the student
tab.
