/**
 * A structural stand-in for the slice of a supabase-js client the Edge loaders read
 * (`from().select().eq().lte().or().order().range()` and the awaited builder), over in-memory
 * tables. Records every call so a test can pin what was read and with which filters.
 *
 * @param {Record<string, any[]>} tables
 * @param {{ failOn?: string | null, count?: number }} [options] `failOn` fails one table's read;
 *   `count` replaces the exact count a `head` select returns.
 * @returns {any}
 */
export function fakeClient(tables, { failOn = null, count = undefined } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const result = () =>
        failOn === table
          ? { data: null, error: { message: 'boom' }, count: null }
          : { data: tables[table], error: null, count: count ?? tables[table].length };
      const q = {
        select(cols, options) {
          call.select = cols;
          call.options = options;
          return q;
        },
        eq(col, val) {
          call.filters.push(['eq', col, val]);
          return q;
        },
        lte(col, val) {
          call.filters.push(['lte', col, val]);
          return q;
        },
        or(filter) {
          call.filters.push(['or', filter]);
          return q;
        },
        order() {
          return q;
        },
        range(from, to) {
          const r = result();
          return Promise.resolve({ ...r, data: r.data ? r.data.slice(from, to + 1) : null });
        },
        then(resolve, reject) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
