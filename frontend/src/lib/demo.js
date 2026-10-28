/**
 * The demo, client side (plan docs/changes/2026-10-22-demo-mode.md, D4; server side D3,
 * migration 20261030010000).
 *
 * A demo is an organization with `demo_expires_at` set. The server is the authority: past that
 * instant the organization is invisible to its visitor and every write is refused, whatever the
 * browser does. The browser keeps its own clock from the expiry `start_demo_session()` returned
 * (the row itself disappears from the visitor's reads at expiry, so there is nothing later to ask),
 * to show the time left and to sign the visitor out when it runs out.
 */
import { z } from 'zod';
import { supabase } from './supabaseClient.js';

/** The two moments, in milliseconds left, at which a screen reader hears how long is left. */
export const DEMO_ANNOUNCE_AT_MS = Object.freeze([5 * 60_000, 60_000]);

/**
 * The auto-scheduler's search budget. A run's CPU is its iterations, and a request to the Edge
 * Function gets 2 s of CPU in all (`CPU_CAP_MS` in `auto-scheduler-solver.ts` stops a search at
 * 1.5 s and returns its best schedule). Measured on Deno, on the demo league as it was (128 teams,
 * 196 slots): 1000 iterations cost 2.06-2.41 s of CPU; 100 iterations cost about 0.45 s.
 *
 * Re-measured for Phase D, PR F (executed in Node 24, the same solver, three runs each, the cap
 * off; CPU ms): the league as it was cost 138-254 at 100 iterations, 194-313 at 150, 389-458 at
 * 300 and 1,251-1,404 at 1000; a visitor's run now (120 practice units, 132 seeded rows held, 304
 * slots, two practices a week of 60 or 90 minutes on different weekdays) costs 139-206, 191-309,
 * 360-469 and 1,224-1,270. The cost per iteration is unchanged (within the spread), and the greedy
 * seed alone places all 120 practices with none TIME TBD. Node ran about 1.7 times faster than the
 * recorded Deno figure at 1000 iterations, so 150 iterations are expected to cost about 0.5 s of
 * CPU on the Edge, inside the cap. A demo keeps asking for 150 iterations and the schema's smallest
 * time budget: that finishes well inside the cap, so every demo run gets the same schedule and none
 * says "stopped at the server's time limit", which a run ended by the cap would, at a point that
 * depends on the server's speed. (The Deno figure for the new league is a conversion, not a
 * measurement: the Supabase edge runtime was not available where this was written.)
 */
const DEMO_AUTO_SCHEDULER_CONFIG = Object.freeze({
  timeBudgetMs: 1000,
  maxIterations: 150,
  seed: 42,
});
const AUTO_SCHEDULER_CONFIG = Object.freeze({ timeBudgetMs: 8000, maxIterations: 1000, seed: 42 });

/**
 * The `config` an auto-scheduler request carries.
 * @param {boolean} inDemo - is the active organization a demo?
 * @returns {{ timeBudgetMs: number, maxIterations: number, seed: number }}
 */
export function autoSchedulerConfig(inDemo) {
  return { ...(inDemo ? DEMO_AUTO_SCHEDULER_CONFIG : AUTO_SCHEDULER_CONFIG) };
}

/**
 * What a demo's players may still change (the server's `demo_fence_player_write`, D3): where they
 * play and how they are rated. Names, gender, grade, notes and the buddy request are read-only, so
 * no visitor can type a child's details into a demo; coach records are read-only entirely.
 */
const DEMO_EDITABLE_PLAYER_FIELDS = Object.freeze([
  'team_id',
  'division_id',
  'status',
  'rating',
  'years_played',
  'jersey_number',
  'willing_to_coach',
  'placement_eligible',
]);

/**
 * May this player field be edited here? Outside a demo, always; in one, only the fields the server
 * lets through (`DEMO_EDITABLE_PLAYER_FIELDS`).
 * @param {boolean} inDemo
 * @param {string} field A `players` column.
 */
export function canEditPlayerField(inDemo, field) {
  return !inDemo || DEMO_EDITABLE_PLAYER_FIELDS.includes(field);
}

/**
 * Is this organization row a demo?
 * @param {{ demo_expires_at?: string | null } | null | undefined} organization
 */
