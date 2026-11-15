/**
 * embed — the embed / classroom protocol (#224 §5).
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
 * Usage: npm run test:embed   (node --test scripts/tests/embed.test.mjs)
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bundleTs } from '../test-harness.mjs';

const m = await bundleTs({
  contents: `
export * from './src/embed/embed-protocol.ts';
export { handleLabRequest, hostCapabilities } from './src/embed/lab-requests.ts';
export { createEmbedEndpoint, MAX_SUBSCRIPTIONS } from './src/embed/embed-endpoint.ts';
export { createStudentEndpoint, createTeacherClient } from './src/embed/classroom-channel.ts';
export { DEVICE_TELEMETRY_FIELDS } from './generated/device-catalog.ts';
export { LAB_CONFIG_FIELDS } from './generated/lab-config.ts';
`,
  sourcefile: 'embed-entry.ts'
});

describe('1. origins', () => {
  const good = [
    ['https://a.example', 'https://a.example'],
    ['HTTPS://A.Example', 'https://a.example'],
    ['https://a.example/', 'https://a.example'],
    ['https://a.example:443', 'https://a.example'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['  https://school.example:8443  ', 'https://school.example:8443']
  ];
  for (const [raw, want] of good) {
    it(`origin ${JSON.stringify(raw)} → ${want}`, () => {
      assert.ok(m.parseOrigin(raw) === want, String(m.parseOrigin(raw)));
    });
  }
  const bad = ['*', ' * ', 'https://*.example', 'https://*', 'null', 'NULL', '', 'a.example',
    'https://a.example/path', 'https://a.example?x=1', 'https://a.example#h', 'https://user:pw@a.example',
    'https://user@a.example', 'file:///tmp', 'ftp://a.example', 'javascript:alert(1)', 'data:text/html,x',
    'https://', 'https:a.example', '//a.example', 42, null, undefined];
  for (const raw of bad) {
    it(`origin ${JSON.stringify(raw)} refused`, () => {
      assert.ok(m.parseOrigin(raw) === null, String(m.parseOrigin(raw)));
    });
  }

  const list = m.buildAllowlist(['https://a.example', '*', 'https://b.example:8443', 'https://*.c.example'], 'http://localhost:5741');
  it('allowlist keeps exact origins + own origin', () => {
    assert.ok(JSON.stringify([...list.allowed].sort()) === JSON.stringify(['http://localhost:5741', 'https://a.example', 'https://b.example:8443']),
      JSON.stringify([...list.allowed]));
  });
  it('allowlist reports refused entries', () => {
    assert.ok(JSON.stringify(list.refused) === JSON.stringify(['*', 'https://*.c.example']), JSON.stringify(list.refused));
  });
  const lookalikes = ['https://a.example.evil', 'https://evil-a.example', 'http://a.example', 'https://a.example:444',
    'https://b.example', 'https://sub.a.example', 'https://a.exampl', 'null', '*', '', undefined];
  for (const o of lookalikes) {
    it(`lookalike ${JSON.stringify(o)} not allowed`, () => {
      assert.ok(!m.isAllowedOrigin(list, o));
    });
  }
  it('exact origin allowed', () => {
    assert.ok(m.isAllowedOrigin(list, 'https://a.example'));
  });
  it('own origin allowed', () => {
    assert.ok(m.isAllowedOrigin(list, 'http://localhost:5741'));
  });
  it('opaque own origin (file://) is not added', () => {
    assert.equal(m.buildAllowlist([], 'null').allowed.size, 0);
  });

  it('LabConfig embedOrigins is a URL-only list (never shared, never stored)', () => {
    const spec = m.LAB_CONFIG_FIELDS.find((f) => f.key === 'embedOrigins');
    assert.ok(spec && spec.type === 'list' && !spec.share && !spec.storage, JSON.stringify(spec));
  });
  it('LabConfig teacher is a URL-only bool', () => {
    const teacher = m.LAB_CONFIG_FIELDS.find((f) => f.key === 'teacher');
    assert.ok(teacher && teacher.type === 'bool' && !teacher.share && !teacher.storage, JSON.stringify(teacher));
  });
});

describe('2. validator', () => {
  const p = (d) => m.parseLabRequest(d);
  it('non-lab traffic ignored', () => {
    assert.ok(p({ type: 'webpackOk' }) === null && p('lab:hello') === null && p(null) === null
      && p([{ type: 'lab:hello' }]) === null && p({ type: 42 }) === null);
  });
  it('replies / telemetry / ready are not requests', () => {
    assert.ok(['lab:hello:result', 'lab:error', 'lab:telemetry', 'lab:ready', 'lab:bye'].every((type) => p({ type }) === null));
  });
  it('hello parses', () => {
    const hello = p({ type: 'lab:hello', requestId: 'h1' });
    assert.ok(hello?.ok && hello.request.type === 'lab:hello' && hello.request.requestId === 'h1', JSON.stringify(hello));
  });
  it('missing requestId → null', () => {
    assert.ok(p({ type: 'lab:ping' })?.request?.requestId === null);
  });
  it('object requestId → lab:error', () => {
    const badId = p({ type: 'lab:ping', requestId: { x: 1 } });
    assert.ok(badId && !badId.ok && badId.reply.type === 'lab:error' && badId.reply.requestId === null, JSON.stringify(badId));
  });
  it('long requestId refused', () => {
    assert.ok(p({ type: 'lab:ping', requestId: 'x'.repeat(129) })?.ok === false);
  });
  it('unknown lab: type → lab:error with requestId', () => {
    const unknown = p({ type: 'lab:selfDestruct', requestId: 7 });
    assert.ok(unknown && !unknown.ok && unknown.reply.requestId === 7
      && unknown.reply.request === 'lab:selfDestruct' && unknown.reply.ok === false, JSON.stringify(unknown));
  });
  it('loadConfig needs an object', () => {
    assert.ok(p({ type: 'lab:loadConfig', config: [1] })?.ok === false
      && p({ type: 'lab:loadConfig', config: 'look=lab' })?.ok === false
      && p({ type: 'lab:loadConfig', config: { look: 'lab' } })?.ok === true);
  });
  it('runExperiment by id', () => {
    const runId = p({ type: 'lab:runExperiment', id: 'faraday-law', requestId: 'r' });
    assert.ok(runId?.ok && runId.request.experiment === 'faraday-law' && !('runner' in runId.request), JSON.stringify(runId));
  });
  it('runExperiment by definition + live runner', () => {
    const runDef = p({ type: 'lab:runExperiment', experiment: { id: 'x', steps: [] }, runner: 'live' });
    assert.ok(runDef?.ok && typeof runDef.request.experiment === 'object' && runDef.request.runner === 'live');
  });
  it('runExperiment bad id / runner refused', () => {
    assert.ok(p({ type: 'lab:runExperiment', id: '../../etc' })?.ok === false
      && p({ type: 'lab:runExperiment' })?.ok === false
      && p({ type: 'lab:runExperiment', id: 'ok', runner: 'remote' })?.ok === false);
  });

  it('subscribe: hz 60 clamps to 10, keys deduped', () => {
    const key = m.DEVICE_TELEMETRY_FIELDS[0].key;
    const sub = p({ type: 'lab:subscribe', keys: [key, key, 'rpm'], hz: 60 });
    assert.ok(sub?.ok && sub.request.hz === 10
      && JSON.stringify(sub.request.keys) === JSON.stringify([key, 'rpm']), JSON.stringify(sub));
  });
  it('subscribe: unknown key refused', () => {
    assert.ok(p({ type: 'lab:subscribe', keys: ['segOmega', 'document.cookie'] })?.ok === false);
  });
  it('subscribe: keys omitted → follow focus', () => {
    assert.ok(p({ type: 'lab:subscribe' })?.request?.keys === null);
  });
  it('subscribe: too many keys refused', () => {
    assert.ok(p({ type: 'lab:subscribe', keys: Array(200).fill('rpm') })?.ok === false);
  });
  it('unsubscribe: integer or none', () => {
    assert.ok(p({ type: 'lab:unsubscribe', subscription: 3 })?.request?.subscription === 3
      && p({ type: 'lab:unsubscribe' })?.request?.subscription === null
      && p({ type: 'lab:unsubscribe', subscription: 'all' })?.ok === false);
  });

  const hz = [[undefined, m.TELEMETRY_HZ_DEFAULT], [0, m.TELEMETRY_HZ_DEFAULT], [-5, m.TELEMETRY_HZ_DEFAULT],
    [NaN, m.TELEMETRY_HZ_DEFAULT], [Infinity, m.TELEMETRY_HZ_DEFAULT], ['abc', m.TELEMETRY_HZ_DEFAULT],
    [1000, 10], [10, 10], [10.0001, 10], ['30', 10], [2, 2], [0.01, m.TELEMETRY_HZ_MIN]];
  for (const [raw, want] of hz) {
    it(`clampHz(${String(raw)}) = ${want}`, () => {
      assert.ok(m.clampHz(raw) === want, String(m.clampHz(raw)));
    });
  }
  it('TELEMETRY_HZ_MAX is 10', () => {
    assert.equal(m.TELEMETRY_HZ_MAX, 10);
  });

  it('every DEVICE_TELEMETRY_FIELDS key is a telemetry key', () => {
    assert.ok(m.DEVICE_TELEMETRY_FIELDS.every((f) => m.isTelemetryKey(f.key)));
  });
  it('focus keys of overview → SEG keys', () => {
    assert.ok(JSON.stringify(m.focusTelemetryKeys('overview')) === JSON.stringify(['rpm', 'omega', 'corona', 'voltage', 'current', 'power', 'fieldSim']));
  });
  it('focus keys of heron = its catalog keys', () => {
    const heronKeys = m.focusTelemetryKeys('heron');
    assert.ok(heronKeys.length > 0 && heronKeys.every((k) => k.startsWith('heron')), JSON.stringify(heronKeys));
  });
  it('pickTelemetry reads seg + owning device, drops NaN / missing', () => {
    const picked = m.pickTelemetry({
      simTimeS: 1.5,
      seg: { rpmDisplay: 1200, voltage: 3.5, power: Number.NaN },
      devices: { heron: { heronHead: 0.42, kelvinV: 999 }, kelvin: { kelvinV: 12000 } }
    }, ['rpm', 'voltage', 'power', 'heronHead', 'kelvinV', 'mhdVoltage']);
    assert.ok(JSON.stringify(picked) === JSON.stringify({ rpm: 1200, voltage: 3.5, heronHead: 0.42, kelvinV: 12000 }), JSON.stringify(picked));
  });
});

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

describe('3. handlers', () => {
  const { host } = fakeHost();
  it('hello reply shape', async () => {
    const hello = await m.handleLabRequest({ type: 'lab:hello', requestId: 1 }, host);
    assert.ok(hello.type === 'lab:hello:result' && hello.ok === true && hello.requestId === 1
      && hello.protocol === 1 && hello.schema === 'abc123' && hello.disclaimer === 'Simulated, not metrology'
      && hello.capabilities.includes('lab:loadConfig') && !hello.capabilities.includes('lab:runExperiment')
      && !hello.capabilities.includes('lab:snapshot') && hello.capabilities.includes('lab:subscribe'), JSON.stringify(hello));
  });
  it('runExperiment without the §3 hook → experiments unavailable', async () => {
    const noExp = await m.handleLabRequest({ type: 'lab:runExperiment', requestId: 'r', experiment: 'x' }, host);
    assert.ok(noExp.type === 'lab:error' && noExp.ok === false && noExp.error === 'experiments unavailable' && noExp.requestId === 'r'
      && noExp.request === 'lab:runExperiment', JSON.stringify(noExp));
  });
  it('snapshot without the §2 hook → lab:error', async () => {
    const noSnap = await m.handleLabRequest({ type: 'lab:snapshot', requestId: 's' }, host);
    assert.ok(noSnap.type === 'lab:error' && /unavailable/.test(noSnap.error));
  });
  it('ping returns status', async () => {
    const ping = await m.handleLabRequest({ type: 'lab:ping', requestId: null }, host);
    assert.ok(ping.type === 'lab:ping:result' && ping.status.view === 'heron');
  });
  it('loadConfig returns the load result', async () => {
    const load = await m.handleLabRequest({ type: 'lab:loadConfig', requestId: 'l', config: { look: 'lab' } }, host);
    assert.ok(load.ok && JSON.stringify(load.result.applied) === '["look"]', JSON.stringify(load));
  });

  describe('a host with the experiment and snapshot hooks', () => {
    const runs = [];
    const { host: full } = fakeHost({
      async runExperiment(exp, opts) { runs.push([exp, opts]); return { id: 'run-1', rows: [[0, 1]], columns: ['t', 'x'], fn: () => 1 }; },
      captureSnapshot: () => ({ plant: 'seg', state: new Float32Array([1, 2]) })
    });
    it('runExperiment calls window.lab.runExperiment(idOrDef, { runner })', async () => {
      const run = await m.handleLabRequest({ type: 'lab:runExperiment', requestId: 2, experiment: 'faraday-law', runner: 'offline' }, full);
      assert.ok(run.ok && run.run.id === 'run-1' && !('fn' in run.run) && runs[0][0] === 'faraday-law'
        && runs[0][1].runner === 'offline', JSON.stringify([run, runs]));
    });
    it('snapshot keeps typed arrays (structured clone)', async () => {
      const snap = await m.handleLabRequest({ type: 'lab:snapshot', requestId: 3 }, full);
      assert.ok(snap.ok && snap.state.state instanceof Float32Array);
    });
    it('channel capabilities exclude subscribe / snapshot', () => {
      const caps = m.hostCapabilities(full, 'channel');
      assert.ok(caps.includes('lab:runExperiment') && !caps.includes('lab:subscribe') && !caps.includes('lab:snapshot'), JSON.stringify(caps));
    });
  });
  it('handler exception → lab:error', async () => {
    const { host: throwing } = fakeHost({ loadConfig: async () => { throw new Error('boom'); } });
    const err = await m.handleLabRequest({ type: 'lab:loadConfig', requestId: 9, config: {} }, throwing);
    assert.ok(err.type === 'lab:error' && err.error === 'boom' && err.requestId === 9);
  });
});

class FakeSource {
  constructor() { this.posts = []; }
  postMessage(msg, targetOrigin) { this.posts.push({ msg, targetOrigin }); }
}

class FakeHub {
  constructor() { this.fns = new Set(); }
  subscribe(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  publish(snap) { for (const fn of [...this.fns]) fn(snap); }
}

describe('4. postMessage endpoint', () => {
  // One endpoint through the whole sequence; the steps run in order.
  const allowlist = m.buildAllowlist(['https://school.example'], 'http://localhost:5741');
  const hub = new FakeHub();
  let clock = 0;
  const debugs = [];
  const { host, calls } = fakeHost();
  const ep = m.createEmbedEndpoint({ allowlist, host, hub, now: () => clock, debug: (s) => debugs.push(s) });
  const parent = new FakeSource();
  const self = new FakeSource();
  let subReply;
  after(() => ep.dispose());

  it('disallowed origins get nothing, noted with console.debug', async () => {
    const evil = new FakeSource();
    for (const origin of ['https://school.example.evil', 'http://school.example', 'null', 'https://evil.example']) {
      await ep.onMessage({ origin, source: evil, data: { type: 'lab:hello', requestId: 1 } });
      await ep.onMessage({ origin, source: evil, data: { type: 'lab:loadConfig', requestId: 2, config: { look: 'lab' } } });
    }
    assert.ok(evil.posts.length === 0 && calls.length === 0, `disallowed origins get nothing — ${JSON.stringify(evil.posts)}`);
    assert.ok(debugs.length === 8 && /not in embedOrigins/.test(debugs[0]),
      `disallowed lab: messages are noted with console.debug — ${JSON.stringify(debugs)}`);
  });

  it('allowed origin: hello + loadConfig + error replied to event.origin (non-lab ignored)', async () => {
    await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:hello', requestId: 'h' } });
    await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:loadConfig', requestId: 'c', config: { look: 'lab' } } });
    await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:subscribe', requestId: 'bad', keys: ['nope'] } });
    await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'somethingElse' } });
    assert.ok(parent.posts.length === 3,
      `allowed origin: hello + loadConfig + error replied (non-lab ignored) — ${JSON.stringify(parent.posts.map((p) => p.msg.type))}`);
    assert.ok(parent.posts.every((p) => p.targetOrigin === 'https://school.example'), 'every reply targets event.origin, never *');
    assert.ok(parent.posts[0].msg.type === 'lab:hello:result'
      && parent.posts[1].msg.type === 'lab:loadConfig:result' && parent.posts[1].msg.requestId === 'c'
      && parent.posts[2].msg.type === 'lab:error' && parent.posts[2].msg.requestId === 'bad',
    `hello / loadConfig / error reply types — ${JSON.stringify(parent.posts.map((p) => p.msg))}`);
    assert.ok(calls.length === 1 && calls[0][1].look === 'lab', 'loadConfig reached window.lab.loadConfig');
  });

  it('own origin answered at its own origin', async () => {
    await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:ping', requestId: 1 } });
    assert.ok(self.posts.length === 1 && self.posts[0].targetOrigin === 'http://localhost:5741');
  });
  it('no source → no reply, no throw', async () => {
    await assert.doesNotReject(ep.onMessage({ origin: 'https://school.example', source: null, data: { type: 'lab:hello' } }));
  });

  // Telemetry: 60 frames at 60 Hz wall clock with hz 60 (→ 10) ⇒ ~10 pushes.
  it('telemetry: clamped subscribe reply, ≤ 10 Hz, filtered, sim time, targets event.origin', async () => {
    parent.posts.length = 0;
    const heronKey = 'heronHead';
    await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:subscribe', requestId: 's', keys: ['rpm', heronKey], hz: 60 } });
    subReply = parent.posts.shift().msg;
    assert.ok(subReply.type === 'lab:subscribe:result' && subReply.hz === 10 && Number.isInteger(subReply.subscription),
      `subscribe reply: id, clamped hz — ${JSON.stringify(subReply)}`);
    for (let i = 0; i < 60; i++) {
      clock = i * (1000 / 60);
      hub.publish({ simTimeS: i * 0.01, view: 'heron', seg: { rpmDisplay: 100 + i }, devices: { heron: { heronHead: 0.5, secret: 1 } } });
    }
    const tel = parent.posts.map((p) => p.msg);
    assert.ok(tel.length === 10, `telemetry ≤ 10 Hz (10 pushes in 1 s) — ${tel.length}`);
    assert.ok(tel.every((t) => t.type === 'lab:telemetry' && t.subscription === subReply.subscription
      && typeof t.t === 'number' && JSON.stringify(Object.keys(t.values)) === JSON.stringify(['rpm', heronKey])),
    `telemetry shape: subscription, sim t, filtered values — ${JSON.stringify(tel[0])}`);
    assert.ok(tel[1].t === 0.06 && tel[0].t === 0, `telemetry t is sim time, not wall time — ${JSON.stringify(tel.slice(0, 2).map((t) => t.t))}`);
    assert.ok(parent.posts.every((p) => p.targetOrigin === 'https://school.example'), 'telemetry posts target event.origin');
  });

  // Follow-focus subscription from the own origin at 2 Hz.
  it('2 Hz follow-focus subscription: 2 pushes / s with SEG keys; subscriptions are independent', async () => {
    await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:subscribe', requestId: 'f', hz: 2 } });
    self.posts.length = 0;
    parent.posts.length = 0;
    for (let i = 0; i < 60; i++) {
      clock = 1000 + i * (1000 / 60);
      hub.publish({ simTimeS: 1 + i * 0.01, view: 'overview', seg: { rpmDisplay: 5, voltage: 1 }, devices: {} });
    }
    assert.ok(self.posts.length === 2
      && JSON.stringify(Object.keys(self.posts[0].msg.values)) === JSON.stringify(['rpm', 'voltage']),
    `2 Hz follow-focus subscription: 2 pushes / s with SEG keys — ${JSON.stringify(self.posts.map((p) => p.msg))}`);
    assert.ok(parent.posts.length === 10, `subscriptions are independent — ${parent.posts.length}`);
  });

  // Another caller cannot cancel the parent's subscription.
  it('unsubscribe of someone else\'s subscription removes nothing', async () => {
    await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:unsubscribe', requestId: 'u', subscription: subReply.subscription } });
    assert.ok(self.posts.pop().msg.removed === 0 && ep.subscriptionCount() === 2);
  });
  it('unsubscribe stops telemetry and releases the hub', async () => {
    await ep.onMessage({ origin: 'https://school.example', source: parent, data: { type: 'lab:unsubscribe', requestId: 'u' } });
    await ep.onMessage({ origin: 'http://localhost:5741', source: self, data: { type: 'lab:unsubscribe', requestId: 'u2' } });
    assert.ok(ep.subscriptionCount() === 0 && hub.fns.size === 0, `${ep.subscriptionCount()} subs, ${hub.fns.size} hub fns`);
  });

  // A reply that cannot be cloned still answers.
  it('uncloneable reply → lab:error to the same origin', async () => {
    const picky = { posts: [], postMessage(msg, origin) { if (msg.state && msg.state.fn) throw new Error('DataCloneError'); this.posts.push({ msg, origin }); } };
    const { host: badSnap } = fakeHost({ captureSnapshot: () => ({ fn: () => 1 }) });
    const ep2 = m.createEmbedEndpoint({ allowlist, host: badSnap, hub, now: () => 0, debug: () => {} });
    try {
      await ep2.onMessage({ origin: 'https://school.example', source: picky, data: { type: 'lab:snapshot', requestId: 'x' } });
      assert.ok(picky.posts.length === 1 && picky.posts[0].msg.type === 'lab:error'
        && picky.posts[0].msg.requestId === 'x' && picky.posts[0].origin === 'https://school.example', JSON.stringify(picky.posts));
    } finally {
      ep2.dispose();
    }
  });
});

describe('5. BroadcastChannel routing', () => {
  const channels = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * Let channel traffic land: at least 60 ms, then until `arrived()` (the
   * replies the step waits for) or 2 s. Other test files run in parallel, so a
   * fixed 60 ms can miss a delivery; the negative checks only get a longer wait.
   */
  const settle = async (arrived = () => true) => {
    await sleep(60);
    for (let waited = 60; !arrived() && waited < 2000; waited += 20) await sleep(20);
  };
  let students, teacherTabStudent, teacher, eavesdrop;
  let changes = 0;

  before(() => {
    assert.equal(typeof BroadcastChannel, 'function', 'BroadcastChannel missing in this Node (need ≥ 18)');
    const NAME = `${m.LAB_CHANNEL_NAME}-test-${process.pid}`;
    const open = () => { const c = new BroadcastChannel(NAME); channels.push(c); return c; };
    students = ['s-a', 's-b', 's-c'].map((id) => {
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
    teacherTabStudent = fakeHost();
    m.createStudentEndpoint({ channel: open(), tabId: 'teach', host: teacherTabStudent.host });
    teacher = m.createTeacherClient({ channel: open(), tabId: 'teach', onChange: () => changes++ });
    eavesdrop = [];
    open().addEventListener('message', (ev) => eavesdrop.push(ev.data));
  });
  after(() => {
    for (const c of channels) c.close();
  });

  it('ping → roster of every student, with focus / mode, replies to the teacher only', async () => {
    teacher.ping();
    await settle(() => teacher.roster().length >= 3);
    const roster = teacher.roster();
    assert.ok(JSON.stringify(roster.map((r) => r.id)) === JSON.stringify(['s-a', 's-b', 's-c']),
      `ping → roster of every student (not the teacher's own tab) — ${JSON.stringify(roster.map((r) => r.id))}`);
    assert.ok(roster[0].status.view === 'seg' && roster[1].status.view === 'heron' && roster[0].status.labMode === 'lab',
      'roster carries focus / mode');
    assert.ok(eavesdrop.filter((d) => d.type === 'lab:ping:result').every((d) => JSON.stringify(d.to) === '["teach"]' && d.requestId?.startsWith('teach:')),
      'student replies are addressed to the teacher only');
  });

  it('broadcast loadConfig reaches every student but not the teacher\'s own tab', async () => {
    teacher.send('lab:loadConfig', { config: { look: 'lab' } });
    await settle(() => teacher.roster().every((r) => r.last?.request === 'lab:loadConfig'));
    assert.ok(students.every((s) => s.calls.length === 1 && s.calls[0][1].look === 'lab'), 'broadcast loadConfig reaches every student');
    assert.ok(teacherTabStudent.calls.length === 0, 'the teacher\'s own tab ignores its broadcast');
    assert.ok(students.every((s) => s.handled.includes('lab:loadConfig')), 'student tabs report what they applied');
    assert.ok(teacher.roster().every((r) => r.last?.request === 'lab:loadConfig' && r.last.ok && r.last.detail === '1 setting(s)'),
      `roster shows the last reply — ${JSON.stringify(teacher.roster().map((r) => r.last))}`);
  });

  it('`to` narrows a broadcast; the teacher collects the run', async () => {
    teacher.send('lab:runExperiment', { id: 'faraday-law' }, ['s-b']);
    await settle(() => teacher.runs().length >= 1);
    assert.ok(students[1].runs.length === 1 && students[0].runs.length === 0 && students[2].runs.length === 0, '`to` narrows a broadcast');
    assert.ok(teacher.runs().length === 1 && teacher.runs()[0].student === 's-b' && teacher.runs()[0].run.id === 'run-s-b', 'teacher collects the run');
    assert.ok(teacher.roster().find((r) => r.id === 's-b').last.detail === '2 rows, expects 1/1', 'roster detail for a run');
  });

  it('channel refuses subscribe with lab:error', async () => {
    teacher.send('lab:subscribe', { keys: ['rpm'] });
    await settle(() => teacher.roster().every((r) => r.last?.request === 'lab:subscribe'));
    assert.ok(teacher.roster().every((r) => r.last?.request === 'lab:subscribe' && r.last.ok === false));
  });

  // A student posting a request is not obeyed by the teacher client, and a
  // request from another student is still handled by students (same origin).
  it('bye drops the student from the roster; prune drops silent students', async () => {
    students[0].ep.bye();
    await settle(() => !teacher.roster().some((r) => r.id === 's-a'));
    assert.ok(!teacher.roster().some((r) => r.id === 's-a') && changes > 0, 'bye drops the student from the roster');
    const count = teacher.roster().length;
    assert.ok(teacher.prune(-1) === count && teacher.roster().length === 0, 'prune drops silent students');
  });
});
