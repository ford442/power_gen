/**
 * Lab sonification — a small Web Audio graph driven by catalog telemetry
 * (#203 WS D).
 *
 * Sparks, coil ticks and MHD flow had no audio at all. A lab you can watch but
 * not hear reads as a diagram; a few honest cues make it read as *occupied*.
 *
 * The whole thing is oscillators, one procedurally generated noise buffer, three
 * filters and a compressor — no Tone.js, no Howler, and **no WAV files**. A
 * sample pack would be the single largest asset in the repo for a bench that
 * does not need recordings; a saw through a bandpass is both smaller and more
 * honest, because the pitch is a telemetry number and not a performance.
 *
 * ```
 *   saw osc ─ bandpass ─┐                          (SEG rotor: segOmega)
 *   saw osc ─ lowpass  ─┤
 *   noise   ─ bandpass ─┼─ busGain ─ compressor ─ destination
 *   noise   ─ bandpass ─┘                          (spark clicks, one-shot)
 * ```
 *
 * Rules this file exists to keep:
 *
 * - **Silent by default.** Nothing is constructed until `?audio=1`, and even
 *   then the `AudioContext` waits for a real user gesture — browsers require one
 *   and autoplaying a lab at someone is rude regardless.
 * - **A hidden tab makes no sound.** `visibilitychange` suspends the context, so
 *   a backgrounded lab cannot drone. `pagehide` does the same.
 * - **A twin that disconnects goes quiet**, rather than holding the last coil
 *   tone forever.
 * - **One mute switch** that ramps rather than clicks, and that the header badge
 *   reflects.
 *
 * Mapping (the part that can be wrong) lives in `./lab-audio-mapping.ts` and is
 * checked by `npm run test:audio`.
 */
import {
  BUS,
  FLOW_NOISE,
  SPARK,
  coilHumParams,
  flowNoiseParams,
  kelvinSparkFired,
  segHumParams,
  sparkCue,
  vdgClickIntervalS,
  type SparkKind
} from './lab-audio-mapping';
import { telemetryHub } from '../telemetry-hub';
import type { TelemetrySnapshot } from '../telemetry/types';

/** Seconds of white noise generated once and reused by every noise voice. */
const NOISE_SECONDS = 1;

export interface LabAudioOptions {
  enabled?: boolean;
  /** Start unmuted once a gesture arrives. Default true (that's what ?audio=1 asks for). */
  startUnmuted?: boolean;
  subscribe?: (fn: (snap: TelemetrySnapshot) => void) => () => void;
  /** Test seam. */
  contextFactory?: () => AudioContext;
}

type Voice = {
  osc: OscillatorNode | AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
};

/** `?audio=1` (aliases on / true / yes). Silent unless explicitly asked for. */
export function parseLabAudioEnabled(
  params: URLSearchParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
): boolean {
  const raw = (params.get('audio') ?? '').toLowerCase();
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes';
}

export class LabAudio {
  readonly enabled: boolean;
  /** True once a user gesture has let us build the context. */
  started = false;
  /** User-facing switch. Starts muted until the first gesture unmutes it. */
  muted = true;

  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noise: AudioBuffer | null = null;
  private segHum: Voice | null = null;
  private coilHum: Voice | null = null;
  private flow: Voice | null = null;

  private readonly contextFactory: () => AudioContext;
  private readonly startUnmuted: boolean;
  private unsubscribe: (() => void) | null = null;
  private teardown: Array<() => void> = [];

  /** Last frame's values, for edge detection. */
  private prevKelvinSparkTimer = 0;
  private prevTwinConnected = false;
  private nextVdgClickAt = 0;
  private lastSparkAt = -Infinity;
  private latest: TelemetrySnapshot | null = null;

  constructor(opts: LabAudioOptions = {}) {
    this.enabled = opts.enabled ?? parseLabAudioEnabled();
    this.startUnmuted = opts.startUnmuted !== false;
    this.contextFactory = opts.contextFactory ?? (() => new AudioContext());
    if (!this.enabled) return;

    const subscribe = opts.subscribe ?? ((fn) => telemetryHub.subscribe(fn));
    this.unsubscribe = subscribe((snap) => this.onSnapshot(snap));
    this.armGesture();
    this.watchVisibility();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Browsers refuse to start an `AudioContext` without a user gesture, so listen
   * once for the first pointer/key event and build the graph then. This is also
   * why default boot is genuinely silent and not merely quiet.
   */
  private armGesture(): void {
    if (typeof window === 'undefined') return;
    const onGesture = () => {
      void this.start();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(ev, onGesture, { once: true, passive: true });
      this.teardown.push(() => window.removeEventListener(ev, onGesture));
    }
  }

  private watchVisibility(): void {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.hidden) void this.suspend();
      else if (!this.muted) void this.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.teardown.push(() => document.removeEventListener('visibilitychange', onVisibility));

    if (typeof window !== 'undefined') {
      const onHide = () => { void this.suspend(); };
      window.addEventListener('pagehide', onHide);
      this.teardown.push(() => window.removeEventListener('pagehide', onHide));
    }
  }

