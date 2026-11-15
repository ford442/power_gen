/**
 * audio — contracts for the lab sonification (#203 WS D).
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
 * Usage: npm run test:audio   (node --test scripts/tests/audio.test.mjs)
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let m;
before(async () => {
  m = await bundleTs('src/audio/lab-audio-mapping.ts');
});

/** Values that must never produce a tone, a NaN or a throw. */
const HOSTILE = [Number.NaN, Infinity, -Infinity, undefined, null, '', 'loud', {}, []];
const show = (v) => JSON.stringify(v);

describe('1. clamp helpers', () => {
  it('finite', () => {
    assert.ok(m.finite(3.5) === 3.5, `finite passes a number through: ${m.finite(3.5)}`);
    for (const v of HOSTILE) {
      assert.ok(m.finite(v) === 0, `finite(${show(v)}) → 0: ${m.finite(v)}`);
    }
  });

  it('norm01', () => {
    assert.ok(m.norm01(8, 8) === 1, `norm01 maps the full-scale point to 1: ${m.norm01(8, 8)}`);
    assert.ok(m.norm01(80, 8) === 1, `norm01 clamps above full scale: ${m.norm01(80, 8)}`);
    assert.ok(m.norm01(-4, 8) === 0, `norm01 clamps negatives to 0: ${m.norm01(-4, 8)}`);
    assert.ok(m.norm01(4, 0) === 0, `norm01 survives a zero full-scale: ${m.norm01(4, 0)}`);
    assert.ok(m.norm01(2, 8) < m.norm01(4, 8) && m.norm01(4, 8) < m.norm01(6, 8),
      'norm01 is monotone: norm01 is not monotone');
  });

  it('clampHz', () => {
    assert.ok(m.clampHz(0) === m.AUDIBLE_HZ.min, `clampHz floors at the audible minimum: ${m.clampHz(0)}`);
    assert.ok(m.clampHz(1e9) === m.AUDIBLE_HZ.max, `clampHz caps at the audible maximum: ${m.clampHz(1e9)}`);
    assert.ok(m.clampHz(-440) === m.AUDIBLE_HZ.min, `clampHz rejects negatives: ${m.clampHz(-440)}`);
    for (const v of HOSTILE) {
      const hz = m.clampHz(v);
      assert.ok(Number.isFinite(hz) && hz >= m.AUDIBLE_HZ.min && hz <= m.AUDIBLE_HZ.max,
        `clampHz(${show(v)}) is finite and audible: ${hz}`);
    }
    assert.ok(m.AUDIBLE_HZ.min > 0 && m.AUDIBLE_HZ.max < 20000 && m.AUDIBLE_HZ.min < m.AUDIBLE_HZ.max,
      `the audible band is sane: ${JSON.stringify(m.AUDIBLE_HZ)}`);
  });

  it('clampGain', () => {
    assert.ok(m.clampGain(9) === 1, `clampGain caps at 1 by default: ${m.clampGain(9)}`);
    assert.ok(m.clampGain(9, 0.4) === 0.4, `clampGain honours a lower cap: ${m.clampGain(9, 0.4)}`);
    assert.ok(m.clampGain(-3) === 0, `clampGain floors at 0: ${m.clampGain(-3)}`);
    for (const v of HOSTILE) {
      assert.ok(m.clampGain(v) === 0, `clampGain(${show(v)}) → 0: ${m.clampGain(v)}`);
    }
  });
});

