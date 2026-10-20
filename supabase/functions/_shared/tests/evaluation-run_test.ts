/**
 * `persistEvaluationRun` (`_shared/evaluation-run.ts`): one idempotency key per call, sent as
 * the caller, retried once with the same key only when the first answer cannot say whether the
 * run committed. The wire is the real supabase-js client over a stubbed `fetch`, so the shapes
 * asserted here (`status: 0` for a transport failure) are the ones the Edge Functions see.
 */
import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import { createUserClient } from '../auth.ts';
import { persistEvaluationRun } from '../evaluation-run.ts';

const URL_ = 'https://project.example.test';
const ANON = 'anon-key-not-a-secret';
const SERVICE = 'service-role-key-not-a-secret';
const CALLER_JWT = 'caller.jwt.token';
const ORG = 'a1111111-1111-1111-1111-111111111111';
const RUN = 'b2222222-2222-2222-2222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Seen {
  url: string;
  authorization: string | null;
  apikey: string | null;
  body: { p_run_data: Record<string, unknown>; p_findings: unknown[]; p_metrics: unknown[] };
}

type Answer = Response | 'transport-failure';

/**
 * Replaces `globalThis.fetch` for the duration of `fn`, answering each request with the next of
 * `answers` and recording it. The client is made inside `fn`, as `createUserClient` binds
 * `fetch` when it is called.
 */
async function withAnswers(answers: Answer[], fn: () => Promise<void>): Promise<Seen[]> {
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
    const next = answers.shift();
    if (next === undefined) throw new Error('more requests than the test answers');
    if (next === 'transport-failure')
      throw new TypeError('error sending request: connection reset');
    return next;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

const ok = () => new Response(JSON.stringify(RUN), { status: 200 });
const gateway = (status: number) => new Response('<html>gateway</html>', { status });
const pgError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function client() {
  const req = new Request('https://edge.example.test/functions/v1/x', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CALLER_JWT}` },
  });
  return createUserClient(req, URL_, ANON);
}

function payload() {
  return {
    p_run_data: { organization_id: ORG, scheduler_run_type: 'practice' },
    p_findings: [{ finding_code: 'F' }],
    p_metrics: [{ metric_key: 'm', metric_value: 1 }],
  };
}

Deno.test('a service-role client is refused at the type level', () => {
  const service = createClient(URL_, SERVICE);
  // Never called: the body exists only for the type check.
  const typeOnly = () => {
    // @ts-expect-error -- a service-role client is not a UserClient.
    void persistEvaluationRun(service, payload());
  };
  assert(typeof typeOnly === 'function');
});

Deno.test(
  'one call, as the caller, carrying a fresh uuid key and the payload unchanged',
  async () => {
    const sent = payload();
    let result: Awaited<ReturnType<typeof persistEvaluationRun>> | undefined;
    const seen = await withAnswers([ok()], async () => {
      result = await persistEvaluationRun(client(), sent);
    });
    assertEquals(seen.length, 1);
    const [rpc] = seen;
    assertEquals(rpc.url, `${URL_}/rest/v1/rpc/persist_evaluation_run`);
    assertEquals(rpc.authorization, `Bearer ${CALLER_JWT}`);
    assertEquals(rpc.apikey, ANON);
    assertMatch(String(rpc.body.p_run_data.idempotency_key), UUID);
    assertEquals(
      { ...rpc.body.p_run_data, idempotency_key: undefined },
      {
        ...sent.p_run_data,
        idempotency_key: undefined,
      }
    );
    assertEquals(rpc.body.p_findings, sent.p_findings);
    assertEquals(rpc.body.p_metrics, sent.p_metrics);
    // The caller's object is not written to.
    assertEquals('idempotency_key' in sent.p_run_data, false);
    assertEquals(result?.data, RUN);
    assertEquals(result?.error, null);
  }
);

Deno.test('two calls carry two different keys', async () => {
  const seen = await withAnswers([ok(), ok()], async () => {
    await persistEvaluationRun(client(), payload());
    await persistEvaluationRun(client(), payload());
  });
  assertEquals(seen.length, 2);
  assert(seen[0].body.p_run_data.idempotency_key !== seen[1].body.p_run_data.idempotency_key);
});

for (const [label, first] of [
  ['a transport failure', () => 'transport-failure' as const],
  ['a 502', () => gateway(502)],
  ['a 503', () => gateway(503)],
  ['a 504', () => gateway(504)],
] as const) {
  Deno.test(`${label} is retried once with the same key and body`, async () => {
    let result: Awaited<ReturnType<typeof persistEvaluationRun>> | undefined;
    const seen = await withAnswers([first(), ok()], async () => {
      result = await persistEvaluationRun(client(), payload());
    });
    assertEquals(seen.length, 2, 'exactly one retry');
    assertEquals(seen[1].body, seen[0].body, 'the retry repeats the first request, key and all');
    assertEquals(seen[1].authorization, `Bearer ${CALLER_JWT}`);
    assertEquals(result?.data, RUN);
    assertEquals(result?.error, null);
  });
}

Deno.test('a second retryable failure is returned, not retried again', async () => {
  let result: Awaited<ReturnType<typeof persistEvaluationRun>> | undefined;
  const seen = await withAnswers(['transport-failure', gateway(502)], async () => {
    result = await persistEvaluationRun(client(), payload());
  });
  assertEquals(seen.length, 2);
  assertEquals(result?.status, 502);
  assert(result?.error, 'the failure reaches the caller, which throws it');
});

for (const [label, answer, code] of [
  ['a refusal (P0001, 400)', () => pgError(400, 'P0001', 'Not authorized: x'), 'P0001'],
  ['a malformed key (22P02, 400)', () => pgError(400, '22P02', 'invalid input syntax'), '22P02'],
  ['a function error (500)', () => pgError(500, 'XX000', 'boom'), 'XX000'],
] as const) {
  Deno.test(`${label} is the answer: no retry, code kept`, async () => {
    let result: Awaited<ReturnType<typeof persistEvaluationRun>> | undefined;
    const seen = await withAnswers([answer()], async () => {
      result = await persistEvaluationRun(client(), payload());
    });
    assertEquals(seen.length, 1, 'no retry');
    assertEquals(result?.error?.code, code);
  });
}
