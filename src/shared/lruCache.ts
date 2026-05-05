class LRUCache<T = any> {
  private capacity: number;
  private cache: Map<string, any>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map<string, any>();
  }
  has(key: string): boolean {
    return this.cache.has(key);
  }
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
  get(key: string): any {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    // Map remembers the order of insertion, so we need to delete and re-insert the key to update its position
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  put(key: string, value: T) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Get the first key in the Map (the oldest key)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, value);
  }
}

export default LRUCache;
