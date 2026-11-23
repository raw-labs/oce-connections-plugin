export class Queue {
  readonly #pending = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.#pending.get(key);
    const next = (
      before ? before.catch(() => undefined) : Promise.resolve()
    ).then(work);
    this.#pending.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#pending.get(key) === next) this.#pending.delete(key);
    }
  }
}