describe('2. voices', () => {
  const voices = [
    {
      name: 'SEG hum',
      fn: (v) => m.segHumParams(v),
      quiet: 0,
      loud: () => m.SEG_HUM.omegaFull,
      maxGain: () => m.SEG_HUM.maxGain
    },
    {
      name: 'coil hum',
      fn: (v) => m.coilHumParams(v),
      quiet: 0,
      loud: () => m.COIL_HUM.currentFullA,
      maxGain: () => m.COIL_HUM.maxGain
    }
  ];

  for (const voice of voices) {
    it(`${voice.name}: silent at rest, audible, capped, monotone, audible band, hostile-safe`, () => {
      const v = { ...voice, loud: voice.loud(), over: voice.loud() * 100, maxGain: voice.maxGain() };
      const at = (x) => v.fn(x);
      assert.ok(at(v.quiet).gain === 0, `${v.name} is silent at rest: ${at(v.quiet).gain}`);
      assert.ok(at(v.loud).gain > 0.05, `${v.name} is audible at full scale: ${at(v.loud).gain}`);
      assert.ok(Math.abs(at(v.over).gain - v.maxGain) < 1e-9, `${v.name} gain is capped: ${at(v.over).gain} vs ${v.maxGain}`);
      assert.ok([0, 0.1, 1, 10, 1e6].every((x) => at(x).gain <= v.maxGain + 1e-9),
        `${v.name} gain never exceeds its cap: a gain escaped its cap`);
      assert.ok(at(v.loud * 0.25).gain < at(v.loud * 0.75).gain
        && at(v.loud * 0.25).frequency < at(v.loud * 0.75).frequency,
      `${v.name} rises with its input: not monotone in gain and pitch`);
      assert.ok(at(-v.loud).gain === at(v.loud).gain,
        `${v.name} treats a negative input by magnitude: ${at(-v.loud).gain} vs ${at(v.loud).gain}`);
      assert.ok([0, v.loud, v.over, -v.over].every((x) => {
        const f = at(x).frequency;
        return f >= m.AUDIBLE_HZ.min && f <= m.AUDIBLE_HZ.max;
      }), `${v.name} frequency stays audible: a frequency left the audible band`);
      for (const bad of HOSTILE) {
        const p = at(bad);
        assert.ok(p.gain === 0 && Number.isFinite(p.frequency), `${v.name}(${show(bad)}) is silent and finite: ${JSON.stringify(p)}`);
      }
    });
  }

  it('flow bed: two inputs, so the cross terms too', () => {
    const still = m.flowNoiseParams(0, 0);
    const fast = m.flowNoiseParams(m.FLOW_NOISE.flowFullMps, 1);
    const fastNoLoad = m.flowNoiseParams(m.FLOW_NOISE.flowFullMps, 0);
    assert.ok(still.gain === 0, `flow bed is silent with no flow: ${still.gain}`);
    assert.ok(fast.gain > 0.05, `flow bed is audible at full flow and load: ${fast.gain}`);
    assert.ok(fast.gain <= m.FLOW_NOISE.maxGain + 1e-9, `flow bed gain is capped: ${fast.gain} vs ${m.FLOW_NOISE.maxGain}`);
    assert.ok(fastNoLoad.gain > 0 && fastNoLoad.gain < fast.gain,
      `flow with no load is quieter than flow under load: ${fastNoLoad.gain} vs ${fast.gain}`);
    assert.ok(m.flowNoiseParams(0.5, 1).frequency < m.flowNoiseParams(3, 1).frequency,
      'flow sweeps the filter upward: the bandpass does not follow flow');
    assert.ok(Number.isFinite(fast.q) && fast.q > 0, `flow Q is positive and finite: ${fast.q}`);
    for (const bad of HOSTILE) {
      const p = m.flowNoiseParams(bad, bad);
      assert.ok(p.gain === 0 && Number.isFinite(p.frequency) && Number.isFinite(p.q),
        `flow bed(${show(bad)}) is silent and finite: ${JSON.stringify(p)}`);
    }
  });
});

