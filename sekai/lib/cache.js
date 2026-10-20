// Small in-memory TTL cache.

export class TtlCache {
  #entries = new Map();
  #ttlMs;
  #max;

  constructor({ ttlMs = 60_000, max = 500 } = {}) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // refresh recency so the oldest key can be evicted first
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.#ttlMs) {
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  async remember(key, fn, ttlMs = this.#ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }
}
