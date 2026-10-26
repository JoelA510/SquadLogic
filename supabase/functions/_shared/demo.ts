/**
 * The demo organization, as the Edge Functions see it (plan docs/changes/2026-10-22-demo-mode.md, D3).
 *
 * `is_org_member` and `is_org_admin` end a demo at expiry in the database, but the Edge Functions
 * check membership themselves, with the service role, against `organization_members`. This is the
 * missing half: an expired demo's member is no member here either, and a demo imports nothing.
 *
 * Pure of any remote import (the client type is erased at build time), so Vitest holds it:
 * `tests/demoEdgeGuard.test.js`.
 */

/** The corner of a Supabase client these reads use, so this file imports nothing remote. */
export interface DemoClient {
  from(table: 'organizations'): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): { maybeSingle(): PromiseLike<{ data: unknown; error: DemoReadError | null }> };
      in(
        column: string,
        values: string[]
      ): PromiseLike<{ data: unknown; error: DemoReadError | null }>;
    };
  };
}
type DemoReadError = { code?: string; message?: string };

/** A Supabase client, as this file's reads take it (they use one corner of it; see {@link DemoClient}). */
export const asDemoClient = (client: unknown): DemoClient => client as DemoClient;

export type DemoState = {
  /** `demo_expires_at` is set: a demo organization, live or ended. */
  isDemo: boolean;
  /** A demo whose expiry has passed. A real organization is never expired. */
  expired: boolean;
};

/** PostgREST's code for "undefined column": the migration that adds `demo_expires_at` has not landed. */
const UNDEFINED_COLUMN = '42703';

function stateOf(expiresAt: string | null | undefined, now: number): DemoState {
  if (expiresAt === null || expiresAt === undefined) return { isDemo: false, expired: false };
  const at = Date.parse(expiresAt);
  // A value that is not a date is a demo that cannot be shown to be live.
  return { isDemo: true, expired: !Number.isFinite(at) || at <= now };
}

/**
 * Whether an organization is a demo and whether it has ended. `null` means it could not be read:
 * the caller refuses (a check that cannot run fails closed). A project without the column yet has
 * no demos, which is the one expected error and the only one treated as an answer.
 */
export async function readDemoState(
  client: DemoClient,
  organizationId: string,
  now: number = Date.now()
): Promise<DemoState | null> {
  const { data, error } = await client
    .from('organizations')
    .select('demo_expires_at')
    .eq('id', organizationId)
    .maybeSingle();
  if (error) {
    if (error.code === UNDEFINED_COLUMN) return { isDemo: false, expired: false };
    console.error('Demo state check failed:', error.message);
    return null;
  }
  if (!data) return { isDemo: false, expired: false };
  return stateOf((data as { demo_expires_at?: string | null }).demo_expires_at, now);
}

/**
 * The organizations among `organizationIds` that have not ended. Unreadable means none: a caller
 * that cannot be shown to belong to a live organization belongs to no organization.
 */
export async function liveOrganizationIds(
  client: DemoClient,
  organizationIds: string[],
  now: number = Date.now()
): Promise<string[]> {
  if (organizationIds.length === 0) return [];
  const { data, error } = await client
    .from('organizations')
    .select('id, demo_expires_at')
    .in('id', organizationIds);
  if (error) {
    if (error.code === UNDEFINED_COLUMN) return organizationIds;
    console.error('Demo state check failed:', error.message);
    return [];
  }
  const ended = new Set<string>();
  for (const row of (data ?? []) as { id: string; demo_expires_at?: string | null }[]) {
    if (stateOf(row.demo_expires_at, now).expired) ended.add(row.id);
  }
  return organizationIds.filter((id) => !ended.has(id));
}