describe('3. sparks', () => {
  for (const kind of ['kelvin', 'vdg']) {
    it(`${kind} cue`, () => {
      const cue = m.sparkCue(kind, 1);
      assert.ok(cue.gain > 0 && cue.gain <= m.SPARK.maxGain + 1e-9, `${kind} cue is audible: ${cue.gain}`);
      assert.ok(cue.frequency >= m.AUDIBLE_HZ.min && cue.frequency <= m.AUDIBLE_HZ.max,
        `${kind} cue frequency is audible: ${cue.frequency}`);
      assert.ok(cue.durationS > 0 && cue.durationS < 0.25, `${kind} cue is short: ${cue.durationS}`);
      assert.ok(cue.kind === kind, `${kind} cue names its kind: ${cue.kind}`);
    });
  }

  it('cue pitch and strength', () => {
    assert.ok(m.sparkCue('vdg').frequency < m.sparkCue('kelvin').frequency,
      `a VDG spark reads lower than a Kelvin spark: ${m.sparkCue('vdg').frequency} vs ${m.sparkCue('kelvin').frequency}`);
    assert.ok(m.sparkCue('kelvin', 0).gain > 0, `a weak spark still clicks: ${m.sparkCue('kelvin', 0).gain}`);
    assert.ok(m.sparkCue('kelvin', 99).gain === m.sparkCue('kelvin', 1).gain
      && m.sparkCue('kelvin', -99).gain === m.sparkCue('kelvin', 0).gain,
    'spark strength is clamped: strength escaped 0..1');
  });

  it('invalid strength degrades to the floor, never to full scale', () => {
    // Invalid strength must degrade to the *floor*, never to full scale: a NaN
    // voltage ratio turning into a full-volume click is the unkind failure.
    const floorGain = m.sparkCue('kelvin', 0).gain;
    for (const bad of HOSTILE) {
      const cue = m.sparkCue('kelvin', bad);
      assert.ok(Number.isFinite(cue.gain) && cue.gain <= m.SPARK.maxGain + 1e-9 && Number.isFinite(cue.frequency),
        `spark cue(strength=${show(bad)}) is finite and capped: ${JSON.stringify(cue)}`);
      assert.ok(Math.abs(cue.gain - floorGain) < 1e-9,
        `spark cue(strength=${show(bad)}) falls back to the floor, not full scale: gain ${cue.gain} vs floor ${floorGain} (full scale is ${m.sparkCue('kelvin', 1).gain})`);
    }
    assert.ok(floorGain > 0 && floorGain < m.sparkCue('kelvin', 1).gain * 0.6,
      `the spark floor is well below full scale: floor ${floorGain}, full ${m.sparkCue('kelvin', 1).gain}`);
  });

  it('Kelvin edge detection', () => {
    // Kelvin: the plant sets a countdown at breakdown, so a rise is the event.
    assert.ok(m.kelvinSparkFired(0, 0.18) === true, 'Kelvin spark fires on the rising edge: a fresh breakdown did not fire');
    assert.ok(m.kelvinSparkFired(0.18, 0.12) === false,
      'Kelvin spark does not fire while the timer runs down: a decaying timer fired again');
    assert.ok(m.kelvinSparkFired(0, 0) === false, 'Kelvin spark does not fire at rest: silence fired a spark');
    assert.ok(m.kelvinSparkFired(0.05, 0.18) === true,
      'Kelvin spark retriggers on a second breakdown: a breakdown during the previous spark was missed');
    assert.ok(m.kelvinSparkFired(Number.NaN, Number.NaN) === false
      && m.kelvinSparkFired(undefined, undefined) === false,
    'Kelvin edge detection is NaN-safe: NaN timers fired a spark');
  });

  it('VDG rate → click interval', () => {
    // VDG: a rate, so intervals.
    assert.ok(m.vdgClickIntervalS(0) === Infinity, `VDG silence means no clicks: ${m.vdgClickIntervalS(0)}`);
    assert.ok(Math.abs(m.vdgClickIntervalS(2) - 0.5) < 1e-9, `VDG 2 Hz → 0.5 s: ${m.vdgClickIntervalS(2)}`);
    assert.ok(m.vdgClickIntervalS(1) > m.vdgClickIntervalS(5), 'VDG interval shortens as the rate rises: interval is not monotone');
    assert.ok(m.vdgClickIntervalS(10_000) === m.SPARK.minIntervalS, `VDG interval has a floor: ${m.vdgClickIntervalS(10_000)}`);
    assert.ok(m.vdgClickIntervalS(-3) === Infinity, `a negative VDG rate means no clicks: ${m.vdgClickIntervalS(-3)}`);
    for (const bad of HOSTILE) {
      const iv = m.vdgClickIntervalS(bad);
      assert.ok(iv === Infinity || (iv >= m.SPARK.minIntervalS && Number.isFinite(iv)),
        `VDG interval(${show(bad)}) is Infinity or bounded: ${iv}`);
    }
  });
});

