/**
 * `persist_evaluation_run` refuses anyone who is not a member of the run's organization by
 * `auth.uid()` (migration 20260407000000; pgTAP `evaluation_persistence_contract.sql` shows the
 * service role is refused). An Edge Function's service-role client has no `auth.uid()`, so a
 * call through it can never succeed: auto-scheduler swallowed that error and fairness-scoring
 * threw it on every run (#621). Both now persist as the caller. Source pins, as the neighbouring
 * wiring tests are: neither handler has a runtime harness.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (fn) =>
  readFileSync(path.join(process.cwd(), `supabase/functions/${fn}/index.ts`), 'utf8');

describe('persist_evaluation_run is called as the caller, never with the service role', () => {
  it.each([
    [
      'auto-scheduler',
      /createUserClient\(\s*req,\s*supabaseUrl,\s*anonKey\s*\)\.rpc\('persist_evaluation_run'/,
    ],
    ['fairness-scoring', /auditClient\.rpc\('persist_evaluation_run'/],
  ])('%s', (fn, callerScoped) => {
    const source = read(fn);
    // Exactly one call, so the pin below covers every call there is.
    assert.equal(source.split(".rpc('persist_evaluation_run'").length - 1, 1, 'one call');
    assert.match(source, callerScoped);
    assert.doesNotMatch(source, /supabase\.rpc\('persist_evaluation_run'/);
    if (fn === 'fairness-scoring') {
      // `auditClient` is the caller-scoped client in this handler, not a service-role alias.
      assert.match(source, /const auditClient = createUserClient\(req, supabaseUrl, anonKey\);/);
    }
    // A failure keeps its PostgREST code for `logFailure` (describeError reads `code`).
    assert.match(
      source,
      /throw Object\.assign\(new Error\(`Persistence failed: \$\{persistError\.message\}`\), \{\s*code: persistError\.code,\s*\}\);/
    );
  });
});
