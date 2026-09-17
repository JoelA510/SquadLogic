/**
 * The one server-side read of a season's clock.
 *
 * ## Why the Edge Functions read this themselves
 *
 * `PracticeSchedulingPage` used to *send* `timezone` in the `auto-scheduler`
 * request body, and `auto-scheduler/index.ts` contained **zero occurrences of
 * the string** (LIVE-7). CLAUDE.md allows two outcomes for a field parsed and
 * unread: honour it, or delete it. This is both -- the field is deleted from
 * the wire, and the value is honoured from the place that actually holds it.
 *
 * Reading it server-side rather than trusting the body is not paranoia about
 * the client; it is the "one source of truth for a season's clock" rule the
 * `20260913000000` migration states when it refuses a read-time
 * `contact_info->>'timezone'` fallback. A request that carried its own zone
 * would be a second answer to the same question.
 *
 * ## Why `.order(created_at desc).limit(1)` and not `.single()`
 *
 * An organization legitimately has several `season_settings` rows -- the
 * season switcher in `OrganizationContext` lists them and defaults to the
 * newest -- and `.single()` errors on more than one row. In `calendar-feed`
 * that error was swallowed into `settings: null` and fell through to a
 * hardcoded `America/New_York`. Newest-first is the contract the frontend
 * already uses for "the current season"; a caller that knows which season it
 * means passes `seasonSettingsId` and gets that one.
 *
 * @module _shared/timing/seasonSettings
 */

/**
 * The narrow slice of the PostgREST builder this needs.
 *
 * Structural rather than `SupabaseClient`, for two reasons: `_shared/timing`
 * would otherwise take a network type-only dependency on the SDK, and the two
 * callers pin different SDK versions (`calendar-feed` 2.87.1,
 * `auto-scheduler`/`fairness-scoring` 2.45.3). It also lets a test hand this
 * function a plain object.
 */
export interface SeasonSettingsQuery {
  eq(column: string, value: string): SeasonSettingsQuery;
  order(column: string, options: { ascending: boolean }): SeasonSettingsQuery;
  limit(count: number): SeasonSettingsQuery;
  /**
   * `PromiseLike`, not `Promise`: PostgREST's builder is a thenable that only
   * issues the request when it is awaited, so it has `then` and not `catch`.
   */
  maybeSingle(): PromiseLike<{
    data: { timezone?: unknown } | null;
    error: { message?: string } | null;
  }>;
}

export interface SeasonSettingsReader {
  from(table: string): { select(columns: string): SeasonSettingsQuery };
}

export interface SeasonTimezoneResult {
  /** The IANA zone, or `null` when the season has none. `null` is a real answer. */
  timezone: string | null;
  /** True when the read itself failed, as opposed to succeeding and finding nothing. */
  errored: boolean;
  /** The reason, for logging. Never rendered to a subscriber. */
  message: string | null;
}

/**
 * Read `season_settings.timezone` for an organization.
 *
 * `null` with `errored: false` means the season genuinely has no clock, which
 * callers must treat as a refusal rather than an invitation to guess.
 *
 * @param supabase a service-role Supabase client
 * @param organizationId the org whose season to read
 * @param seasonSettingsId the specific season, when the caller knows it. Still
 *   filtered by `organizationId`, so a caller cannot read another org's season
 *   by guessing an id.
 */
export async function readSeasonTimezone(
  supabase: SeasonSettingsReader,
  organizationId: string | null | undefined,
  seasonSettingsId?: string | null
): Promise<SeasonTimezoneResult> {
  if (!organizationId) {
    return { timezone: null, errored: false, message: 'no organization id' };
  }

  let query = supabase
    .from('season_settings')
    .select('id, timezone, created_at')
    .eq('organization_id', organizationId);

  if (seasonSettingsId) {
    // Still scoped by organization: an id from the request body is not a
    // capability, and this runs under the service role.
    query = query.eq('id', seasonSettingsId);
  } else {
    query = query.order('created_at', { ascending: false });
  }

  const { data, error } = await query.limit(1).maybeSingle();

  if (error) {
    return { timezone: null, errored: true, message: error.message ?? 'unknown error' };
  }

  const value = data?.timezone;
  const timezone = typeof value === 'string' && value.trim() ? value.trim() : null;
  return { timezone, errored: false, message: null };
}
