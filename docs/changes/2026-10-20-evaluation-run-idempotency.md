# Idempotent evaluation-run writes

Status: **built**. The owner asked for it on 2026-10-20 ("make the evaluation-run write
idempotent"), which is the approval AGENTS.md rule 14 asks for on a persistence change. This
records the design that was built.

## What was wrong

auto-scheduler and fairness-scoring each write one evaluation run per request through
`persist_evaluation_run`. Since #621, a failed write fails the request instead of being swallowed.
A transport failure or a gateway 502/503/504 can arrive *after* PostgREST ran the call. The
function then cannot tell whether the run exists:

- failing the request may leave a run in the table that nobody was told about;
- retrying it blindly may write a second run, with a second copy of every finding and metric.

**Evidence, *executed*** (supabase-js 2.45.3, the Edge pin, in Deno 2.9.6 against a stubbed
`fetch`, 2026-10-20):

| Answer | What the client resolves with |
| --- | --- |
| Transport failure | `status: 0`, `code: ''` |
| Gateway 502 | `status: 502`, no code |
| PostgREST refusal | `status: 400`, with its SQLSTATE in `code` |

## Design

- **Schema:**
  - `evaluation_runs.idempotency_key uuid NULL`, unique per organization where set
    (`evaluation_runs_org_idempotency_key_idx`, a partial index);
  - migration `20261020010000`, with a revert and a smoke under `docs/sql/`.
- **RPC:** `persist_evaluation_run(jsonb, jsonb, jsonb)` keeps its signature. Adding a parameter
  would bring back the overload ambiguity that `20261018060000` removed. The key travels as
  `p_run_data.idempotency_key`.
  - The membership check runs first, unchanged.
  - The run is inserted with `ON CONFLICT DO NOTHING`.
  - On a conflict, the function returns the existing run's id and writes no findings or metrics.
  - A concurrent replay waits on the unique index for the first transaction, then takes the same
    path.
  - With no key, behaviour is exactly as before.
  - The body is production's (read back 2026-10-20) with only those lines added.
- **Edge:** `_shared/evaluation-run.ts` exports `persistEvaluationRun(client: UserClient, payload)`.
  - It adds a fresh `crypto.randomUUID()` key to every call.
  - It retries once, with the same key and body, on status 0, 502, 503 or 504.
  - It logs the retry (`logRequest`, warn) with the request's context, the first status and the
    key, so a run a retry wrote can be traced to its request.
  - It returns every other answer as it came. Both handlers still throw a failure with its code.
  - Both handlers call it, and it is the only caller of the RPC.

## Tests

| Layer | File | What it proves |
| --- | --- | --- |
| Deno | `_shared/tests/evaluation-run_test.ts` (11) | One request as the caller with a uuid key; the retry logged with the request id and key; the caller's payload not mutated; a new key per call; one retry, same body, on each retryable status; no retry on a refusal, a 22P02 or a 500; a second failure returned; a service-role client refused at the type level |
| Vitest | `tests/persistEvaluationRunCaller.test.js` | Both handlers call the helper once, as the caller, and throw with the code; no other Edge file calls the RPC |
| Harness smoke | `docs/sql/20261020010000_smoke.sql` | A replay returns the first id and writes no run, finding or metric; per-key and per-organization; no key unchanged; an outsider and a malformed key refused, nothing written; posture and index |
| Harness revert | `scripts/dbharness/run.sh` | Production's previous body restored byte for byte (md5), posture kept, index and column dropped |
| pgTAP | `supabase/tests/evaluation_run_idempotency.sql` (8) | The same cases under Supabase roles; the service role refused before the key is read |

**Plants (*executed*):**

- The helper: no retry, retrying every error, a new key on the retry, no key, and mutating the
  caller's payload. Each turns the Deno test red.
- The handlers: fairness-scoring calling the RPC directly, and auto-scheduler passing a
  non-caller client. Each turns the Vitest pin red.
- The SQL, recorded in `scripts/dbharness/prove.sh` as M29/R29:
  - a replay that writes its findings again;
  - a key that is read but not stored;
  - a revert that leaves the column;
  - a revert that restores a drifted body.

  Each turns the harness red.

## Not covered

- **Two concurrent calls with one key** are not exercised. The behaviour is PostgreSQL's
  `ON CONFLICT` on a unique index; one session cannot run it.
- **A replay with the same key and a different payload** returns the first run and ignores the
  new payload. The key names one request, and the helper sends the same payload on its retry.
- **A second gateway failure** still fails the request. The run may then exist, but there is no
  duplicate, and the log records the failure with its request id.
- **The browser-to-Edge hop has no key.** If the response to the browser is lost after the run
  committed, and the user runs auto-scheduler again, the new request mints a new key and writes a
  second run. A key supplied by the client (a request header passed to the helper, which already
  takes one) would close that. It is a frontend change and is left for a follow-up.
- **No delay before the retry.** A 503 from PostgREST that never reached the database (a restart)
  usually repeats at once. A delay long enough to outlast a restart would hold the request for
  seconds; one retry is kept cheap instead.
- **The mock client's `persist_evaluation_run`** ignores the key. No frontend path calls the RPC,
  so nothing in mock mode depends on it.
