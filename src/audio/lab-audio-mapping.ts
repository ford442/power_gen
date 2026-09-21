/**
 * Telemetry → audio parameter mapping for the lab sonification (#203 WS D).
 *
 * Deliberately separate from the Web Audio graph and dependency-free, for two
 * reasons: the mapping is the part that can be *wrong* (a NaN reaching a
 * `frequency` value throws, a runaway gain is a loud surprise in a classroom),
 * and it is the only part Node can check. `scripts/test-lab-audio.mjs` runs
 * every function here over sane, absurd and hostile inputs.
 *
 * House rules for everything in this file:
 *   - clamp both ends, always;
 *   - NaN / Infinity / undefined behave as silence, never as a default tone;
 *   - gains are 0..1 *before* the bus gain, so one voice cannot dominate;
 *   - frequencies stay inside {@link AUDIBLE_HZ}, so nothing lands on DC or
 *     above a typical Nyquist.
 *
 * This is sonification, not synthesis of a recording: nothing here claims a
 * real coil sounds like this. It maps a number the dashboard already shows onto
 * a pitch or a level so the bench reads as *occupied*.
 */

/** Hard frequency bounds for every voice. */
export const AUDIBLE_HZ = Object.freeze({ min: 30, max: 8000 });

/** SEG rotor hum: `segOmega` → a low drone whose level follows RPM. */
export const SEG_HUM = Object.freeze({
  /** segOmega at which the hum reaches full level. */
  omegaFull: 8,
  baseHz: 48,
  /** Hz added at full omega — about a fifth up, so spin-up is audible. */
  spanHz: 34,
  maxGain: 0.5
});

/** Pulse-coil hum: discharge current → a pitched buzz. */
export const COIL_HUM = Object.freeze({
  /** |I| mapped to full pitch/level (matches the slice's current scale). */
  currentFullA: 80,
  baseHz: 90,
  spanHz: 220,
  maxGain: 0.6
});

/** MHD / Heron flow: a filtered noise bed, not a tone. */
export const FLOW_NOISE = Object.freeze({
  /** Flow speed mapped to the top of the filter sweep. */
  flowFullMps: 3,
  baseHz: 260,
  spanHz: 900,
  q: 1.1,
  maxGain: 0.28
});

/** Spark click: a short filtered noise burst. */
export const SPARK = Object.freeze({
  /** Envelope length. Long enough to hear, short enough not to smear. */
  durationS: 0.055,
  attackS: 0.002,
  /** Bandpass centre for a Kelvin dropper's small gap. */
  kelvinHz: 2600,
  /** A Van de Graaff's bigger gap reads lower and fuller. */
  vdgHz: 1500,
  q: 3.5,
  maxGain: 0.75,
  /** Never fire clicks closer than this, however the telemetry behaves. */
  minIntervalS: 0.03
});

/** Master bus: the compressor keeps a full lab from clipping. */
export const BUS = Object.freeze({
  masterGain: 0.35,
  /** Seconds for a mute / unmute ramp. An instant gain change clicks. */
  rampS: 0.08,
  compressor: { threshold: -18, knee: 6, ratio: 4, attack: 0.004, release: 0.12 }
});

