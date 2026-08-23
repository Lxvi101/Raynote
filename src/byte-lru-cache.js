// Small LRU cache with both entry-count and approximate byte limits.
//
// Note content and rendered HTML vary wildly in size, so an entry-only cap can
// retain hundreds of megabytes when a few giant notes are opened. Callers
// provide a conservative size estimator; an individual value larger than the
// whole budget is deliberately not retained.
export class ByteLruCache {
  constructor({ maxEntries, maxBytes, sizeOf }) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.items = new Map();
    this.byteSize = 0;
  }

  get size() {
    return this.items.size;
  }

  get totalBytes() {
    return this.byteSize;
  }

  has(key) {
    return this.items.has(key);
  }

  get(key) {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const existing = this.items.get(key);
    if (existing) {
      this.items.delete(key);
      this.byteSize -= existing.bytes;
    }

    const bytes = Math.max(0, Number(this.sizeOf(value)) || 0);
    if (bytes > this.maxBytes || this.maxEntries <= 0) return false;

    this.items.set(key, { value, bytes });
    this.byteSize += bytes;
    this.evictToBudget();
    return true;
  }

  delete(key) {
    const entry = this.items.get(key);
    if (!entry) return false;
    this.items.delete(key);
    this.byteSize -= entry.bytes;
    return true;
  }

  clear() {
    this.items.clear();
    this.byteSize = 0;
  }

  evictToBudget() {
    while (
      this.items.size > this.maxEntries ||
      this.byteSize > this.maxBytes
    ) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }
}
