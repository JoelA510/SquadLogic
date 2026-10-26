#!/usr/bin/env node
/**
 * The hourly read of the demo purge's health (plan docs/changes/2026-10-22-demo-mode.md, D3: "Purge
 * health, watched outside the database"). It calls the service-role-only `demo_health()` RPC and fails
 * the run when:
 *
 *   - an expired demo organization is more than 30 minutes past its expiry, or
 *   - the newest `demo_purge_log` row is more than 30 minutes old (or there is none), or
 *   - the answer cannot be read at all: an HTTP error, a body that is not `demo_health()`'s shape.
 *
 * A check that cannot run fails loudly; it never reads as healthy. The RPC reports `healthy` and
 * `problems` itself, and this does not take its word: it re-derives the verdict from the figures, so a
 * RPC that answered `healthy: true` beside a stale log still fails here (`tests/demoHealth.test.js`
 * plants both).
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ci/demoHealth.mjs
 */

/** Minutes past which a stale purge, or an expired demo left standing, is a failure. */
export const STALE_MINUTES = 30;

/**
 * The verdict on one `demo_health()` answer.
 * @param {unknown} health the parsed JSON body
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function evaluateDemoHealth(health) {
  if (health === null || typeof health !== 'object' || Array.isArray(health)) {
    return { ok: false, problems: ['demo_health() did not return an object'] };
  }
  const h = /** @type {Record<string, unknown>} */ (health);
  const problems = [];
  /** @param {unknown} v @returns {v is number} */
  const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

  if (typeof h.healthy !== 'boolean' || !Array.isArray(h.problems)) {
    problems.push('demo_health() answered without its healthy flag or problem list');
  } else if (!h.healthy || h.problems.length > 0) {
    for (const p of h.problems) problems.push(String(p));
    if (h.problems.length === 0)
      problems.push('demo_health() reports unhealthy without saying why');
  }
  if (!isCount(h.expired_stale)) {
    problems.push('demo_health() did not report how many expired demos are stale');
  } else if (h.expired_stale > 0) {
    problems.push(
      `${h.expired_stale} expired demo organization(s) are more than ${STALE_MINUTES} minutes past expiry`
    );
  }
  if (h.minutes_since_purge === null) {
    problems.push('the purge has never logged a run');
  } else if (!isCount(h.minutes_since_purge)) {
    problems.push('demo_health() did not report the minutes since the purge last ran');
  } else if (h.minutes_since_purge > STALE_MINUTES) {
    problems.push(
      `the purge last logged a run ${h.minutes_since_purge} minutes ago (limit ${STALE_MINUTES})`
    );
  }
  // The same fact reported twice is one problem.
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/**
 * Ask the project and judge the answer.
 * @param {{ url: string, serviceRoleKey: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, problems: string[], health?: unknown }>}
 */
export async function checkDemoHealth({ url, serviceRoleKey, fetchImpl = fetch }) {
  if (!url || !serviceRoleKey) {
    return { ok: false, problems: ['SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set'] };
  }
  let response;
  try {
    response = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/rpc/demo_health`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (error) {
    return {
      ok: false,
      problems: [`demo_health() could not be reached: ${error?.message ?? error}`],
    };
  }
  if (!response.ok) {
    return { ok: false, problems: [`demo_health() answered HTTP ${response.status}`] };
  }
  let health;
  try {
    health = await response.json();
  } catch {
    return { ok: false, problems: ['demo_health() did not answer with JSON'] };
  }
  return { ...evaluateDemoHealth(health), health };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const result = await checkDemoHealth({
    url: process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  });
  if (result.ok) {
    console.log(`Demo purge is healthy: ${JSON.stringify(result.health)}`);
  } else {
    for (const p of result.problems) console.error(`::error::${p}`);
    console.error(
      'The demo purge is not healthy. Run public.purge_expired_demos() by hand through the service role, then fix the job.'
    );
    process.exitCode = 1;
  }
}
