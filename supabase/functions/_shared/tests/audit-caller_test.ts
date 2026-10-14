/**
 * Edge audit writes are made AS THE CALLER (`_shared/auth.ts`).
 *
 * `record_audit_event` inserts `user_id = auth.uid()`. The audit helpers used
 * to be handed the service-role client, under which `auth.uid()` is NULL, so
 * every Edge audit write failed on `audit_log.user_id NOT NULL` and was only
 * console-logged: import, persistence, evaluation and auto-scheduler actions
 * went unaudited (seen in production function logs on 2026-10-13).
 *
 * Two arms:
 * - the type: `recordAudit` / `recordAuditNow` take a `UserClient`, which only
 *   `createUserClient` makes, so a service-role client is a type error. The
 *   `@ts-expect-error` lines below fail `deno test`'s type check if a plain
 *   `SupabaseClient` is ever accepted again -- they did, before this fix.
 * - the wire: the RPC request carries the caller's `Authorization` header and
 *   the anon key, never the service-role key, and names no actor of its own.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import {
  AUDIT_ERROR_MAX_CHARS,
  auditErrorText,
  createUserClient,
  recordAudit,
  recordAuditNow,
} from '../auth.ts';

const URL_ = 'https://project.example.test';
const ANON = 'anon-key-not-a-secret';
const SERVICE = 'service-role-key-not-a-secret';
const CALLER_JWT = 'caller.jwt.token';
const ORG = 'a1111111-1111-1111-1111-111111111111';

interface Seen {
  url: string;
  authorization: string | null;
  apikey: string | null;
  body: Record<string, unknown>;
}

/**
 * Replaces `globalThis.fetch` for the duration of `fn`, recording each request.
 * `createUserClient` binds `fetch` when it is called, so the client must be
 * made inside `fn`.
 */
async function withFetch(respond: () => Response, fn: () => Promise<void>): Promise<Seen[]> {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({
      url: req.url,
      authorization: req.headers.get('authorization'),
      apikey: req.headers.get('apikey'),
      body: JSON.parse(await req.text()),
    });
    return respond();
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

function callerRequest(): Request {
  return new Request('https://edge.example.test/functions/v1/x', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CALLER_JWT}` },
  });
}

const PARAMS = {
  organizationId: ORG,
  action: 'scheduler.auto_refused',
  resourceType: 'practice_schedule',
  metadata: { reason: 'TEST' },
};

Deno.test('the audit helpers refuse a service-role client at the type level', () => {
  const service = createClient(URL_, SERVICE);
  // Never called: the bodies exist only for the type check.
  const typeOnly = () => {
    // @ts-expect-error -- a service-role client is not a UserClient.
    void recordAuditNow(service, PARAMS);
    // @ts-expect-error -- nor for the fire-and-forget form.
    recordAudit(service, PARAMS);
  };
  assert(typeof typeOnly === 'function');
});

Deno.test(
  'recordAuditNow calls record_audit_event as the caller, with no actor of its own',
  async () => {
    const seen = await withFetch(
      () => new Response(JSON.stringify('b2222222-2222-2222-2222-222222222222'), { status: 200 }),
      async () => {
        await recordAuditNow(createUserClient(callerRequest(), URL_, ANON), PARAMS);
      }
    );
    assertEquals(seen.length, 1, 'exactly one request: the RPC');
    const [rpc] = seen;
    assertEquals(rpc.url, `${URL_}/rest/v1/rpc/record_audit_event`);
    assertEquals(rpc.authorization, `Bearer ${CALLER_JWT}`);
    assertEquals(rpc.apikey, ANON);
    assert(!JSON.stringify(rpc).includes(SERVICE), 'the service-role key must not travel');
    // The actor is auth.uid(), derived from the JWT by the database; the body
    // carries no field a caller could set it through.
    assertEquals(Object.keys(rpc.body).sort(), [
      'p_action',
      'p_metadata',
      'p_organization_id',
      'p_resource_id',
      'p_resource_type',
    ]);
    assertEquals(rpc.body.p_organization_id, ORG);
    assertEquals(rpc.body.p_action, 'scheduler.auto_refused');
  }
);

Deno.test('recordAuditNow never rejects when the write fails', async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await withFetch(
      () =>
        new Response(JSON.stringify({ code: '23502', message: 'null value in column "user_id"' }), {
          status: 400,
        }),
      async () => {
        await recordAuditNow(createUserClient(callerRequest(), URL_, ANON), PARAMS);
      }
    );
  } finally {
    console.error = originalError;
  }
  assertEquals(errors.length, 1, 'the failure is logged once');
  assertEquals(errors[0][0], 'Audit log write failed:');
});

Deno.test('auditErrorText bounds what a failure writes into the audit log', () => {
  assertEquals(AUDIT_ERROR_MAX_CHARS, 200);
  assertEquals(auditErrorText(new Error('short')), 'short');
  assertEquals(auditErrorText('not an Error'), 'not an Error');
  const long = auditErrorText(new Error('x'.repeat(5000)));
  assertEquals(long.length, AUDIT_ERROR_MAX_CHARS);
  assert(long.endsWith('\u2026'), 'a cut message says it was cut');
  const exact = 'y'.repeat(AUDIT_ERROR_MAX_CHARS);
  assertEquals(auditErrorText(new Error(exact)), exact);
});
