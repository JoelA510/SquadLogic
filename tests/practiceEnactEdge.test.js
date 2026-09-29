/**
 * 8.6 3b PR 11b, the Edge half of enacting a recommendation
 * (docs/PHASE_8_6_PR11_ENACT_PLAN.md §4, §6 witness 21).
 *
 * - `repairErrorResponse`: plan §4's mapping, run directly (it is pure);
 * - `enactBodyRefusal`: an enact body's cross-field refusals;
 * - source pins on `practice-persistence/index.ts` (vitest cannot load the
 *   Deno function): an enact goes to `enact_practice_recommendation` with
 *   every argument, and ONLY a repair call's errors are mapped -- an
 *   ordinary save keeps today's 500.
 *
 * The database half (the wrapper's refusals, idempotency, the audit) is
 * docs/sql/20261004000000_smoke.sql, run by scripts/dbharness/run.sh.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  enactBodyRefusal,
  repairErrorResponse,
} from '../supabase/functions/_shared/practice-repair-errors.ts';

const SOURCE = readFileSync(
  path.join(process.cwd(), 'supabase/functions/practice-persistence/index.ts'),
  'utf8'
);

describe('repairErrorResponse (plan §4)', () => {
  const cases = [
    ['40001', 'season x changed since this plan was read', 409, 'PRACTICE_SCHEDULE_STALE', 'stale'],
    [
      '22023',
      'assignment a is locked: closes re-ranges it',
      409,
      'PRACTICE_ASSIGNMENT_LOCKED',
      'error',
    ],
    ['42501', 'only an organization admin with a uid can enact', 403, undefined, 'error'],
    ['22023', 'retirement of field f is not committed', 422, undefined, 'error'],
    ['23503', 'violates foreign key constraint', 500, undefined, 'error'],
    [undefined, 'network down', 500, undefined, 'error'],
  ];
  it.each(cases)('%s "%s" -> %i %s', (code, message, status, apiCode, apiStatus) => {
    const mapped = repairErrorResponse({ code, message });
    expect(mapped.status).toBe(status);
    expect(mapped.body.code).toBe(apiCode);
    expect(mapped.body.status).toBe(apiStatus);
    // The RPC's message is always kept.
    expect(mapped.body.message).toBe(message);
  });

  it('covers every row of the plan table, each status at least once', () => {
    const statuses = new Set(cases.map((c) => c[2]));
    expect([...statuses].sort()).toEqual([403, 409, 422, 500]);
  });
});

describe('enactBodyRefusal', () => {
  const key = 'e1100000-0000-4000-8000-000000000001';
  const season = 'e1100000-0000-4000-8000-000000000003';
  const fp = 'a'.repeat(32);
  const good = () => ({
    enact: {
      enact_key: key,
      season_settings_id: season,
      base_fingerprint: fp,
      result_fingerprint: null,
    },
    repair: { baseFingerprint: fp, withdrawExceptions: [] },
    runMetadata: { runId: key, seasonSettingsId: season },
  });

  it('passes a well-formed enact, and any call without one', () => {
    expect(enactBodyRefusal(good())).toBeNull();
    expect(enactBodyRefusal({ repair: { withdrawExceptions: [] } })).toBeNull();
  });

  it('refuses each malformed enact body with its own reason', () => {
    /** @type {Array<[(b: any) => unknown, RegExp]>} */
    const variants = [
      [(b) => delete b.repair, /repair body/],
      [(b) => delete b.repair.baseFingerprint, /never blind/],
      [(b) => (b.enact.base_fingerprint = 'b'.repeat(32)), /must equal repair.baseFingerprint/],
      [(b) => b.repair.withdrawExceptions.push({}), /withdraws no exceptions/],
      [(b) => (b.runMetadata.runId = season), /runId must be the enact key/],
      [(b) => (b.runMetadata.seasonSettingsId = key), /seasonSettingsId/],
      [(b) => (b.enact.result_fingerprint = fp), /filled by the database/],
    ];
    for (const [change, reason] of variants) {
      const body = good();
      change(body);
      expect(enactBodyRefusal(body)).toMatch(reason);
    }
  });
});

describe('practice-persistence routes an enact to the wrapper (source pin)', () => {
  it('validates `enact` with the twin schema and refuses a malformed enact body with 400', () => {
    expect(SOURCE).toMatch(/enact:\s*PracticeEnactSchema\.optional\(\)/);
    expect(SOURCE).toMatch(/PracticeEnactSchema = buildPracticeEnactRecordSchema\(z\)/);
    expect(SOURCE).toMatch(
      /enactBodyRefusal\(body\)[\s\S]{0,120}jsonResponse\([^)]*enactRefusal[^)]*\},\s*400\)/
    );
    expect(SOURCE).toMatch(/new Date\(\),\s*body\.repair,\s*body\.enact\s*\)/);
  });

  it('hands every argument to enact_practice_recommendation, and the ordinary call keeps its own', () => {
    const start = SOURCE.indexOf(".rpc('enact_practice_recommendation', {");
    const ordinary = SOURCE.indexOf(".rpc('persist_practice_schedule', {");
    expect(start).toBeGreaterThan(0);
    expect(ordinary).toBeGreaterThan(start);
    const call = SOURCE.slice(start, ordinary);
    for (const arg of [
      'run_data: runData',
      'assignments: assignmentRows',
      'unlock: repair.unlock',
      'closes: repair.closes',
      'exceptions: repair.exceptions',
      'base_fingerprint: repair.baseFingerprint',
      'enact,',
    ]) {
      expect(call, arg).toContain(arg);
    }
    // No withdrawal ever travels with an enact (decision 6 is out of PR 11).
    expect(call).not.toContain('withdraw');
  });

  it('maps errors only for a repair call; an ordinary save keeps the 500 (witness 21)', () => {
    const catchAt = SOURCE.indexOf("console.error('Practice persistence error:', error);");
    expect(catchAt).toBeGreaterThan(0);
    const handler = SOURCE.slice(catchAt);
    const guarded = handler.match(
      /if \(body\.repair\) \{\s*const mapped = repairErrorResponse\(error\);\s*return jsonResponse\(mapped\.body, mapped\.status\);\s*\}/
    );
    expect(guarded, 'the mapping is not behind `if (body.repair)`').toBeTruthy();
    // After the guarded block, the ordinary path's response is today's 500.
    const rest = handler.slice(handler.indexOf(guarded[0]) + guarded[0].length);
    expect(rest).toMatch(
      /^\s*return jsonResponse\(\s*\{\s*status: 'error',[\s\S]*?\},\s*500\s*\);/
    );
    // repairErrorResponse is called nowhere else.
    expect(SOURCE.match(/repairErrorResponse\(/g)).toHaveLength(1);
  });

  it('adds idempotent / enactAudited to the response only for an enact', () => {
    expect(SOURCE).toMatch(
      /\.\.\.\(enact\s*\?\s*\{\s*idempotent: report\.idempotent \?\? false, enactAudited: report\.enact_audited \?\? false\s*\}\s*:\s*\{\}\)/
    );
  });
});
