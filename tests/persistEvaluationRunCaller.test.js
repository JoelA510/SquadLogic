/**
 * `persist_evaluation_run` refuses anyone who is not a member of the run's organization by
 * `auth.uid()` (migration 20260407000000; pgTAP `evaluation_persistence_contract.sql` shows the
 * service role is refused). An Edge Function's service-role client has no `auth.uid()`, so a
 * call through it can never succeed: auto-scheduler swallowed that error and fairness-scoring
 * threw it on every run (#621). Both now persist as the caller, through
 * `_shared/evaluation-run.ts`, which keys the write and retries it once (migration
 * 20261020010000; its wire behaviour is `_shared/tests/evaluation-run_test.ts`). Source pins, as
 * the neighbouring wiring tests are: neither handler has a runtime harness.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const read = (fn) =>
  readFileSync(path.join(process.cwd(), `supabase/functions/${fn}/index.ts`), 'utf8');

describe('persist_evaluation_run is called as the caller, never with the service role', () => {
  it.each([
    [
      'auto-scheduler',
      /persistEvaluationRun\(\s*createUserClient\(req, supabaseUrl, anonKey\),\s*logCtx,\s*\{/,
    ],
    ['fairness-scoring', /persistEvaluationRun\(auditClient, logCtx, \{/],
  ])('%s', (fn, callerScoped) => {
    const source = read(fn);
    // Exactly one call, through the helper, so the pin below covers every call there is.
    assert.equal(source.split('persistEvaluationRun(').length - 1, 1, 'one call');
    assert.match(
      source,
      /import \{ persistEvaluationRun \} from '\.\.\/_shared\/evaluation-run\.ts';/
    );
    assert.match(source, callerScoped);
    assert.doesNotMatch(source, /\.rpc\('persist_evaluation_run'/, 'only the helper calls the RPC');
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

  it('the helper is the only caller of the RPC in any Edge Function, and takes a UserClient', () => {
    const root = path.join(process.cwd(), 'supabase/functions');
    const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !/(_test|\.test)\.ts$/.test(f))
      .filter((f) =>
        readFileSync(path.join(root, f), 'utf8').includes(".rpc('persist_evaluation_run'")
      );
    assert.deepEqual(callers, [path.join('_shared', 'evaluation-run.ts')]);
    const helper = readFileSync(path.join(root, '_shared/evaluation-run.ts'), 'utf8');
    assert.match(
      helper,
      /export async function persistEvaluationRun\(\s*client: UserClient,\s*logCtx: FailureContext,/
    );
  });
});
