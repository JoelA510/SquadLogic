/**
 * Loads the 0.5-degree Linke turbidity table the heat model needs
 * (`packages/core/src/heat/data/`, 328,320 bytes) as a same-origin asset, once
 * per page load, and only when the heat forecast asks for it. Vite emits it as
 * a hashed file under `assets/` (budgeted in `config/bundle-budget.json`); CSP
 * `connect-src 'self'` already covers it.
 *
 * A failed or truncated download fails loudly through `decodeTurbidityTable`
 * and is not cached, so the next attempt retries.
 *
 * @module lib/turbidityTable
 */

import tableUrl from '@squadlogic/core/heat/data/linkeTurbidity-nws-0p5deg.bin?url';
import { decodeTurbidityTable } from '@squadlogic/core/heat/index.js';

/** @type {Promise<import('@squadlogic/core/heat/turbidity.js').TurbidityTable>|null} */
let pending = null;

/**
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<import('@squadlogic/core/heat/turbidity.js').TurbidityTable>}
 */
export function loadTurbidityTable(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (!pending) {
    pending = (async () => {
      const response = await fetchImpl(tableUrl);
      if (!response.ok) {
        throw new Error(`Linke turbidity table could not be loaded (HTTP ${response.status})`);
      }
      return decodeTurbidityTable(await response.arrayBuffer());
    })().catch((err) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** Test seam: forget the cached table. */
export function resetTurbidityTableCache() {
  pending = null;
}
