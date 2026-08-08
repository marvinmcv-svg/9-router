/**
 * A push-to-pull adapter.
 *
 * Providers report deltas through a callback, but the kernel loop is an async
 * generator and cannot yield from inside one. This bridges the two: the
 * provider pushes, the loop iterates, and tokens reach the browser while the
 * request is still open rather than arriving in one lump at the end.
 */
export interface DeltaQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
}

export function createQueue<T>(): DeltaQueue<T> {
  const buffered: T[] = [];
  let closed = false;
  // Set while a consumer is parked waiting for an item that hasn't arrived.
  let wake: (() => void) | null = null;

  return {
    push(item: T) {
      if (closed) return;
      buffered.push(item);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buffered.length) yield buffered.shift()!;
        // Drain before checking `closed`, so items pushed in the same tick as
        // close() are still delivered rather than dropped.
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