describe('4. silence policy', () => {
  it('hidden tab, mute and dropped twin silence; a running lab does not', () => {
    assert.ok(m.shouldSilence({}) === false, 'a running lab is not silenced: silenced with no reason');
    assert.ok(m.shouldSilence({ documentHidden: true }) === true, 'a hidden tab is silenced: a background tab kept droning');
    assert.ok(m.shouldSilence({ muted: true }) === true, 'a mute is silenced: mute did nothing');
    assert.ok(m.shouldSilence({ twinDropped: true }) === true, 'a dropped twin is silenced: a disconnected twin kept its tone');
  });

  it('bus ramp, master gain and compressor', () => {
    assert.ok(m.BUS.rampS > 0 && m.BUS.rampS < 1, `the bus ramps rather than steps: ${m.BUS.rampS}`);
    assert.ok(m.BUS.masterGain > 0 && m.BUS.masterGain <= 0.6, `the master gain leaves headroom: ${m.BUS.masterGain}`);
    assert.ok(m.BUS.compressor.ratio > 1 && m.BUS.compressor.threshold < 0
      && m.BUS.compressor.attack > 0 && m.BUS.compressor.release > 0,
    `the compressor is configured to catch a full lab: ${JSON.stringify(m.BUS.compressor)}`);
  });

  it('every voice at full tilt still leaves the bus under unity', () => {
    // Worst case: every voice at full tilt must still leave the bus under unity.
    const peak = m.SEG_HUM.maxGain + m.COIL_HUM.maxGain + m.FLOW_NOISE.maxGain + m.SPARK.maxGain;
    assert.ok(peak * m.BUS.masterGain < 1,
      `all voices at full × master = ${(peak * m.BUS.masterGain).toFixed(2)}: ${peak} × ${m.BUS.masterGain} = ${peak * m.BUS.masterGain} — the bus can clip before the compressor`);
  });
});

