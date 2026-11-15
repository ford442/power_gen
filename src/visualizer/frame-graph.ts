/**
 * A small typed frame graph for the WebGPU post stack (#225 PR2). Not an
 * engine and not a library (ADR-0003): passes are declared in execution
 * order, each says which named resources it reads and writes, and the graph
 *
 *   - checks order: a read with no earlier writer this frame (and no
 *     `imported` declaration) throws in strict (dev) builds and skips the pass
 *     with a one-time warning otherwise — never a silently black frame;
 *   - owns lifetimes: a resource with a `lifetime` is allocated the first frame
 *     an enabled pass touches it and released after `releaseAfterFrames`
 *     frames without one, so MSAA / SSR / TAA targets only exist while a tier
 *     and view that uses them is active;
 *   - labels: one debug group per pass on the frame encoder;
 *   - times: hands each pass pass-boundary `timestampWrites` from one query
 *     set when `?gpuTiming=1` is on, and reports which slot is which pass.
 *
 * The graph does not create textures, bind groups or GPU passes itself: the
 * host's lifetime callbacks allocate, and each pass's `encode` records the
 * GPU work it always did. Pure TypeScript with no DOM or GPU globals, so
 * scripts/tests/frame-graph.test.mjs runs it under Node with a mock encoder.
 * See docs/WEBGPU.md → Frame graph.
 */

/** A lazily allocated target (or group of targets sharing one allocation). */
export interface ResourceLifetime {
  /** Diagnostics name (`getRendererInfo().frameGraph.allocated`). */
  readonly name: string;
  isAllocated(): boolean;
  /** Allocate, and rebind whatever samples it. Only called when not allocated. */
  ensure(): void;
  /** Destroy, and rebind dependants to placeholders. Only called when allocated. */
  release(): void;
}

export interface ResourceDecl {
  /**
   * Valid at the start of the frame without a writer this frame — persistent
   * history, or a target an earlier frame filled.
   */
  imported?: boolean;
  /** Shared by every resource in one allocation (e.g. the MSAA set). */
  lifetime?: ResourceLifetime;
}

type NameList<C> = readonly string[] | ((ctx: C) => readonly string[]);

/** Per-pass helpers handed to `encode`. */
export interface PassResources {
  /**
   * `timestampWrites` for this pass, or `undefined` when timing is off.
   * `'both'` for a pass that records one GPU pass; a pass that records
   * several asks `'begin'` on its first and `'end'` on its last.
   */
  timestamps(edge: 'begin' | 'end' | 'both'): GPURenderPassTimestampWrites | undefined;
}

export interface FramePassDecl<C> {
  reads?: NameList<C>;
  writes?: NameList<C>;
  /** Gate. Omitted = always on. Evaluated once per frame, before any encode. */
  enabled?: (ctx: C) => boolean;
  /**
   * Record the pass. Return `false` when it bailed without writing anything;
   * its writes then do not count, and a later reader fails the order check.
   */
  encode: (encoder: GPUCommandEncoder, res: PassResources, ctx: C) => void | boolean;
}

/** Where pass timestamps go: one query set, two queries per timed pass. */
export interface TimestampTarget {
  querySet: GPUQuerySet;
  /** Queries available; pass `i` uses `2i` (begin) and `2i + 1` (end). */
  queryCount: number;
}

export interface FrameGraphReport {
  /** Passes that encoded, in order. */
  ran: string[];
  /** Pass name per timestamp slot; only passes that wrote both edges. */
  timedPasses: Array<{ name: string; slot: number }>;
  /** Highest query index written + 1 (what to resolve). */
  queriesUsed: number;
  /** Lifetimes allocated / released while preparing this frame. */
  allocated: string[];
  released: string[];
}

export interface FrameGraphOptions {
  label: string;
  /** Throw on an order error (dev). Otherwise warn once per pass/resource and skip the pass. */
  strict: boolean;
  /** Frames a lifetime may go untouched before it is released. */
  releaseAfterFrames?: number;
  warn?: (message: string) => void;
}

export class FrameGraphOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameGraphOrderError';
  }
}

interface PassEntry<C> extends FramePassDecl<C> {
  name: string;
}

function evalNames<C>(list: NameList<C> | undefined, ctx: C): readonly string[] {
  if (!list) return [];
  return typeof list === 'function' ? list(ctx) : list;
}

export class FrameGraph<C> {
  readonly label: string;
  private readonly strict: boolean;
  private readonly releaseAfter: number;
  private readonly warnFn: (message: string) => void;
  private readonly resources = new Map<string, ResourceDecl>();
  private readonly passes: Array<PassEntry<C>> = [];
  private readonly lastUsed = new Map<ResourceLifetime, number>();
  private readonly warned = new Set<string>();
  private frame = 0;

  constructor(opts: FrameGraphOptions) {
    this.label = opts.label;
    this.strict = opts.strict;
    this.releaseAfter = Math.max(0, opts.releaseAfterFrames ?? 0);
    this.warnFn = opts.warn ?? ((m) => console.warn(m));
  }

