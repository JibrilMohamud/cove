/**
 * Coalesce only identical, simultaneous, public anonymous presentation reads.
 *
 * There is intentionally NO TTL or persistent cache: as soon as the D1
 * request settles, the entry is removed. Subsequent visits obtain freshly
 * authoritative market / locale / page presentation metadata. Only the
 * caller's current primary-D1 retail-rights query may authorize books.
 *
 * Per-isolate, bounded and fail-open for saturation: never queue arbitrary
 * visitors or propagate one visitor's identity/session into another.
 */
export function createAnonymousPresentationSingleflight<T>(capacity = 64) {
  const pending = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    if (!key || key.length > 512 || (pending.size >= capacity && !pending.has(key)))
      return load();
    const current = pending.get(key);
    if (current) return current;
    const promise = Promise.resolve().then(load);
    pending.set(key, promise);
    const clean = () => {
      if (pending.get(key) === promise) pending.delete(key);
    };
    // Both resolution and rejection must evict. No stored response, no stale
    // legal/presentation state, and no unhandled rejection from cleanup.
    void promise.then(clean, clean);
    return promise;
  };
}
