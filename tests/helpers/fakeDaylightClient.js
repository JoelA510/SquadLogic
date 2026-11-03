/**
 * A fake Supabase client for the Practice daylight outlook's tests: it serves
 * `state.tables`, filters by the `organization_id` the select was given, and
 * returns **only the columns the select asked for** (lesson 60: a double that
 * returns whole rows hides a column the query forgot). It records every read in
 * `state.reads` and every write or RPC in `state.writes`, so a test can show the
 * outlook only reads.
 *
 * `state.fail` names a table whose read fails (`state.failAs`: `'error'`, an
 * `{ error }` answer, or `'throw'`, a rejected request).
 *
 * @param {{ tables: Record<string, any[]>, fail: string|null, failAs: 'error'|'throw',
 *   reads: Array<{ table: string, columns: string }>, writes: Array<[string, string]> }} state
 */
export function fakeDaylightClient(state) {
  const WRITES = ['insert', 'update', 'upsert', 'delete'];
  const from = (/** @type {string} */ table) => {
    let rows = state.tables[table] ?? [];
    let columns = '*';
    /** @type {Record<string, any>} */
    const q = {
      select: (/** @type {string} */ cols) => {
        columns = cols;
        return q;
      },
      eq: (/** @type {string} */ col, /** @type {unknown} */ val) => {
        // An embedded filter (`teams.divisions.season_settings_id`) is the server's.
        if (!col.includes('.')) rows = rows.filter((r) => String(r[col]) === String(val));
        return q;
      },
      order: () => q,
      range: (/** @type {number} */ lo, /** @type {number} */ hi) => {
        state.reads.push({ table, columns });
        if (state.fail === table) {
          return state.failAs === 'throw'
            ? Promise.reject(new Error(`${table}: connection reset`))
            : Promise.resolve({ data: null, error: { message: `${table}: permission denied` } });
        }
        // Only the columns asked for; an embed (`teams!inner(...)`) is not a column of the row.
        const names = columns
          .split(',')
          .map((c) => c.trim())
          .filter((c) => !c.includes('!') && !c.includes('('));
        const projected = rows
          .slice(lo, hi + 1)
          .map((row) => Object.fromEntries(names.map((name) => [name, row[name]])));
        return Promise.resolve({ data: projected, error: null });
      },
    };
    for (const method of WRITES) {
      q[method] = () => {
        state.writes.push([table, method]);
        return q;
      };
    }
    return q;
  };
  return {
    from,
    rpc: (/** @type {string} */ name) => {
      state.writes.push(['rpc', name]);
      return Promise.resolve({ data: null, error: null });
    },
  };
}