  addResource(name: string, decl: ResourceDecl = {}): this {
    if (this.resources.has(name)) throw new Error(`[frame-graph] resource '${name}' declared twice`);
    this.resources.set(name, decl);
    return this;
  }

  addPass(name: string, decl: FramePassDecl<C>): this {
    if (this.passes.some((p) => p.name === name)) {
      throw new Error(`[frame-graph] pass '${name}' declared twice`);
    }
    this.passes.push({ name, ...decl });
    return this;
  }

  /** Pass names in declaration (= execution) order. */
  passNames(): string[] {
    return this.passes.map((p) => p.name);
  }

  /** Every distinct lifetime, for diagnostics and bulk release. */
  lifetimes(): ResourceLifetime[] {
    const out = new Set<ResourceLifetime>();
    for (const decl of this.resources.values()) if (decl.lifetime) out.add(decl.lifetime);
    return [...out];
  }

  /** Names of the lifetimes currently allocated. */
  allocatedLifetimes(): string[] {
    return this.lifetimes().filter((l) => l.isAllocated()).map((l) => l.name);
  }

  /** Release everything (resize, device loss). The next frame reallocates what it needs. */
  releaseAll(): void {
    for (const l of this.lifetimes()) if (l.isAllocated()) l.release();
    this.lastUsed.clear();
  }

  private resource(name: string, pass: string): ResourceDecl {
    const decl = this.resources.get(name);
    if (!decl) throw new Error(`[frame-graph] pass '${pass}' names undeclared resource '${name}'`);
    return decl;
  }

  private orderError(pass: string, resource: string): void {
    const msg = `[frame-graph] ${this.label}: pass '${pass}' reads '${resource}', `
      + 'which no earlier enabled pass wrote this frame';
    if (this.strict) throw new FrameGraphOrderError(msg);
    const key = `${pass}:${resource}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnFn(`${msg} — skipping the pass`);
  }

  /**
   * Encode one frame. Lifetimes are settled before the first pass encodes, so
   * every bind group a pass picks already points at live textures.
   */
  execute(encoder: GPUCommandEncoder, ctx: C, timing: TimestampTarget | null = null): FrameGraphReport {
    this.frame++;
    const enabled = this.passes.filter((p) => (p.enabled ? p.enabled(ctx) : true));

    // ── Lifetimes ────────────────────────────────────────────────────────
    const touched = new Set<ResourceLifetime>();
    for (const p of enabled) {
      for (const name of [...evalNames(p.reads, ctx), ...evalNames(p.writes, ctx)]) {
        const l = this.resource(name, p.name).lifetime;
        if (l) touched.add(l);
      }
    }
    const allocated: string[] = [];
    const released: string[] = [];
    for (const l of touched) {
      this.lastUsed.set(l, this.frame);
      if (!l.isAllocated()) {
        l.ensure();
        allocated.push(l.name);
      }
    }
    for (const l of this.lifetimes()) {
      if (touched.has(l) || !l.isAllocated()) continue;
      const last = this.lastUsed.get(l);
      // Allocated outside the graph (never touched by it): start the clock now.
      if (last === undefined) { this.lastUsed.set(l, this.frame); continue; }
      if (this.frame - last > this.releaseAfter) {
        l.release();
        this.lastUsed.delete(l);
        released.push(l.name);
      }
    }

    // ── Encode in order ──────────────────────────────────────────────────
    const written = new Set<string>();
    for (const [name, decl] of this.resources) if (decl.imported) written.add(name);

    const ran: string[] = [];
    const timedPasses: Array<{ name: string; slot: number }> = [];
    let queriesUsed = 0;
    let nextSlot = 0;
    const slots = timing ? Math.floor(timing.queryCount / 2) : 0;

    for (const p of enabled) {
      const reads = evalNames(p.reads, ctx);
      const missing = reads.find((r) => (this.resource(r, p.name), !written.has(r)));
      if (missing !== undefined) {
        this.orderError(p.name, missing);
        continue;
      }

      let slot = -1;
      let wroteBegin = false;
      let wroteEnd = false;
      const res: PassResources = {
        timestamps: (edge) => {
          if (!timing) return undefined;
          if (slot < 0) {
            if (nextSlot >= slots) return undefined;
            slot = nextSlot++;
          }
          const out: GPURenderPassTimestampWrites = { querySet: timing.querySet };
          if (edge !== 'end') { out.beginningOfPassWriteIndex = 2 * slot; wroteBegin = true; }
          if (edge !== 'begin') { out.endOfPassWriteIndex = 2 * slot + 1; wroteEnd = true; }
          return out;
        }
      };

      encoder.pushDebugGroup(p.name);
      const result = p.encode(encoder, res, ctx);
      encoder.popDebugGroup();

      if (slot >= 0 && wroteBegin && wroteEnd) {
        timedPasses.push({ name: p.name, slot });
        queriesUsed = Math.max(queriesUsed, 2 * slot + 2);
      }
      if (result === false) continue;
      ran.push(p.name);
      for (const w of evalNames(p.writes, ctx)) {
        this.resource(w, p.name);
        written.add(w);
      }
    }

    return { ran, timedPasses, queriesUsed, allocated, released };
  }
}
