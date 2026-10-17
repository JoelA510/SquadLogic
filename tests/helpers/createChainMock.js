// Chainable Supabase query-builder mock.
//
// Usage:
//   const chain = createChainMock({ data: [{ id: '1' }], error: null });
//   supabase.from.mockReturnValue(chain);
//   // await chain.select().eq('org_id', MOCK_ORG_ID).single()
//   //   → { data: [{ id: '1' }], error: null }
//
// The proxy returns itself for every method call (supporting arbitrary
// chaining depth), and resolves to `resolvedValue` when awaited. Tests
// needing method-specific behavior override per-call by constructing
// a fresh chain with `createChainMock(...)`.

export function createChainMock(resolvedValue = { data: null, error: null }) {
  const target = {
    ...resolvedValue,
    // Forward BOTH promise handlers (onFulfilled, onRejected) and any
    // future args. A single-arg signature breaks Vitest/JSDOM internals
    // that rely on the standard Promise shape.
    then: (...args) => Promise.resolve(resolvedValue).then(...args),
  };
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then;
      if (prop === 'data' || prop === 'error') return t[prop];
      // Let symbols (Symbol.toStringTag, Symbol.iterator, …) and common
      // introspection properties (toJSON, constructor) fall through to
      // the target. Without this, JSON.stringify, console.log, and test-
      // runner diffing can infinite-recurse or throw.
      if (
        typeof prop === 'symbol' ||
        ['toJSON', 'constructor', 'toString', 'valueOf'].includes(prop)
      ) {
        return t[prop];
      }
      return () => proxy;
    },
  });
  return proxy;
}
