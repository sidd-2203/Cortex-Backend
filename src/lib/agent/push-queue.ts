/**
 * A minimal push-based async iterable: something pushes values in as they
 * arrive (a callback), something else consumes them via `for await`. This is
 * the bridge between OpenRouter's callback-style token stream
 * (`onTextDelta`) and Trigger.dev's `streams.pipe()`, which wants an
 * `AsyncIterable` it can forward to Realtime subscribers.
 */
export class PushQueue<T> implements AsyncIterable<T> {
  private buffered: T[] = [];
  private waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffered.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}
