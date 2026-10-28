/**
 * import-validation stamps a player file's job with the age rule BEFORE it reads the rule (Phase E3b;
 * Codex's finding on #680): `stampAgeRule` calls `stamp_import_job_age_rule` for a player file with a
 * job, a first batch takes a fresh stamp and a later one keeps the first's, nothing else is stamped,
 * and a refusal is reported. The handler's call sits ahead of its read of the season and the
 * divisions, which is the whole point of the order (a change in between can only make the stamp
 * stale). Placeholder ids only.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { stampAgeRule, type AgeRuleStampClient } from '../age-rule-stamp.ts';

type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(error: { message?: string } | null = null) {
  const calls: Call[] = [];
  const client: AgeRuleStampClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve({ data: 'fingerprint', error });
    },
  };
  return { client, calls };
}

const JOB = '00000000-0000-4000-8000-0000000000a1';

Deno.test('a player file with a job is stamped, the first batch with a fresh stamp', async () => {
  const { client, calls } = fakeClient();
  const result = await stampAgeRule(client, {
    importType: 'players',
    importJobId: JOB,
    rowOffset: 0,
  });
  assertEquals(result, null);
  assertEquals(calls, [
    { fn: 'stamp_import_job_age_rule', args: { p_import_job_id: JOB, p_restart: true } },
  ]);
});

Deno.test('a later batch keeps the first stamp', async () => {
  const { client, calls } = fakeClient();
  await stampAgeRule(client, { importType: 'players', importJobId: JOB, rowOffset: 5000 });
  assertEquals(calls[0].args, { p_import_job_id: JOB, p_restart: false });
});

Deno.test('a missing offset is the first batch', async () => {
  const { client, calls } = fakeClient();
  await stampAgeRule(client, { importType: 'players', importJobId: JOB });
  assertEquals(calls[0].args.p_restart, true);
});

Deno.test('nothing else is stamped: other file types, and a request with no job', async () => {
  const { client, calls } = fakeClient();
  for (const importType of ['coaches', 'fields', 'field_availability']) {
    assertEquals(await stampAgeRule(client, { importType, importJobId: JOB, rowOffset: 0 }), null);
  }
  assertEquals(await stampAgeRule(client, { importType: 'players', importJobId: null }), null);
  assertEquals(await stampAgeRule(client, { importType: 'players' }), null);
  assertEquals(calls.length, 0);
});

Deno.test('a refused stamp is an error to report, never ignored', async () => {
  const { client } = fakeClient({ message: 'permission denied' });
  assertEquals(
    await stampAgeRule(client, { importType: 'players', importJobId: JOB, rowOffset: 0 }),
    { message: 'permission denied' }
  );
  const silent = fakeClient({});
  const result = await stampAgeRule(silent.client, { importType: 'players', importJobId: JOB });
  assert(result !== null && result.message.length > 0);
});

Deno.test('the handler stamps the job before it reads the season and the divisions', async () => {
  const source = await Deno.readTextFile(
    new URL('../../import-validation/index.ts', import.meta.url)
  );
  const stamp = source.indexOf('await stampAgeRule(');
  const seasonRead = source.indexOf(".from('season_settings')");
  const divisionRead = source.indexOf(".from('divisions')");
  assert(stamp > 0, 'import-validation calls stampAgeRule');
  assert(seasonRead > 0 && divisionRead > 0, 'the handler still reads the season and divisions');
  assert(stamp < seasonRead, 'the stamp is taken before the season row is read');
  assert(stamp < divisionRead, 'and before the divisions are read');
  assertEquals(source.split('await stampAgeRule(').length - 1, 1, 'once');
});