  /** Build the graph and (unless told otherwise) unmute. Idempotent. */
  async start(): Promise<void> {
    if (!this.enabled || this.started) return;
    try {
      this.ctx = this.contextFactory();
    } catch (err) {
      console.warn('[labAudio] AudioContext unavailable — staying silent', err);
      return;
    }
    this.buildGraph();
    this.started = true;
    if (this.startUnmuted) this.setMuted(false);
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* gesture wasn't enough — stay silent */ }
    }
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.compressor = ctx.createDynamicsCompressor();
    const c = BUS.compressor;
    this.compressor.threshold.value = c.threshold;
    this.compressor.knee.value = c.knee;
    this.compressor.ratio.value = c.ratio;
    this.compressor.attack.value = c.attack;
    this.compressor.release.value = c.release;
    this.compressor.connect(ctx.destination);

    this.bus = ctx.createGain();
    // Starts at zero: `setMuted(false)` ramps it up, so nothing ever clicks on.
    this.bus.gain.value = 0;
    this.bus.connect(this.compressor);

    this.noise = this.makeNoiseBuffer(ctx);

    this.segHum = this.makeToneVoice(ctx, 'sawtooth', 'bandpass', 1.4);
    this.coilHum = this.makeToneVoice(ctx, 'sawtooth', 'lowpass', 0.8);
    this.flow = this.makeNoiseVoice(ctx, FLOW_NOISE.q);
  }

  /** One second of white noise, generated — this is why there is no sample pack. */
  private makeNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
    const frames = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private makeToneVoice(
    ctx: AudioContext,
    type: OscillatorType,
    filterType: BiquadFilterType,
    q: number
  ): Voice {
    const osc = ctx.createOscillator();
    osc.type = type;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(this.bus!);
    osc.start();
    return { osc, filter, gain };
  }

  private makeNoiseVoice(ctx: AudioContext, q: number): Voice {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.bus!);
    src.start();
    return { osc: src, filter, gain };
  }

  // ── Mute / suspend ───────────────────────────────────────────────────────

  setMuted(muted: boolean): void {
    this.muted = muted;
    const bus = this.bus;
    const ctx = this.ctx;
    if (!bus || !ctx) return;
    const target = muted ? 0 : BUS.masterGain;
    // Ramp, never a step: a step on the master bus is an audible click.
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setValueAtTime(bus.gain.value, ctx.currentTime);
    bus.gain.linearRampToValueAtTime(target, ctx.currentTime + BUS.rampS);
    if (muted) {
      // Suspending immediately stops processing before the ramp renders, which
      // turns a deliberate 80 ms fade into the click it exists to avoid. Wait
      // out the ramp, and abandon the suspend if the user unmutes (or the graph
      // is rebuilt) in the meantime.
      const context = ctx;
      setTimeout(() => {
        if (this.muted && this.ctx === context) void this.suspend();
      }, BUS.rampS * 1000);
    } else {
      void this.resume();
    }
  }

  /**
   * Flip the mute. Before the first gesture there is no graph yet, so this
   * *starts* it instead — the click that reached the badge is itself the gesture.
   */
  toggleMuted(): boolean {
    if (!this.started) {
      void this.start();
      return this.muted;
    }
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Stop making sound now: a hidden tab, a dropped twin, or an explicit mute. */
  async suspend(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed' || ctx.state === 'suspended') return;
    try { await ctx.suspend(); } catch { /* already gone */ }
  }

  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'suspended') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    try { await ctx.resume(); } catch { /* needs another gesture */ }
  }

  // ── Telemetry ────────────────────────────────────────────────────────────

  private onSnapshot(snap: TelemetrySnapshot): void {
    this.latest = snap;

    // A twin that goes away should not leave its coil tone hanging.
    const twinConnected = !!snap.hardwareTwin?.connected;
    if (this.prevTwinConnected && !twinConnected) {
      this.setMuted(true);
      console.info('[labAudio] twin disconnected — muted');
    }
    this.prevTwinConnected = twinConnected;

    if (!this.started || this.muted) {
      // Keep the edge detectors current so unmuting does not fire a stale spark.
      this.prevKelvinSparkTimer = snap.devices?.kelvin?.kelvinSparkTimer ?? 0;
      return;
    }

    this.applyContinuous(snap);
    this.applySparks(snap);
  }

  /** Drones and the flow bed: one `setTargetAtTime` per voice per frame. */
  private applyContinuous(snap: TelemetrySnapshot): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // ~30 ms smoothing: fast enough to track a discharge, slow enough not to zip.
    const tau = 0.03;

    const seg = segHumParams(snap.seg?.segOmega ?? snap.devices?.seg?.segOmega);
    if (this.segHum) {
      this.segHum.filter.frequency.setTargetAtTime(seg.frequency * 2, t, tau);
      (this.segHum.osc as OscillatorNode).frequency.setTargetAtTime(seg.frequency, t, tau);
      this.segHum.gain.gain.setTargetAtTime(seg.gain, t, tau);
    }

    const coil = coilHumParams(snap.devices?.['pulse-coil']?.pulseCoilCurrentA);
    if (this.coilHum) {
      (this.coilHum.osc as OscillatorNode).frequency.setTargetAtTime(coil.frequency, t, tau);
      this.coilHum.filter.frequency.setTargetAtTime(coil.frequency * 3, t, tau);
      this.coilHum.gain.gain.setTargetAtTime(coil.gain, t, tau);
    }

    const mhd = snap.devices?.mhd;
    const flow = flowNoiseParams(mhd?.mhdFlowU, mhd?.mhdCurrent);
    if (this.flow) {
      this.flow.filter.frequency.setTargetAtTime(flow.frequency, t, tau);
      this.flow.filter.Q.value = flow.q;
      this.flow.gain.gain.setTargetAtTime(flow.gain, t, tau);
    }
  }

  private applySparks(snap: TelemetrySnapshot): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // Kelvin: a real event, edge-detected off the plant's countdown.
    const kelvinTimer = snap.devices?.kelvin?.kelvinSparkTimer ?? 0;
    if (kelvinSparkFired(this.prevKelvinSparkTimer, kelvinTimer)) {
      const v = snap.devices?.kelvin;
      const strength = v?.kelvinVbreak ? (v.kelvinV ?? 0) / v.kelvinVbreak : 1;
      this.click(sparkCue('kelvin', strength));
    }
    this.prevKelvinSparkTimer = kelvinTimer;

    // VDG: the hub gives a rate, so schedule instead of edge-detecting.
    const interval = vdgClickIntervalS(snap.devices?.vdg?.vdgSparkHz);
    if (Number.isFinite(interval)) {
      const now = ctx.currentTime;
      if (this.nextVdgClickAt <= 0 || this.nextVdgClickAt > now + interval * 2) {
        this.nextVdgClickAt = now + interval;
      } else if (now >= this.nextVdgClickAt) {
        this.click(sparkCue('vdg', 1));
        this.nextVdgClickAt = now + interval;
      }
    } else {
      this.nextVdgClickAt = 0;
    }
  }

  /**
   * One spark: a short slice of the shared noise buffer through a bandpass and
   * a decay envelope. The source node is single-use, so it is created and let go
   * per click — the graph stays flat and nothing accumulates.
   */
  click(cue: { kind: SparkKind; frequency: number; gain: number; durationS: number }): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus || !this.noise || this.muted) return;
    // A packed lab can request clicks faster than they are distinguishable.
    if (ctx.currentTime - this.lastSparkAt < SPARK.minIntervalS) return;
    this.lastSparkAt = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = cue.frequency;
    filter.Q.value = SPARK.q;
    const env = ctx.createGain();
    const t0 = ctx.currentTime;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(cue.gain, t0 + SPARK.attackS);
    // Exponential to a floor, then a hard zero: ramping to exactly 0
    // exponentially is undefined behaviour in Web Audio.
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + cue.durationS);
    env.gain.setValueAtTime(0, t0 + cue.durationS + 0.001);

    src.connect(filter).connect(env).connect(bus);
    src.start(t0, Math.random() * (NOISE_SECONDS * 0.5));
    src.stop(t0 + cue.durationS + 0.01);
    src.onended = () => {
      try {
        src.disconnect();
        filter.disconnect();
        env.disconnect();
      } catch { /* context already closed */ }
    };
  }

  /** Latest snapshot the audio saw. For the badge / debugging. */
  get snapshot(): TelemetrySnapshot | null {
    return this.latest;
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const off of this.teardown) off();
    this.teardown = [];
    for (const voice of [this.segHum, this.coilHum, this.flow]) {
      try {
        voice?.osc.stop();
        voice?.osc.disconnect();
        voice?.filter.disconnect();
        voice?.gain.disconnect();
      } catch { /* never started */ }
    }
    this.segHum = this.coilHum = this.flow = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.bus = null;
    this.compressor = null;
    this.started = false;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  }
}