describe('5. opt-in only', () => {
  let audio, parse;
  before(async () => {
    audio = await bundleTs('src/audio/lab-audio.ts');
    parse = audio.parseLabAudioEnabled;
  });

  it('?audio=1 / on / true / yes enable; nothing else does', () => {
    assert.ok(parse(new URLSearchParams('audio=1')) === true, '?audio=1 enables: audio=1 was ignored');
    assert.ok(parse(new URLSearchParams('audio=on')) === true, '?audio=on enables: audio=on was ignored');
    assert.ok(parse(new URLSearchParams('audio=true')) === true && parse(new URLSearchParams('audio=yes')) === true,
      '?audio=true / yes enable: a documented alias was ignored');
    assert.ok(parse(new URLSearchParams('')) === false, 'no query stays silent: default boot enabled audio');
    for (const q of ['audio=0', 'audio=off', 'audio=false', 'audio=', 'audio=maybe', 'renderer=webgl2']) {
      assert.ok(parse(new URLSearchParams(q)) === false, `?${q} stays silent: ${q} enabled audio`);
    }
  });

  it('a disabled LabAudio touches nothing; an enabled one waits for a gesture', async () => {
    // A disabled LabAudio must construct without touching AudioContext, timers,
    // window or the hub — that is what makes default boot silent rather than quiet.
    let subscribed = false;
    let contextBuilt = false;
    const off = new audio.LabAudio({
      enabled: false,
      subscribe: () => { subscribed = true; return () => {}; },
      contextFactory: () => { contextBuilt = true; throw new Error('should not be called'); }
    });
    assert.ok(subscribed === false, 'a disabled LabAudio subscribes to nothing: it subscribed anyway');
    assert.ok(contextBuilt === false, 'a disabled LabAudio opens no AudioContext: it built a context');
    assert.ok(off.muted === true && off.started === false,
      `a disabled LabAudio starts muted and unstarted: muted=${off.muted} started=${off.started}`);
    await off.start();
    assert.ok(off.started === false && contextBuilt === false, 'start() on a disabled LabAudio is a no-op: a disabled instance started');
    off.destroy();

    // An *enabled* instance still opens nothing until a gesture arrives.
    const armed = new audio.LabAudio({
      enabled: true,
      subscribe: () => () => {},
      contextFactory: () => { contextBuilt = true; throw new Error('no AudioContext in Node'); }
    });
    assert.ok(armed.started === false && armed.muted === true && contextBuilt === false,
      `an enabled LabAudio waits for a gesture: started=${armed.started} contextBuilt=${contextBuilt}`);
    // The factory throws on purpose; muffle the expected warning so it doesn't
    // read as a CI failure.
    const warn = console.warn;
    console.warn = () => {};
    try {
      await armed.start();
    } finally {
      console.warn = warn;
    }
    assert.ok(contextBuilt === true && armed.started === false,
      `a failed AudioContext leaves it silent, not broken: contextBuilt=${contextBuilt} started=${armed.started}`);
    armed.destroy();
  });
});

describe('6. no sample pack, no audio library, complete badge', () => {
  it('lab-audio.ts synthesises, loads no media, and handles visibility / gesture / twin', () => {
    const audioSrc = read('src/audio/lab-audio.ts');
    assert.ok(/createBuffer\(/.test(audioSrc) && /Math\.random\(\)/.test(audioSrc),
      'the noise bed is generated, not loaded: lab-audio.ts no longer synthesises its own noise');
    assert.ok(!/decodeAudioData|\.wav|\.mp3|\.ogg/.test(audioSrc), 'no decodeAudioData / fetch of media: lab-audio.ts loads an audio file');
    assert.ok(/visibilitychange/.test(audioSrc),
      'visibilitychange is handled: no visibilitychange handler — a background tab could drone');
    assert.ok(/pointerdown|keydown/.test(audioSrc),
      'a gesture is required before the context opens: lab-audio.ts opens an AudioContext without a gesture');
    assert.ok(/hardwareTwin\?\.connected/.test(audioSrc), 'a dropped twin mutes: lab-audio.ts does not watch the twin');
  });

  it('no audio library dependency', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const banned = ['tone', 'howler', 'pizzicato', 'wad', 'soundjs'];
    const found = banned.filter((d) => d in deps);
    assert.ok(found.length === 0, `found ${found.join(', ')}`);
  });

  it('no audio files are shipped', () => {
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
    assert.ok(media.length === 0, `found ${media.map((f) => f.replace(ROOT, '')).join(', ')}`);
  });

  it('badge state and labels', async () => {
    const badge = await bundleTs('src/audio/lab-audio-badge.ts');
    const states = [
      [{ started: false, muted: true }, 'waiting'],
      [{ started: false, muted: false }, 'waiting'],
      [{ started: true, muted: true }, 'muted'],
      [{ started: true, muted: false }, 'on']
    ];
    for (const [input, expected] of states) {
      assert.ok(badge.labAudioBadgeState(input) === expected,
        `badge ${JSON.stringify(input)} → ${expected}: ${badge.labAudioBadgeState(input)}`);
    }
    const badgeSrc = read('src/audio/lab-audio-badge.ts');
    for (const state of ['waiting', 'on', 'muted']) {
      assert.ok(new RegExp(`\\n\\s*${state}: '`).test(badgeSrc), `badge labels "${state}": no LABELS entry for ${state}`);
    }
  });
});