export function isDemoOrganization(organization) {
  return Boolean(organization?.demo_expires_at);
}

/**
 * The demo's expiry as epoch milliseconds, or `null` for an organization that is not a demo (or
 * whose expiry does not parse).
 * @param {{ demo_expires_at?: string | null } | null | undefined} organization
 * @returns {number | null}
 */
export function demoExpiryMs(organization) {
  if (!organization?.demo_expires_at) return null;
  const parsed = Date.parse(organization.demo_expires_at);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Minutes and seconds left, `22:14`. Never negative.
 * @param {number} msLeft
 */
export function formatTimeLeft(msLeft) {
  const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The spoken form of the time left, for the two announcements: "5 minutes", "1 minute".
 * @param {number} msLeft
 */
export function spokenTimeLeft(msLeft) {
  const minutes = Math.round(msLeft / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

const StartResultSchema = z.object({
  organization_id: z.string().min(1),
  expires_at: z.string().refine((value) => Number.isFinite(Date.parse(value)), 'not a timestamp'),
  existing: z.boolean().optional(),
});

/**
 * @typedef {'capacity' | 'not_anonymous' | 'unavailable'} DemoStartFailureKind
 */

/** A demo that could not be started; `kind` says why, `message` is fit to show a visitor. */
export class DemoStartError extends Error {
  /**
   * @param {DemoStartFailureKind} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'DemoStartError';
    this.kind = kind;
  }
}

/**
 * Why `start_demo_session()` (or the anonymous sign-in before it) failed, as a visitor should hear
 * it. The server's two refusals carry a `detail`: `demo_capacity` (P0001) at the cap and
 * `demo_requires_anonymous` (42501) for a signed-in account.
 * @param {any} error A PostgREST or GoTrue error, or anything thrown.
 * @returns {DemoStartError}
 */
export function demoStartFailure(error) {
  const detail = String(error?.details ?? error?.detail ?? '');
  const message = String(error?.message ?? '');
  if (detail === 'demo_capacity' || /demo is busy/i.test(message)) {
    return new DemoStartError(
      'capacity',
      'The demo is busy right now. Try again in a few minutes.'
    );
  }
  if (detail === 'demo_requires_anonymous') {
    return new DemoStartError(
      'not_anonymous',
      'You are signed in to an account. Sign out to try the demo.'
    );
  }
  return new DemoStartError(
    'unavailable',
    'The demo could not be started. Try again in a few minutes.'
  );
}

/**
 * Asks the server for this visitor's demo league: a new one, or the live one they already have.
 * Throws a `DemoStartError`.
 * @returns {Promise<{ organizationId: string, expiresAt: string, existing: boolean }>}
 */
export async function startDemoSession() {
  const { data, error } = await supabase.rpc('start_demo_session');
  if (error) throw demoStartFailure(error);
  const parsed = StartResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new DemoStartError(
      'unavailable',
      'The demo could not be started. Try again in a few minutes.'
    );
  }
  return {
    organizationId: parsed.data.organization_id,
    expiresAt: parsed.data.expires_at,
    existing: parsed.data.existing === true,
  };
}

/** The self-hosting guide in the public repository: what "Run your own SquadLogic" opens (decision 5). */
export const SELF_HOSTING_GUIDE_URL =
  'https://github.com/JoelA510/SquadLogic/blob/main/docs/operations/self-hosting.md';

/**
 * The hosted-service line of the import notice: where the official deployment is, or `null`. It is
 * `null` when no official URL is configured, when it does not parse, and when it is the origin the
 * visitor is on (the official deployment does not advertise itself to its own visitors).
 * @param {string | undefined} officialSiteUrl `VITE_OFFICIAL_SITE_URL`
 * @param {string} currentOrigin `window.location.origin`
 * @returns {{ url: string, host: string } | null}
 */
export function hostedSiteNotice(officialSiteUrl, currentOrigin) {
  if (!officialSiteUrl) return null;
  try {
    const official = new URL(officialSiteUrl);
    if (official.protocol !== 'https:' && official.protocol !== 'http:') return null;
    if (official.origin === currentOrigin) return null;
    return { url: official.href, host: official.host };
  } catch {
    // Not a URL (the env rules refuse one at build time): there is no hosted line to show.
    return null;
  }
}
