/** Least-recently-used map on top of `Map`'s insertion order. */
export class LruCache<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }

  /** Removes the entry only while it still holds `value`, so a slow loader cannot drop its successor. */
  deleteIf(key: K, value: V): void {
    if (this.#entries.get(key) === value) this.#entries.delete(key);
  }
}
