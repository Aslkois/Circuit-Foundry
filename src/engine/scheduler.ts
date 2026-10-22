/**
 * Time-bucketed event queue. Each bucket holds the driver updates scheduled
 * for one simulation time, in insertion order. Distinct times are kept in a
 * binary min-heap; with unit delays the heap rarely holds more than two times.
 */

export class Bucket {
  time = 0;
  length = 0;
  slots: number[] = [];
  a: number[] = [];
  b: number[] = [];

  push(slot: number, a: number, b: number): void {
    const i = this.length++;
    this.slots[i] = slot;
    this.a[i] = a;
    this.b[i] = b;
  }
}

export class EventQueue {
  private readonly buckets = new Map<number, Bucket>();
  private readonly heap: number[] = [];
  private readonly pool: Bucket[] = [];
  private count = 0;

  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** Number of pending events across all times. */
  get size(): number {
    return this.count;
  }

  peekTime(): number {
    return this.heap.length > 0 ? this.heap[0] : Infinity;
  }

  schedule(time: number, slot: number, a: number, b: number): void {
    let bucket = this.buckets.get(time);
    if (!bucket) {
      bucket = this.pool.pop() ?? new Bucket();
      bucket.time = time;
      bucket.length = 0;
      this.buckets.set(time, bucket);
      this.heapPush(time);
    }
    bucket.push(slot, a, b);
    this.count++;
  }

  /** Removes and returns the earliest bucket. Hand it back with `release` once processed. */
  pop(): Bucket | undefined {
    if (this.heap.length === 0) return undefined;
    const time = this.heapPop();
    const bucket = this.buckets.get(time)!;
    this.buckets.delete(time);
    this.count -= bucket.length;
    return bucket;
  }

  release(bucket: Bucket): void {
    bucket.length = 0;
    if (this.pool.length < 64) this.pool.push(bucket);
  }

  clear(): void {
    for (const b of this.buckets.values()) this.release(b);
    this.buckets.clear();
    this.heap.length = 0;
    this.count = 0;
  }

  private heapPush(t: number): void {
    const h = this.heap;
    let i = h.length;
    h.push(t);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= t) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = t;
  }

  private heapPop(): number {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && h[r] < h[l] ? r : l;
        if (h[c] >= last) break;
        h[i] = h[c];
        i = c;
      }
      h[i] = last;
    }
    return top;
  }
}