/** NaN-safe finite read. */
export function finite(n: unknown, fallback = 0): number {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

/** 0..1 from a value and its full-scale point. Negative inputs read as 0. */
export function norm01(value: unknown, full: number): number {
  const v = finite(value, 0);
  if (!(full > 0)) return 0;
  return Math.max(0, Math.min(1, v / full));
}

/** Keep a frequency inside {@link AUDIBLE_HZ}; nonsense lands on `min`. */
export function clampHz(hz: unknown): number {
  const v = finite(hz, AUDIBLE_HZ.min);
  return Math.max(AUDIBLE_HZ.min, Math.min(AUDIBLE_HZ.max, v));
}

/** Keep a gain in 0..max. */
export function clampGain(gain: unknown, max = 1): number {
  const v = finite(gain, 0);
  return Math.max(0, Math.min(max, v));
}

export interface VoiceParams {
  frequency: number;
  gain: number;
}

/**
 * SEG rotor drone. `segOmega` is the plant's angular-rate proxy, the same
 * number the RPM readout is derived from, so the pitch tracks what the gauge
 * says rather than a separate animation clock.
 */
export function segHumParams(segOmega: unknown): VoiceParams {
  const t = norm01(Math.abs(finite(segOmega, 0)), SEG_HUM.omegaFull);
  return {
    frequency: clampHz(SEG_HUM.baseHz + SEG_HUM.spanHz * t),
    // Gain grows faster than pitch so a slow rotor is quiet, not just low.
    gain: clampGain(SEG_HUM.maxGain * t * t, SEG_HUM.maxGain)
  };
}

/** Pulse-coil buzz from the displayed discharge current. */
export function coilHumParams(currentA: unknown): VoiceParams {
  const t = norm01(Math.abs(finite(currentA, 0)), COIL_HUM.currentFullA);
  return {
    frequency: clampHz(COIL_HUM.baseHz + COIL_HUM.spanHz * t),
    gain: clampGain(COIL_HUM.maxGain * t, COIL_HUM.maxGain)
  };
}

export interface FlowParams {
  frequency: number;
  gain: number;
  q: number;
}

/**
 * Flow bed for the MHD channel (and Heron, which shares the idea): flow speed
 * sweeps a bandpass, current sets the level, so a channel with flow but no
 * load is quieter than one doing work.
 */
export function flowNoiseParams(flowMps: unknown, currentA: unknown): FlowParams {
  const f = norm01(Math.abs(finite(flowMps, 0)), FLOW_NOISE.flowFullMps);
  const i = norm01(Math.abs(finite(currentA, 0)), 1);
  return {
    frequency: clampHz(FLOW_NOISE.baseHz + FLOW_NOISE.spanHz * f),
    gain: clampGain(FLOW_NOISE.maxGain * f * (0.45 + 0.55 * i), FLOW_NOISE.maxGain),
    q: FLOW_NOISE.q
  };
}

export type SparkKind = 'kelvin' | 'vdg';

export interface SparkCue {
  kind: SparkKind;
  frequency: number;
  gain: number;
  durationS: number;
}

/**
 * Bandpass centre + level for one click. `strength` 0..1 scales the level.
 *
 * Invalid strength falls back to **0**, not 1: turning a NaN voltage ratio into a
 * full-scale click is the wrong failure direction for the one bug in this feature
 * that is actually unkind. The event itself is real — an edge was detected — so
 * the click still fires at the gain floor rather than vanishing; only the unknown
 * *strength* degrades.
 *
 * Note `strength?:` with no default value rather than `= 1`: a default parameter
 * would intercept `undefined` before {@link finite} ever saw it, so a missing
 * strength would read as full scale — which is exactly the case this guards.
 */
export function sparkCue(kind: SparkKind, strength?: unknown): SparkCue {
  const s = Math.max(0, Math.min(1, finite(strength, 0)));
  return {
    kind,
    frequency: clampHz(kind === 'vdg' ? SPARK.vdgHz : SPARK.kelvinHz),
    // A floor, so a weak breakdown still clicks instead of vanishing.
    gain: clampGain(SPARK.maxGain * (0.35 + 0.65 * s), SPARK.maxGain),
    durationS: SPARK.durationS
  };
}

/**
 * Kelvin dropper: a spark is an **event**, and `kelvinSparkTimer` is a
 * countdown the plant sets at breakdown, so a rising edge is the spark.
 * (`> prev` rather than `prev <= 0` because a second breakdown can retrigger
 * while the previous timer is still running down.)
 */
export function kelvinSparkFired(prevTimer: unknown, nextTimer: unknown): boolean {
  const prev = finite(prevTimer, 0);
  const next = finite(nextTimer, 0);
  return next > 0 && next > prev;
}

/**
 * Van de Graaff: the hub publishes `vdgSparkHz`, a **rate** averaged over a 1 s
 * window, not an event — so clicks are scheduled at 1/Hz instead of edge-
 * detected. That is arguably the better behaviour for audio anyway: the click
 * rate is decoupled from the frame rate, so a 30 fps tab and a 144 Hz one sound
 * the same.
 *
 * @returns seconds until the next click, or `Infinity` when nothing is sparking
 */
export function vdgClickIntervalS(sparkHz: unknown): number {
  const hz = finite(sparkHz, 0);
  if (!(hz > 0)) return Infinity;
  return Math.max(SPARK.minIntervalS, 1 / hz);
}

/**
 * Connection states that should leave the lab silent rather than droning: a
 * hidden tab, and a hardware twin that has gone away.
 */
export function shouldSilence(opts: {
  documentHidden?: boolean;
  muted?: boolean;
  /** Twin went from a live link to disconnected/error since the last frame. */
  twinDropped?: boolean;
}): boolean {
  return !!(opts.documentHidden || opts.muted || opts.twinDropped);
}
