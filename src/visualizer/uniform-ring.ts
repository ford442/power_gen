/**
 * Per-draw uniform slots for the WebGPU scene pass (#225 §3).
 *
 * One `GPUBuffer` of fixed 256-byte slots, bound with `hasDynamicOffset` on
 * every scene layout's per-draw `@group(1) @binding(1)` (DeviceUniforms), and
 * one CPU mirror that the host fills in place. The frame then makes **one**
 * `queue.writeBuffer` covering every slot in use, right before submit.
 *
 * Why slots instead of one shared 48 B buffer: `writeBuffer` lands on the
 * queue timeline before the frame's single submit, so N draws that each wrote
 * their own `renderMode` into the same buffer were all shaded with the last
 * write (#221). A slot per (owner, part) cannot be clobbered by the next part.
 *
 * Why one buffer, not one per frame in flight: `writeBuffer` copies the bytes
 * at call time and is ordered against `submit` on the queue, so frame N+1's
 * write can never be seen by frame N's commands — there is nothing for a
 * second buffer to protect. (A ring of mapped buffers would need one per frame
 * in flight; this uses the queue's own staging instead.)
 *
 * Slots are **stable**: an owner/part pair keeps the same offset for the
 * buffer's lifetime, so a render bundle can record the offset once while the
 * contents change every frame. Owners refresh their slots each frame before
 * encoding; nothing here allocates per draw.
 *
 * Pure TypeScript (no WebGPU globals at module scope) so
 * scripts/tests/uniform-ring.test.mjs runs it under Node with a mock device.
 */

/** Largest legal `minUniformBufferOffsetAlignment`, so any adapter accepts every offset. */
export const UNIFORM_SLOT_BYTES = 256;
export const UNIFORM_SLOT_FLOATS = UNIFORM_SLOT_BYTES / 4;

/**
 * Default capacity: 256 slots = 64 KiB. Core devices × 6 parts plus the Quanta
 * plugins is well under 128; overflowing throws instead of silently aliasing
 * a slot (a grown buffer would invalidate every cached bind group).
 */
export const DEFAULT_UNIFORM_SLOTS = 256;

/** `GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST`, as literals for Node. */
const UNIFORM_COPY_DST = 0x40 | 0x08;

export interface UniformRingDevice {
  createBuffer(desc: GPUBufferDescriptor): GPUBuffer;
  queue: Pick<GPUQueue, 'writeBuffer'>;
}

export class UniformRing {
  readonly buffer: GPUBuffer;
  readonly capacity: number;
  /** CPU mirror; slot `i` starts at float `i * UNIFORM_SLOT_FLOATS`. */
  readonly f32: Float32Array<ArrayBuffer>;
  private readonly queue: Pick<GPUQueue, 'writeBuffer'>;
  private readonly owners = new Map<object, Int32Array>();
  private used = 0;
  /** writeBuffer calls made (diagnostics: one per frame). */
  writes = 0;

  constructor(device: UniformRingDevice, opts: { label?: string; slots?: number } = {}) {
    this.capacity = opts.slots ?? DEFAULT_UNIFORM_SLOTS;
    this.queue = device.queue;
    this.f32 = new Float32Array(this.capacity * UNIFORM_SLOT_FLOATS);
    this.buffer = device.createBuffer({
      label: opts.label ?? 'frame-uniform-ring',
      size: this.capacity * UNIFORM_SLOT_BYTES,
      usage: UNIFORM_COPY_DST
    });
  }

  /** Slots handed out so far. */
  get slotsUsed(): number {
    return this.used;
  }

  get byteLength(): number {
    return this.capacity * UNIFORM_SLOT_BYTES;
  }

  /**
   * Stable byte offset of `owner`'s slot `part` (0 ≤ part < parts). The first
   * call for a pair allocates; every later call returns the same offset.
   * Callers that need to fill a new slot at once check `offsetOf` first.
   */
  slot(owner: object, part: number, parts: number): number {
    let table = this.owners.get(owner);
    if (!table) {
      table = new Int32Array(parts).fill(-1);
      this.owners.set(owner, table);
    }
    if (part < 0 || part >= table.length) {
      throw new RangeError(`[uniform-ring] part ${part} outside 0..${table.length - 1}`);
    }
    let index = table[part];
    if (index < 0) {
      if (this.used >= this.capacity) {
        throw new RangeError(`[uniform-ring] all ${this.capacity} slots in use — raise DEFAULT_UNIFORM_SLOTS`);
      }
      index = this.used++;
      table[part] = index;
    }
    return index * UNIFORM_SLOT_BYTES;
  }

  /** Byte offset of an allocated slot, or -1. Never allocates. */
  offsetOf(owner: object, part: number): number {
    const index = this.owners.get(owner)?.[part] ?? -1;
    return index < 0 ? -1 : index * UNIFORM_SLOT_BYTES;
  }

  /** Allocated parts of `owner` (index = part, value = slot index or -1). */
  partsOf(owner: object): Int32Array | undefined {
    return this.owners.get(owner);
  }

  /** First float of the slot at `byteOffset` in {@link f32}. */
  static base(byteOffset: number): number {
    return byteOffset / 4;
  }

  /** Upload every slot in use — once per frame, after encoding, before submit. */
  flush(): void {
    if (this.used === 0) return;
    this.queue.writeBuffer(this.buffer, 0, this.f32.buffer, 0, this.used * UNIFORM_SLOT_BYTES);
    this.writes++;
  }

  destroy(): void {
    this.buffer.destroy();
    this.owners.clear();
    this.used = 0;
  }
}
