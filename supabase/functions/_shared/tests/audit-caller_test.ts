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
  AUDIT_WRITE_FAILED_MESSAGE,
  auditErrorText,
  auditWriteFailedResponse,
  createUserClient,
  isAuditWriteFailure,
  recordAudit,
  recordAuditNow,
} from '../auth.ts';
import type { FailureContext } from '../logtail.ts';

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

const CTX: FailureContext = {
  functionName: 'auto-scheduler',
  requestId: 'req-1',
  organizationId: ORG,
};

/** Runs `fn` with `console.error` captured: `logFailure` writes through it. */
async function capturingErrors(fn: () => Promise<void>): Promise<unknown[][]> {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await fn();
  } finally {
    console.error = originalError;
  }
  return errors;
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
    void recordAuditNow(service, CTX, PARAMS);
    // @ts-expect-error -- nor for the fire-and-forget form.
    recordAudit(service, CTX, PARAMS);
  };
  assert(typeof typeOnly === 'function');
});

Deno.test(
  'recordAuditNow calls record_audit_event as the caller, with no actor of its own',
  async () => {
    const seen = await withFetch(
      () => new Response(JSON.stringify('b2222222-2222-2222-2222-222222222222'), { status: 200 }),
      async () => {
        await recordAuditNow(createUserClient(callerRequest(), URL_, ANON), CTX, PARAMS);
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

Deno.test('the audit helpers refuse a call with no failure context at the type level', () => {
  const client = createUserClient(callerRequest(), URL_, ANON);
  // Never called: the bodies exist only for the type check. Without the
  // context a failed write could not reach BetterStack (plan section 3.3).
  const typeOnly = () => {
    // @ts-expect-error -- the failure context is required.
    void recordAuditNow(client, PARAMS);
    // @ts-expect-error -- for the fire-and-forget form too.
    recordAudit(client, PARAMS);
  };
  assert(typeof typeOnly === 'function');
});

Deno.test(
  'a failed audit write reaches logFailure with the action and the handler context, and never rejects',
  async () => {
    const errors = await capturingErrors(async () => {
      await withFetch(
        () =>
          new Response(JSON.stringify({ code: '23503', message: 'audit_log_action_fkey' }), {
            status: 409,
          }),
        async () => {
          await recordAuditNow(createUserClient(callerRequest(), URL_, ANON), CTX, PARAMS);
        }
      );
    });
    assertEquals(errors.length, 1, 'the failure is logged once');
    assertEquals(
      errors[0][0],
      '[ERROR] auto-scheduler: Audit write failed: scheduler.auto_refused'
    );
    const context = errors[0][1] as Record<string, unknown>;
    assertEquals(context.function_name, 'auto-scheduler');
    assertEquals(context.request_id, 'req-1');
    assertEquals(context.organization_id, ORG);
    assertEquals((context.error as Record<string, unknown>).code, '23503');
  }
);

Deno.test('a thrown audit write (network) reaches logFailure too', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError('network down'))) as typeof fetch;
  let errors: unknown[][] = [];
  try {
    errors = await capturingErrors(async () => {
      await recordAuditNow(createUserClient(callerRequest(), URL_, ANON), CTX, PARAMS);
    });
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(errors.length, 1, 'the failure is logged once');
  assertEquals(errors[0][0], '[ERROR] auto-scheduler: Audit write failed: scheduler.auto_refused');
});

Deno.test('a save rolled back for its audit row is told apart by SLA01 alone', () => {
  assert(isAuditWriteFailure({ code: 'SLA01', message: 'audit write failed, nothing was saved' }));
  assert(!isAuditWriteFailure({ code: '42501', message: 'caller is not an admin' }));
  assert(!isAuditWriteFailure({ message: 'SLA01' }), 'the code decides, not the text');
  assert(!isAuditWriteFailure(null));
  assert(!isAuditWriteFailure('SLA01'));
});

Deno.test(
  'the rolled-back save answers 500 AUDIT_WRITE_FAILED, logged through logFailure',
  async () => {
    const ctx: FailureContext = { functionName: 'team-persistence', requestId: 'req-2' };
    let response: Response | undefined;
    const errors = await capturingErrors(async () => {
      response = await auditWriteFailedResponse(ctx, 'Team save', {
        code: 'SLA01',
        message: 'audit write failed, nothing was saved: insert violates foreign key',
      });
    });
    assertEquals(response?.status, 500);
    assertEquals(await response?.json(), {
      status: 'error',
      code: 'AUDIT_WRITE_FAILED',
      message: AUDIT_WRITE_FAILED_MESSAGE,
    });
    assert(AUDIT_WRITE_FAILED_MESSAGE.startsWith('Nothing was saved'));
    assertEquals(errors.length, 1);
    assertEquals(
      errors[0][0],
      '[ERROR] team-persistence: Team save rolled back: its audit row could not be written'
    );
    assertEquals(
      ((errors[0][1] as Record<string, unknown>).error as Record<string, unknown>).code,
      'SLA01'
    );
  }
);

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
