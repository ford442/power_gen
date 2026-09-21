#!/usr/bin/env node
/**
 * test-lab-audio.mjs — contracts for the lab sonification (#203 WS D).
 *
 * The audio graph needs a browser, but the part that can *hurt* — the telemetry
 * → parameter mapping — is pure arithmetic, and the failure modes are specific:
 *
 *   - a NaN reaching an `AudioParam.value` throws and kills the frame;
 *   - a frequency at 0 Hz or above Nyquist is either silent or aliased mush;
 *   - an unclamped gain is a loud surprise in a classroom, which is the one
 *     bug in this feature that is genuinely unkind.
 *
 * So every mapping function is run over sane, absurd and hostile inputs:
 *
 *   1. Clamp helpers: norm01 / clampHz / clampGain are total, NaN-safe, bounded.
 *   2. Every voice: monotone in its telemetry input, silent at zero, clamped at
 *      the top, and NaN/undefined/±Infinity all read as silence — never as a
 *      default tone.
 *   3. Sparks: Kelvin edge detection fires once per breakdown and retriggers,
 *      and the VDG rate → interval conversion is bounded and monotone.
 *   4. Silence policy: a hidden tab, a mute, or a dropped twin all silence.
 *   5. Defaults: `?audio=1` is required; every other spelling stays silent.
 *   6. Structure: no sample files are shipped, no audio library is depended on,
 *      and the badge labels every state.
 *
 * Usage: node scripts/test-lab-audio.mjs   (exit 1 on failure)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

async function importTs(rel) {
  const { code } = await esbuild.transform(read(rel), { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

/** Bundle, so a module's relative imports resolve (lab-audio.ts reaches the hub). */
async function importTsBundle(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    plugins: [viteRawStub]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

const m = await importTs('src/audio/lab-audio-mapping.ts');

/** Values that must never produce a tone, a NaN or a throw. */
const HOSTILE = [Number.NaN, Infinity, -Infinity, undefined, null, '', 'loud', {}, []];

// ── 1. Clamp helpers ───────────────────────────────────────────────────────
{
  check('finite passes a number through', m.finite(3.5) === 3.5, String(m.finite(3.5)));
  for (const v of HOSTILE) {
    check(`finite(${JSON.stringify(v)}) → 0`, m.finite(v) === 0, String(m.finite(v)));
  }

  check('norm01 maps the full-scale point to 1', m.norm01(8, 8) === 1, String(m.norm01(8, 8)));
  check('norm01 clamps above full scale', m.norm01(80, 8) === 1, String(m.norm01(80, 8)));
  check('norm01 clamps negatives to 0', m.norm01(-4, 8) === 0, String(m.norm01(-4, 8)));
  check('norm01 survives a zero full-scale', m.norm01(4, 0) === 0, String(m.norm01(4, 0)));
  check('norm01 is monotone', m.norm01(2, 8) < m.norm01(4, 8) && m.norm01(4, 8) < m.norm01(6, 8),
    'norm01 is not monotone');

  check('clampHz floors at the audible minimum', m.clampHz(0) === m.AUDIBLE_HZ.min,
    String(m.clampHz(0)));
  check('clampHz caps at the audible maximum', m.clampHz(1e9) === m.AUDIBLE_HZ.max,
    String(m.clampHz(1e9)));
  check('clampHz rejects negatives', m.clampHz(-440) === m.AUDIBLE_HZ.min, String(m.clampHz(-440)));
  for (const v of HOSTILE) {
    const hz = m.clampHz(v);
    check(`clampHz(${JSON.stringify(v)}) is finite and audible`,
      Number.isFinite(hz) && hz >= m.AUDIBLE_HZ.min && hz <= m.AUDIBLE_HZ.max, String(hz));
  }
  check('the audible band is sane',
    m.AUDIBLE_HZ.min > 0 && m.AUDIBLE_HZ.max < 20000 && m.AUDIBLE_HZ.min < m.AUDIBLE_HZ.max,
    JSON.stringify(m.AUDIBLE_HZ));

  check('clampGain caps at 1 by default', m.clampGain(9) === 1, String(m.clampGain(9)));
  check('clampGain honours a lower cap', m.clampGain(9, 0.4) === 0.4, String(m.clampGain(9, 0.4)));
  check('clampGain floors at 0', m.clampGain(-3) === 0, String(m.clampGain(-3)));
  for (const v of HOSTILE) {
    check(`clampGain(${JSON.stringify(v)}) → 0`, m.clampGain(v) === 0, String(m.clampGain(v)));
  }
}

// ── 2. Voices ──────────────────────────────────────────────────────────────
{
  const voices = [
    {
      name: 'SEG hum',
      fn: (v) => m.segHumParams(v),
      quiet: 0,
      loud: m.SEG_HUM.omegaFull,
      over: m.SEG_HUM.omegaFull * 100,
      maxGain: m.SEG_HUM.maxGain
    },
    {
      name: 'coil hum',
      fn: (v) => m.coilHumParams(v),
      quiet: 0,
      loud: m.COIL_HUM.currentFullA,
      over: m.COIL_HUM.currentFullA * 100,
      maxGain: m.COIL_HUM.maxGain
    }
  ];

  for (const v of voices) {
    const at = (x) => v.fn(x);
    check(`${v.name} is silent at rest`, at(v.quiet).gain === 0, String(at(v.quiet).gain));
    check(`${v.name} is audible at full scale`, at(v.loud).gain > 0.05, String(at(v.loud).gain));
    check(`${v.name} gain is capped`, Math.abs(at(v.over).gain - v.maxGain) < 1e-9,
      `${at(v.over).gain} vs ${v.maxGain}`);
    check(`${v.name} gain never exceeds its cap`,
      [0, 0.1, 1, 10, 1e6].every((x) => at(x).gain <= v.maxGain + 1e-9),
      'a gain escaped its cap');
    check(`${v.name} rises with its input`,
      at(v.loud * 0.25).gain < at(v.loud * 0.75).gain
        && at(v.loud * 0.25).frequency < at(v.loud * 0.75).frequency,
      'not monotone in gain and pitch');
    check(`${v.name} treats a negative input by magnitude`,
      at(-v.loud).gain === at(v.loud).gain, `${at(-v.loud).gain} vs ${at(v.loud).gain}`);
    check(`${v.name} frequency stays audible`,
      [0, v.loud, v.over, -v.over].every((x) => {
        const f = at(x).frequency;
        return f >= m.AUDIBLE_HZ.min && f <= m.AUDIBLE_HZ.max;
      }), 'a frequency left the audible band');
    for (const bad of HOSTILE) {
      const p = at(bad);
      check(`${v.name}(${JSON.stringify(bad)}) is silent and finite`,
        p.gain === 0 && Number.isFinite(p.frequency), JSON.stringify(p));
    }
  }

  // Flow bed: two inputs, so check the cross terms too.
  const still = m.flowNoiseParams(0, 0);
  const fast = m.flowNoiseParams(m.FLOW_NOISE.flowFullMps, 1);
  const fastNoLoad = m.flowNoiseParams(m.FLOW_NOISE.flowFullMps, 0);
  check('flow bed is silent with no flow', still.gain === 0, String(still.gain));
  check('flow bed is audible at full flow and load', fast.gain > 0.05, String(fast.gain));
  check('flow bed gain is capped', fast.gain <= m.FLOW_NOISE.maxGain + 1e-9,
    `${fast.gain} vs ${m.FLOW_NOISE.maxGain}`);
  check('flow with no load is quieter than flow under load',
    fastNoLoad.gain > 0 && fastNoLoad.gain < fast.gain,
    `${fastNoLoad.gain} vs ${fast.gain}`);
  check('flow sweeps the filter upward',
    m.flowNoiseParams(0.5, 1).frequency < m.flowNoiseParams(3, 1).frequency,
    'the bandpass does not follow flow');
  check('flow Q is positive and finite',
    Number.isFinite(fast.q) && fast.q > 0, String(fast.q));
  for (const bad of HOSTILE) {
    const p = m.flowNoiseParams(bad, bad);
    check(`flow bed(${JSON.stringify(bad)}) is silent and finite`,
      p.gain === 0 && Number.isFinite(p.frequency) && Number.isFinite(p.q), JSON.stringify(p));
  }
}

// ── 3. Sparks ──────────────────────────────────────────────────────────────
{
  for (const kind of ['kelvin', 'vdg']) {
    const cue = m.sparkCue(kind, 1);
    check(`${kind} cue is audible`, cue.gain > 0 && cue.gain <= m.SPARK.maxGain + 1e-9,
      String(cue.gain));
    check(`${kind} cue frequency is audible`,
      cue.frequency >= m.AUDIBLE_HZ.min && cue.frequency <= m.AUDIBLE_HZ.max,
      String(cue.frequency));
    check(`${kind} cue is short`, cue.durationS > 0 && cue.durationS < 0.25, String(cue.durationS));
    check(`${kind} cue names its kind`, cue.kind === kind, cue.kind);
  }
  check('a VDG spark reads lower than a Kelvin spark',
    m.sparkCue('vdg').frequency < m.sparkCue('kelvin').frequency,
    `${m.sparkCue('vdg').frequency} vs ${m.sparkCue('kelvin').frequency}`);
  check('a weak spark still clicks', m.sparkCue('kelvin', 0).gain > 0,
    String(m.sparkCue('kelvin', 0).gain));
  check('spark strength is clamped',
    m.sparkCue('kelvin', 99).gain === m.sparkCue('kelvin', 1).gain
      && m.sparkCue('kelvin', -99).gain === m.sparkCue('kelvin', 0).gain,
    'strength escaped 0..1');
  // Invalid strength must degrade to the *floor*, never to full scale: a NaN
  // voltage ratio turning into a full-volume click is the unkind failure.
  const floorGain = m.sparkCue('kelvin', 0).gain;
  for (const bad of HOSTILE) {
    const cue = m.sparkCue('kelvin', bad);
    check(`spark cue(strength=${JSON.stringify(bad)}) is finite and capped`,
      Number.isFinite(cue.gain) && cue.gain <= m.SPARK.maxGain + 1e-9
        && Number.isFinite(cue.frequency), JSON.stringify(cue));
    check(`spark cue(strength=${JSON.stringify(bad)}) falls back to the floor, not full scale`,
      Math.abs(cue.gain - floorGain) < 1e-9,
      `gain ${cue.gain} vs floor ${floorGain} (full scale is ${m.sparkCue('kelvin', 1).gain})`);
  }
  check('the spark floor is well below full scale',
    floorGain > 0 && floorGain < m.sparkCue('kelvin', 1).gain * 0.6,
    `floor ${floorGain}, full ${m.sparkCue('kelvin', 1).gain}`);

  // Kelvin: the plant sets a countdown at breakdown, so a rise is the event.
  check('Kelvin spark fires on the rising edge', m.kelvinSparkFired(0, 0.18) === true,
    'a fresh breakdown did not fire');
  check('Kelvin spark does not fire while the timer runs down',
    m.kelvinSparkFired(0.18, 0.12) === false, 'a decaying timer fired again');
  check('Kelvin spark does not fire at rest', m.kelvinSparkFired(0, 0) === false,
    'silence fired a spark');
  check('Kelvin spark retriggers on a second breakdown',
    m.kelvinSparkFired(0.05, 0.18) === true,
    'a breakdown during the previous spark was missed');
  check('Kelvin edge detection is NaN-safe',
    m.kelvinSparkFired(Number.NaN, Number.NaN) === false
      && m.kelvinSparkFired(undefined, undefined) === false,
    'NaN timers fired a spark');

  // VDG: a rate, so intervals.
  check('VDG silence means no clicks', m.vdgClickIntervalS(0) === Infinity,
    String(m.vdgClickIntervalS(0)));
  check('VDG 2 Hz → 0.5 s', Math.abs(m.vdgClickIntervalS(2) - 0.5) < 1e-9,
    String(m.vdgClickIntervalS(2)));
  check('VDG interval shortens as the rate rises',
    m.vdgClickIntervalS(1) > m.vdgClickIntervalS(5), 'interval is not monotone');
  check('VDG interval has a floor', m.vdgClickIntervalS(10_000) === m.SPARK.minIntervalS,
    String(m.vdgClickIntervalS(10_000)));
  check('a negative VDG rate means no clicks', m.vdgClickIntervalS(-3) === Infinity,
    String(m.vdgClickIntervalS(-3)));
  for (const bad of HOSTILE) {
    const iv = m.vdgClickIntervalS(bad);
    check(`VDG interval(${JSON.stringify(bad)}) is Infinity or bounded`,
      iv === Infinity || (iv >= m.SPARK.minIntervalS && Number.isFinite(iv)), String(iv));
  }
}

// ── 4. Silence policy ──────────────────────────────────────────────────────
{
  check('a running lab is not silenced', m.shouldSilence({}) === false, 'silenced with no reason');
  check('a hidden tab is silenced', m.shouldSilence({ documentHidden: true }) === true,
    'a background tab kept droning');
  check('a mute is silenced', m.shouldSilence({ muted: true }) === true, 'mute did nothing');
  check('a dropped twin is silenced', m.shouldSilence({ twinDropped: true }) === true,
    'a disconnected twin kept its tone');
  check('the bus ramps rather than steps', m.BUS.rampS > 0 && m.BUS.rampS < 1,
    String(m.BUS.rampS));
  check('the master gain leaves headroom', m.BUS.masterGain > 0 && m.BUS.masterGain <= 0.6,
    String(m.BUS.masterGain));
  check('the compressor is configured to catch a full lab',
    m.BUS.compressor.ratio > 1 && m.BUS.compressor.threshold < 0
      && m.BUS.compressor.attack > 0 && m.BUS.compressor.release > 0,
    JSON.stringify(m.BUS.compressor));

  // Worst case: every voice at full tilt must still leave the bus under unity.
  const peak = m.SEG_HUM.maxGain + m.COIL_HUM.maxGain + m.FLOW_NOISE.maxGain + m.SPARK.maxGain;
  check(`all voices at full × master = ${(peak * m.BUS.masterGain).toFixed(2)}`,
    peak * m.BUS.masterGain < 1,
    `${peak} × ${m.BUS.masterGain} = ${peak * m.BUS.masterGain} — the bus can clip before the compressor`);
}

// ── 5. Opt-in only ─────────────────────────────────────────────────────────
{
  const audio = await importTsBundle('src/audio/lab-audio.ts');
  const parse = audio.parseLabAudioEnabled;
  check('?audio=1 enables', parse(new URLSearchParams('audio=1')) === true, 'audio=1 was ignored');
  check('?audio=on enables', parse(new URLSearchParams('audio=on')) === true, 'audio=on was ignored');
  check('?audio=true / yes enable',
    parse(new URLSearchParams('audio=true')) === true && parse(new URLSearchParams('audio=yes')) === true,
    'a documented alias was ignored');
  check('no query stays silent', parse(new URLSearchParams('')) === false,
    'default boot enabled audio');
  for (const q of ['audio=0', 'audio=off', 'audio=false', 'audio=', 'audio=maybe', 'renderer=webgl2']) {
    check(`?${q} stays silent`, parse(new URLSearchParams(q)) === false, `${q} enabled audio`);
  }

  // A disabled LabAudio must construct without touching AudioContext, timers,
  // window or the hub — that is what makes default boot silent rather than quiet.
  let subscribed = false;
  let contextBuilt = false;
  const off = new audio.LabAudio({
    enabled: false,
    subscribe: () => { subscribed = true; return () => {}; },
    contextFactory: () => { contextBuilt = true; throw new Error('should not be called'); }
  });
  check('a disabled LabAudio subscribes to nothing', subscribed === false, 'it subscribed anyway');
  check('a disabled LabAudio opens no AudioContext', contextBuilt === false, 'it built a context');
  check('a disabled LabAudio starts muted and unstarted',
    off.muted === true && off.started === false, `muted=${off.muted} started=${off.started}`);
  await off.start();
  check('start() on a disabled LabAudio is a no-op',
    off.started === false && contextBuilt === false, 'a disabled instance started');
  off.destroy();

  // An *enabled* instance still opens nothing until a gesture arrives.
  const armed = new audio.LabAudio({
    enabled: true,
    subscribe: () => () => {},
    contextFactory: () => { contextBuilt = true; throw new Error('no AudioContext in Node'); }
  });
  check('an enabled LabAudio waits for a gesture',
    armed.started === false && armed.muted === true && contextBuilt === false,
    `started=${armed.started} contextBuilt=${contextBuilt}`);
  // The factory throws on purpose; muffle the expected warning so it doesn't
  // read as a CI failure.
  const warn = console.warn;
  console.warn = () => {};
  try {
    await armed.start();
  } finally {
    console.warn = warn;
  }
  check('a failed AudioContext leaves it silent, not broken',
    contextBuilt === true && armed.started === false,
    `contextBuilt=${contextBuilt} started=${armed.started}`);
  armed.destroy();
}

// ── 6. No sample pack, no audio library, complete badge ────────────────────
{
  const audioSrc = read('src/audio/lab-audio.ts');
  check('the noise bed is generated, not loaded',
    /createBuffer\(/.test(audioSrc) && /Math\.random\(\)/.test(audioSrc),
    'lab-audio.ts no longer synthesises its own noise');
  check('no decodeAudioData / fetch of media', !/decodeAudioData|\.wav|\.mp3|\.ogg/.test(audioSrc),
    'lab-audio.ts loads an audio file');
  check('visibilitychange is handled', /visibilitychange/.test(audioSrc),
    'no visibilitychange handler — a background tab could drone');
  check('a gesture is required before the context opens',
    /pointerdown|keydown/.test(audioSrc), 'lab-audio.ts opens an AudioContext without a gesture');
  check('a dropped twin mutes', /hardwareTwin\?\.connected/.test(audioSrc),
    'lab-audio.ts does not watch the twin');

  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const banned = ['tone', 'howler', 'pizzicato', 'wad', 'soundjs'];
  const found = banned.filter((d) => d in deps);
  check('no audio library dependency', found.length === 0, `found ${found.join(', ')}`);

  // Nothing media-shaped may appear under the served assets.
  const assets = join(ROOT, 'src/public');
  const mediaExt = /\.(wav|mp3|ogg|m4a|flac|aac)$/i;
  const walk = (dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : (mediaExt.test(name) ? [full] : []);
    });
  };
  const media = walk(assets);
  check('no audio files are shipped', media.length === 0,
    `found ${media.map((f) => f.replace(ROOT, '')).join(', ')}`);

  const badge = await importTs('src/audio/lab-audio-badge.ts');
  const states = [
    [{ started: false, muted: true }, 'waiting'],
    [{ started: false, muted: false }, 'waiting'],
    [{ started: true, muted: true }, 'muted'],
    [{ started: true, muted: false }, 'on']
  ];
  for (const [input, expected] of states) {
    check(`badge ${JSON.stringify(input)} → ${expected}`,
      badge.labAudioBadgeState(input) === expected, badge.labAudioBadgeState(input));
  }
  const badgeSrc = read('src/audio/lab-audio-badge.ts');
  for (const state of ['waiting', 'on', 'muted']) {
    check(`badge labels "${state}"`, new RegExp(`\\n\\s*${state}: '`).test(badgeSrc),
      `no LABELS entry for ${state}`);
  }
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[lab-audio] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[lab-audio] ${ok.length} checks passed`);
