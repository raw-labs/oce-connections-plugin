import { HttpError } from "./http.js";

const maximumPerKey = 8;
const maximumTotal = 128;

export class Queue {
  readonly #pending = new Map<
    string,
    { tail: Promise<unknown>; size: number }
  >();
  #size = 0;

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const entry = this.#pending.get(key) ?? {
      tail: Promise.resolve(),
      size: 0,
    };
    if (entry.size >= maximumPerKey || this.#size >= maximumTotal)
      throw new HttpError(429, "too_many_pending_requests");
    const next = entry.tail.catch(() => undefined).then(work);
    entry.tail = next;
    entry.size++;
    this.#size++;
    this.#pending.set(key, entry);
    try {
      return await next;
    } finally {
      this.#size--;
      if (--entry.size === 0) this.#pending.delete(key);
    }
  }
}
