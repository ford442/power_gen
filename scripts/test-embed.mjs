#!/usr/bin/env node
/**
 * test-embed.mjs — the embed / classroom protocol (#224 §5).
 *
 *   1. Origins: exact `scheme://host[:port]` entries only — `*`, wildcards,
 *      `null`, paths, credentials and non-http(s) schemes are refused;
 *      lookalikes (`https://a.example.evil`, `http://` vs `https://`, another
 *      port) never match; the page's own origin is always allowed.
 *   2. Validator: request shapes, requestId rules, unknown keys / types,
 *      non-`lab:` traffic ignored, hz clamped to ≤ 10.
 *   3. Handlers: hello / ping / loadConfig / runExperiment / snapshot against a
 *      fake host, including "experiments unavailable".
 *   4. postMessage endpoint: disallowed origins get nothing, every reply goes
 *      to `event.source` with `targetOrigin = event.origin` (never `*`),
 *      telemetry is throttled, filtered to catalog keys and stamped with sim
 *      time, unsubscribe stops it.
 *   5. BroadcastChannel routing (Node's own BroadcastChannel): a teacher's
 *      broadcast reaches every student, `to` narrows it, a tab ignores its own
 *      messages, replies come back to the teacher only, and the roster /
 *      collected runs follow.
 *
 * Usage: node scripts/test-embed.mjs   (exit 1 on failure)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function importTsEntry(contents) {
  const result = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'embed-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent'
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail = '') {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

const m = await importTsEntry(`
export * from './src/embed/embed-protocol.ts';
export { handleLabRequest, hostCapabilities } from './src/embed/lab-requests.ts';
export { createEmbedEndpoint, MAX_SUBSCRIPTIONS } from './src/embed/embed-endpoint.ts';
export { createStudentEndpoint, createTeacherClient } from './src/embed/classroom-channel.ts';
export { DEVICE_TELEMETRY_FIELDS } from './generated/device-catalog.ts';
export { LAB_CONFIG_FIELDS } from './generated/lab-config.ts';
`);

// ── 1. Origins ─────────────────────────────────────────────────────────────
{
  const good = [
    ['https://a.example', 'https://a.example'],
    ['HTTPS://A.Example', 'https://a.example'],
    ['https://a.example/', 'https://a.example'],
    ['https://a.example:443', 'https://a.example'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['  https://school.example:8443  ', 'https://school.example:8443']
  ];
  for (const [raw, want] of good) {
    check(`origin ${JSON.stringify(raw)} → ${want}`, m.parseOrigin(raw) === want, String(m.parseOrigin(raw)));
  }
  const bad = ['*', ' * ', 'https://*.example', 'https://*', 'null', 'NULL', '', 'a.example',
    'https://a.example/path', 'https://a.example?x=1', 'https://a.example#h', 'https://user:pw@a.example',
    'https://user@a.example', 'file:///tmp', 'ftp://a.example', 'javascript:alert(1)', 'data:text/html,x',
    'https://', 'https:a.example', '//a.example', 42, null, undefined];
  for (const raw of bad) check(`origin ${JSON.stringify(raw)} refused`, m.parseOrigin(raw) === null, String(m.parseOrigin(raw)));

  const list = m.buildAllowlist(['https://a.example', '*', 'https://b.example:8443', 'https://*.c.example'], 'http://localhost:5741');
  check('allowlist keeps exact origins + own origin',
    JSON.stringify([...list.allowed].sort()) === JSON.stringify(['http://localhost:5741', 'https://a.example', 'https://b.example:8443']),
    JSON.stringify([...list.allowed]));
  check('allowlist reports refused entries', JSON.stringify(list.refused) === JSON.stringify(['*', 'https://*.c.example']), JSON.stringify(list.refused));
  const lookalikes = ['https://a.example.evil', 'https://evil-a.example', 'http://a.example', 'https://a.example:444',
    'https://b.example', 'https://sub.a.example', 'https://a.exampl', 'null', '*', '', undefined];
  for (const o of lookalikes) check(`lookalike ${JSON.stringify(o)} not allowed`, !m.isAllowedOrigin(list, o));
  check('exact origin allowed', m.isAllowedOrigin(list, 'https://a.example'));
  check('own origin allowed', m.isAllowedOrigin(list, 'http://localhost:5741'));
  const opaque = m.buildAllowlist([], 'null');
  check('opaque own origin (file://) is not added', opaque.allowed.size === 0);

  const spec = m.LAB_CONFIG_FIELDS.find((f) => f.key === 'embedOrigins');
  check('LabConfig embedOrigins is a URL-only list (never shared, never stored)',
    spec && spec.type === 'list' && !spec.share && !spec.storage, JSON.stringify(spec));
  const teacher = m.LAB_CONFIG_FIELDS.find((f) => f.key === 'teacher');
  check('LabConfig teacher is a URL-only bool', teacher && teacher.type === 'bool' && !teacher.share && !teacher.storage, JSON.stringify(teacher));
}

// ── 2. Validator ───────────────────────────────────────────────────────────
{
  const p = (d) => m.parseLabRequest(d);
  check('non-lab traffic ignored', p({ type: 'webpackOk' }) === null && p('lab:hello') === null && p(null) === null
    && p([{ type: 'lab:hello' }]) === null && p({ type: 42 }) === null);
  check('replies / telemetry / ready are not requests',
    ['lab:hello:result', 'lab:error', 'lab:telemetry', 'lab:ready', 'lab:bye'].every((type) => p({ type }) === null));
  const hello = p({ type: 'lab:hello', requestId: 'h1' });
  check('hello parses', hello?.ok && hello.request.type === 'lab:hello' && hello.request.requestId === 'h1', JSON.stringify(hello));
  check('missing requestId → null', p({ type: 'lab:ping' })?.request?.requestId === null);
  const badId = p({ type: 'lab:ping', requestId: { x: 1 } });
  check('object requestId → lab:error', badId && !badId.ok && badId.reply.type === 'lab:error' && badId.reply.requestId === null, JSON.stringify(badId));
  check('long requestId refused', p({ type: 'lab:ping', requestId: 'x'.repeat(129) })?.ok === false);
  const unknown = p({ type: 'lab:selfDestruct', requestId: 7 });
  check('unknown lab: type → lab:error with requestId', unknown && !unknown.ok && unknown.reply.requestId === 7
    && unknown.reply.request === 'lab:selfDestruct' && unknown.reply.ok === false, JSON.stringify(unknown));
  check('loadConfig needs an object', p({ type: 'lab:loadConfig', config: [1] })?.ok === false
    && p({ type: 'lab:loadConfig', config: 'look=lab' })?.ok === false
    && p({ type: 'lab:loadConfig', config: { look: 'lab' } })?.ok === true);
  const runId = p({ type: 'lab:runExperiment', id: 'faraday-law', requestId: 'r' });
  check('runExperiment by id', runId?.ok && runId.request.experiment === 'faraday-law' && !('sweep' in runId.request), JSON.stringify(runId));
  const runDef = p({ type: 'lab:runExperiment', experiment: { id: 'x', steps: [] }, sweep: true });
  check('runExperiment by definition + sweep', runDef?.ok && typeof runDef.request.experiment === 'object' && runDef.request.sweep === true);
  check('runExperiment bad id refused', p({ type: 'lab:runExperiment', id: '../../etc' })?.ok === false
    && p({ type: 'lab:runExperiment' })?.ok === false
    && p({ type: 'lab:runExperiment', id: 'ok', sweep: 'yes' })?.ok === false);

  const key = m.DEVICE_TELEMETRY_FIELDS[0].key;
  const sub = p({ type: 'lab:subscribe', keys: [key, key, 'rpm'], hz: 60 });
  check('subscribe: hz 60 clamps to 10, keys deduped', sub?.ok && sub.request.hz === 10
    && JSON.stringify(sub.request.keys) === JSON.stringify([key, 'rpm']), JSON.stringify(sub));
  check('subscribe: unknown key refused', p({ type: 'lab:subscribe', keys: ['segOmega', 'document.cookie'] })?.ok === false);
  check('subscribe: keys omitted → follow focus', p({ type: 'lab:subscribe' })?.request?.keys === null);
  check('subscribe: too many keys refused', p({ type: 'lab:subscribe', keys: Array(200).fill('rpm') })?.ok === false);
  check('unsubscribe: integer or none', p({ type: 'lab:unsubscribe', subscription: 3 })?.request?.subscription === 3
    && p({ type: 'lab:unsubscribe' })?.request?.subscription === null
    && p({ type: 'lab:unsubscribe', subscription: 'all' })?.ok === false);

  const hz = [[undefined, m.TELEMETRY_HZ_DEFAULT], [0, m.TELEMETRY_HZ_DEFAULT], [-5, m.TELEMETRY_HZ_DEFAULT],
    [NaN, m.TELEMETRY_HZ_DEFAULT], [Infinity, m.TELEMETRY_HZ_DEFAULT], ['abc', m.TELEMETRY_HZ_DEFAULT],
    [1000, 10], [10, 10], [10.0001, 10], ['30', 10], [2, 2], [0.01, m.TELEMETRY_HZ_MIN]];
  for (const [raw, want] of hz) check(`clampHz(${String(raw)}) = ${want}`, m.clampHz(raw) === want, String(m.clampHz(raw)));
  check('TELEMETRY_HZ_MAX is 10', m.TELEMETRY_HZ_MAX === 10);

  check('every DEVICE_TELEMETRY_FIELDS key is a telemetry key', m.DEVICE_TELEMETRY_FIELDS.every((f) => m.isTelemetryKey(f.key)));
  check('focus keys of overview → SEG keys', JSON.stringify(m.focusTelemetryKeys('overview')) === JSON.stringify(['rpm', 'omega', 'corona', 'voltage', 'current', 'power', 'fieldSim']));
  const heronKeys = m.focusTelemetryKeys('heron');
  check('focus keys of heron = its catalog keys', heronKeys.length > 0 && heronKeys.every((k) => k.startsWith('heron')), JSON.stringify(heronKeys));
  const picked = m.pickTelemetry({
    simTimeS: 1.5,
    seg: { rpmDisplay: 1200, voltage: 3.5, power: Number.NaN },
    devices: { heron: { heronHead: 0.42, kelvinV: 999 }, kelvin: { kelvinV: 12000 } }
  }, ['rpm', 'voltage', 'power', 'heronHead', 'kelvinV', 'mhdVoltage']);
  check('pickTelemetry reads seg + owning device, drops NaN / missing',
    JSON.stringify(picked) === JSON.stringify({ rpm: 1200, voltage: 3.5, heronHead: 0.42, kelvinV: 12000 }), JSON.stringify(picked));
}

// ── 3. Handlers ────────────────────────────────────────────────────────────
function fakeHost(extra = {}) {
  const calls = [];
  return {
    calls,
    host: {
      schema: 'abc123',
      async loadConfig(config) {
        calls.push(['loadConfig', config]);
        return { applied: Object.keys(config), ignored: [], reloading: false, stateRestored: false, runsAdded: 0 };
      },
      status: () => ({ view: 'heron', labMode: 'lab', renderer: 'webgl2', experiment: null, simTimeS: 3, title: 'Lab' }),
      ...extra
    }
  };
}

{
  const { host } = fakeHost();
  const hello = await m.handleLabRequest({ type: 'lab:hello', requestId: 1 }, host);
  check('hello reply shape', hello.type === 'lab:hello:result' && hello.ok === true && hello.requestId === 1
    && hello.protocol === 1 && hello.schema === 'abc123' && hello.disclaimer === 'Simulated, not metrology'
    && hello.capabilities.includes('lab:loadConfig') && !hello.capabilities.includes('lab:runExperiment')
    && !hello.capabilities.includes('lab:snapshot') && hello.capabilities.includes('lab:subscribe'), JSON.stringify(hello));
  const noExp = await m.handleLabRequest({ type: 'lab:runExperiment', requestId: 'r', experiment: 'x' }, host);
  check('runExperiment without the §3 hook → experiments unavailable',
    noExp.type === 'lab:error' && noExp.ok === false && noExp.error === 'experiments unavailable' && noExp.requestId === 'r'
    && noExp.request === 'lab:runExperiment', JSON.stringify(noExp));
  const noSnap = await m.handleLabRequest({ type: 'lab:snapshot', requestId: 's' }, host);
  check('snapshot without the §2 hook → lab:error', noSnap.type === 'lab:error' && /unavailable/.test(noSnap.error));
  const ping = await m.handleLabRequest({ type: 'lab:ping', requestId: null }, host);
  check('ping returns status', ping.type === 'lab:ping:result' && ping.status.view === 'heron');
  const load = await m.handleLabRequest({ type: 'lab:loadConfig', requestId: 'l', config: { look: 'lab' } }, host);
  check('loadConfig returns the load result', load.ok && JSON.stringify(load.result.applied) === '["look"]', JSON.stringify(load));

  const runs = [];
  const { host: full } = fakeHost({
    async runExperiment(exp, opts) { runs.push([exp, opts]); return { id: 'run-1', rows: [[0, 1]], columns: ['t', 'x'], fn: () => 1 }; },
    captureSnapshot: () => ({ plant: 'seg', state: new Float32Array([1, 2]) })
  });
  const run = await m.handleLabRequest({ type: 'lab:runExperiment', requestId: 2, experiment: 'faraday-law', sweep: { 'lorentz-sled.lorentzField': 0.3 } }, full);
  check('runExperiment calls window.lab.runExperiment(idOrDef, { sweep })',
    run.ok && run.run.id === 'run-1' && !('fn' in run.run) && runs[0][0] === 'faraday-law'
    && runs[0][1].sweep['lorentz-sled.lorentzField'] === 0.3, JSON.stringify([run, runs]));
  const snap = await m.handleLabRequest({ type: 'lab:snapshot', requestId: 3 }, full);
  check('snapshot keeps typed arrays (structured clone)', snap.ok && snap.state.state instanceof Float32Array);
  const caps = m.hostCapabilities(full, 'channel');
  check('channel capabilities exclude subscribe / snapshot', caps.includes('lab:runExperiment') && !caps.includes('lab:subscribe') && !caps.includes('lab:snapshot'), JSON.stringify(caps));
  const { host: throwing } = fakeHost({ loadConfig: async () => { throw new Error('boom'); } });
  const err = await m.handleLabRequest({ type: 'lab:loadConfig', requestId: 9, config: {} }, throwing);
  check('handler exception → lab:error', err.type === 'lab:error' && err.error === 'boom' && err.requestId === 9);
}

// ── 4. postMessage endpoint ────────────────────────────────────────────────
class FakeSource {
  constructor() { this.posts = []; }
  postMessage(msg, targetOrigin) { this.posts.push({ msg, targetOrigin }); }
}

class FakeHub {
  constructor() { this.fns = new Set(); }
  subscribe(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  publish(snap) { for (const fn of [...this.fns]) fn(snap); }
}

{
  const allowlist = m.buildAllowlist(['https://school.example'], 'http://localhost:5741');
  const hub = new FakeHub();
  let clock = 0;
  const debugs = [];
  const { host, calls } = fakeHost();
  const ep = m.createEmbedEndpoint({ allowlist, host, hub, now: () => clock, debug: (s) => debugs.push(s) });

  const evil = new FakeSource();
  for (const origin of ['https://school.example.evil', 'http://school.example', 'null', 'https://evil.example']) {
    await ep.onMessage({ origin, source: evil, data: { type: 'lab:hello', requestId: 1 } });
    await ep.onMessage({ origin, source: evil, data: { type: 'lab:loadConfig', requestId: 2, config: { look: 'lab' } } });
  }
  check('disallowed origins get nothing', evil.posts.length === 0 && calls.length === 0, JSON.stringify(evil.posts));
  check('disallowed lab: messages are noted with console.debug', debugs.length === 8 && /not in embedOrigins/.test(debugs[0]), JSON.stringify(debugs));

  const parent = new FakeSource();
  await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:hello', requestId: 'h' } });
  await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:loadConfig', requestId: 'c', config: { look: 'lab' } } });
  await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:subscribe', requestId: 'bad', keys: ['nope'] } });
  await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'somethingElse' } });
  check('allowed origin: hello + loadConfig + error replied (non-lab ignored)', parent.posts.length === 3,
    JSON.stringify(parent.posts.map((p) => p.msg.type)));
  check('every reply targets event.origin, never *', parent.posts.every((p) => p.targetOrigin === 'https://school.example'));
  check('hello / loadConfig / error reply types', parent.posts[0].msg.type === 'lab:hello:result'
    && parent.posts[1].msg.type === 'lab:loadConfig:result' && parent.posts[1].msg.requestId === 'c'
    && parent.posts[2].msg.type === 'lab:error' && parent.posts[2].msg.requestId === 'bad', JSON.stringify(parent.posts.map((p) => p.msg)));
  check('loadConfig reached window.lab.loadConfig', calls.length === 1 && calls[0][1].look === 'lab');

  const self = new FakeSource();
  await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:ping', requestId: 1 } });
  check('own origin answered at its own origin', self.posts.length === 1 && self.posts[0].targetOrigin === 'http://localhost:5741');
  await ep.onMessage({ origin: 'https://school.example', source: null, data: { type: 'lab:hello' } });
  check('no source → no reply, no throw', true);

  // Telemetry: 60 frames at 60 Hz wall clock with hz 60 (→ 10) ⇒ ~10 pushes.
  parent.posts.length = 0;
  const heronKey = 'heronHead';
  await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:subscribe', requestId: 's', keys: ['rpm', heronKey], hz: 60 } });
  const subReply = parent.posts.shift().msg;
  check('subscribe reply: id, clamped hz', subReply.type === 'lab:subscribe:result' && subReply.hz === 10 && Number.isInteger(subReply.subscription), JSON.stringify(subReply));
  for (let i = 0; i < 60; i++) {
    clock = i * (1000 / 60);
    hub.publish({ simTimeS: i * 0.01, view: 'heron', seg: { rpmDisplay: 100 + i }, devices: { heron: { heronHead: 0.5, secret: 1 } } });
  }
  const tel = parent.posts.map((p) => p.msg);
  check('telemetry ≤ 10 Hz (10 pushes in 1 s)', tel.length === 10, String(tel.length));
  check('telemetry shape: subscription, sim t, filtered values', tel.every((t) => t.type === 'lab:telemetry' && t.subscription === subReply.subscription
    && typeof t.t === 'number' && JSON.stringify(Object.keys(t.values)) === JSON.stringify(['rpm', heronKey])), JSON.stringify(tel[0]));
  check('telemetry t is sim time, not wall time', tel[1].t === 0.06 && tel[0].t === 0, JSON.stringify(tel.slice(0, 2).map((t) => t.t)));
  check('telemetry posts target event.origin', parent.posts.every((p) => p.targetOrigin === 'https://school.example'));

  // Follow-focus subscription from the own origin at 2 Hz.
  await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:subscribe', requestId: 'f', hz: 2 } });
  self.posts.length = 0;
  parent.posts.length = 0;
  for (let i = 0; i < 60; i++) {
    clock = 1000 + i * (1000 / 60);
    hub.publish({ simTimeS: 1 + i * 0.01, view: 'overview', seg: { rpmDisplay: 5, voltage: 1 }, devices: {} });
  }
  check('2 Hz follow-focus subscription: 2 pushes / s with SEG keys', self.posts.length === 2
    && JSON.stringify(Object.keys(self.posts[0].msg.values)) === JSON.stringify(['rpm', 'voltage']), JSON.stringify(self.posts.map((p) => p.msg)));
  check('subscriptions are independent', parent.posts.length === 10, String(parent.posts.length));

  // Another caller cannot cancel the parent's subscription.
  await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:unsubscribe', requestId: 'u', subscription: subReply.subscription } });
  check('unsubscribe of someone else\'s subscription removes nothing', self.posts.pop().msg.removed === 0 && ep.subscriptionCount() === 2);
  await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:unsubscribe', requestId: 'u' } });
  await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:unsubscribe', requestId: 'u2' } });
  check('unsubscribe stops telemetry and releases the hub', ep.subscriptionCount() === 0 && hub.fns.size === 0, `${ep.subscriptionCount()} subs, ${hub.fns.size} hub fns`);

  // A reply that cannot be cloned still answers.
  const picky = { posts: [], postMessage(msg, origin) { if (msg.state && msg.state.fn) throw new Error('DataCloneError'); this.posts.push({ msg, origin }); } };
  const { host: badSnap } = fakeHost({ captureSnapshot: () => ({ fn: () => 1 }) });
  const ep2 = m.createEmbedEndpoint({ allowlist, host: badSnap, hub, now: () => 0, debug: () => {} });
  await ep2.onMessage({ origin: 'https://school.example', source: picky, data: { type: 'lab:snapshot', requestId: 'x' } });
  check('uncloneable reply → lab:error to the same origin', picky.posts.length === 1 && picky.posts[0].msg.type === 'lab:error'
    && picky.posts[0].msg.requestId === 'x' && picky.posts[0].origin === 'https://school.example', JSON.stringify(picky.posts));
  ep.dispose();
  ep2.dispose();
}

// ── 5. BroadcastChannel routing ────────────────────────────────────────────
if (typeof BroadcastChannel !== 'function') {
  failures.push('BroadcastChannel missing in this Node (need ≥ 18)');
} else {
  const NAME = `${m.LAB_CHANNEL_NAME}-test-${process.pid}`;
  const channels = [];
  const open = () => { const c = new BroadcastChannel(NAME); channels.push(c); return c; };
  const settle = () => new Promise((r) => setTimeout(r, 60));

  const students = ['s-a', 's-b', 's-c'].map((id) => {
    const handled = [];
    const runs = [];
    const { host, calls } = fakeHost({
      async runExperiment(exp) { runs.push(exp); return { id: `run-${id}`, title: 'Faraday', rows: [[0], [1]], columns: ['t'], expects: [{ pass: true }] }; },
      status: () => ({ view: id === 's-a' ? 'seg' : 'heron', labMode: 'lab', renderer: 'webgl2', experiment: null, simTimeS: 0, title: id })
    });
    const ep = m.createStudentEndpoint({ channel: open(), tabId: id, host, onHandled: (req) => handled.push(req.type) });
    return { id, ep, calls, runs, handled };
  });
  // The teacher shares its tab id with a student endpoint in the same tab.
  const teacherTabStudent = fakeHost();
  m.createStudentEndpoint({ channel: open(), tabId: 'teach', host: teacherTabStudent.host });
  let changes = 0;
  const teacher = m.createTeacherClient({ channel: open(), tabId: 'teach', onChange: () => changes++ });
  const eavesdrop = [];
  open().addEventListener('message', (ev) => eavesdrop.push(ev.data));

  teacher.ping();
  await settle();
  const roster = teacher.roster();
  check('ping → roster of every student (not the teacher\'s own tab)',
    JSON.stringify(roster.map((r) => r.id)) === JSON.stringify(['s-a', 's-b', 's-c']), JSON.stringify(roster.map((r) => r.id)));
  check('roster carries focus / mode', roster[0].status.view === 'seg' && roster[1].status.view === 'heron' && roster[0].status.labMode === 'lab');
  check('student replies are addressed to the teacher only',
    eavesdrop.filter((d) => d.type === 'lab:ping:result').every((d) => JSON.stringify(d.to) === '["teach"]' && d.requestId?.startsWith('teach:')));

  teacher.send('lab:loadConfig', { config: { look: 'lab' } });
  await settle();
  check('broadcast loadConfig reaches every student', students.every((s) => s.calls.length === 1 && s.calls[0][1].look === 'lab'));
  check('the teacher\'s own tab ignores its broadcast', teacherTabStudent.calls.length === 0);
  check('student tabs report what they applied', students.every((s) => s.handled.includes('lab:loadConfig')));
  check('roster shows the last reply', teacher.roster().every((r) => r.last?.request === 'lab:loadConfig' && r.last.ok && r.last.detail === '1 setting(s)'),
    JSON.stringify(teacher.roster().map((r) => r.last)));

  teacher.send('lab:runExperiment', { id: 'faraday-law' }, ['s-b']);
  await settle();
  check('`to` narrows a broadcast', students[1].runs.length === 1 && students[0].runs.length === 0 && students[2].runs.length === 0);
  check('teacher collects the run', teacher.runs().length === 1 && teacher.runs()[0].student === 's-b' && teacher.runs()[0].run.id === 'run-s-b');
  check('roster detail for a run', teacher.roster().find((r) => r.id === 's-b').last.detail === '2 rows, expects 1/1');

  teacher.send('lab:subscribe', { keys: ['rpm'] });
  await settle();
  check('channel refuses subscribe with lab:error', teacher.roster().every((r) => r.last?.request === 'lab:subscribe' && r.last.ok === false));

  // A student posting a request is not obeyed by the teacher client, and a
  // request from another student is still handled by students (same origin).
  students[0].ep.bye();
  await settle();
  check('bye drops the student from the roster', !teacher.roster().some((r) => r.id === 's-a') && changes > 0);
  const before = teacher.roster().length;
  check('prune drops silent students', teacher.prune(-1) === before && teacher.roster().length === 0);

  for (const c of channels) c.close();
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error(`[embed] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[embed] ${ok.length} checks passed`);
