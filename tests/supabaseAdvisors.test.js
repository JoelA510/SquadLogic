/**
 * The Supabase advisors gate (`scripts/ci/supabaseAdvisors.mjs`, plan item M3.3): what it blocks,
 * what a waiver covers, and that "couldn't check" is never "clean".
 *
 * The report shape is the one `supabase db advisors --output-format json` printed on CLI 2.118.0
 * (`{"results": [...], "message": "db advisors"}`; an error is `{"_tag": "Error", "error": ...}`),
 * captured against a local PostgreSQL 16. The real register is checked for its own validity only:
 * whether each waived cacheKey is one a real build reports is the pgTAP job's stale-waiver check,
 * which runs the advisors against the migrated schema on every pull request.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CheckError,
  evaluate,
  readFindings,
  readWaivers,
} from '../scripts/ci/supabaseAdvisors.mjs';

const SCRIPT = path.resolve('scripts/ci/supabaseAdvisors.mjs');
const REGISTER = path.resolve('docs/security/supabase-advisor-waivers.json');
const TODAY = new Date('2026-10-13T00:00:00Z');

/**
 * One advisor result, as the CLI prints it.
 * @param {string} name lint
 * @param {string} level
 * @param {string} cacheKey
 */
const finding = (name, level, cacheKey) => ({
  name,
  title: name,
  level,
  facing: 'EXTERNAL',
  categories: ['SECURITY'],
  description: '',
  detail: `${cacheKey} trips ${name}`,
  remediation: '',
  metadata: { name: 'x', type: 'table', schema: 'public' },
  cacheKey,
});
const INFO_FK = finding(
  'unindexed_foreign_keys',
  'INFO',
  'unindexed_foreign_keys_public_audit_log_fk'
);
const report = (/** @type {object[]} */ ...results) => ({
  results: [INFO_FK, ...results],
  message: 'db advisors',
});
const PROFILES_VIEW = 'auth_rls_init_plan_public_profiles_Profiles: users view own';
const PROFILES_UPDATE = 'auth_rls_init_plan_public_profiles_Profiles: users update own';
/**
 * @param {string} lint
 * @param {unknown[]} findings cacheKeys
 * @param {Record<string, unknown>} [extra]
 */
const waiver = (lint, findings, extra = {}) => ({
  lint,
  findings,
  reason: 'A reason long enough to say why this is acceptable in this repository.',
  expires: null,
  ...extra,
});
const verdict = (/** @type {unknown} */ rep, /** @type {unknown[]} */ register) =>
  evaluate(readFindings(rep), readWaivers({ waivers: register }, TODAY));

describe('the gate blocks what it should', () => {
  it('passes a report whose WARN findings are all waived', () => {
    const v = verdict(report(finding('auth_rls_initplan', 'WARN', PROFILES_VIEW)), [
      waiver('auth_rls_initplan', [PROFILES_VIEW]),
    ]);
    expect(v).toEqual({ blocking: 1, unwaived: [], problems: [] });
  });

  it('blocks an unwaived WARN and an unwaived ERROR (a planted table without RLS)', () => {
    const v = verdict(
      report(
        finding('function_search_path_mutable', 'WARN', 'function_search_path_mutable_public_f_1'),
        finding('rls_disabled_in_public', 'ERROR', 'rls_disabled_in_public_public_planted')
      ),
      []
    );
    expect(v.unwaived.map((f) => `${f.level} ${f.lint}`)).toEqual([
      'WARN function_search_path_mutable',
      'ERROR rls_disabled_in_public',
    ]);
  });

  it('a waiver covers the findings it names, not every finding on the same table', () => {
    // The review's case: a NEW per-row auth.uid() policy on an already waived table.
    const v = verdict(
      report(
        finding('auth_rls_initplan', 'WARN', PROFILES_VIEW),
        finding('auth_rls_initplan', 'WARN', PROFILES_UPDATE)
      ),
      [waiver('auth_rls_initplan', [PROFILES_VIEW])]
    );
    expect(v.unwaived.map((f) => f.cacheKey)).toEqual([PROFILES_UPDATE]);
  });

  it('a waiver for one lint does not cover the same cacheKey under another lint', () => {
    const v = verdict(report(finding('multiple_permissive_policies', 'WARN', PROFILES_VIEW)), [
      waiver('auth_rls_initplan', [PROFILES_VIEW]),
    ]);
    expect(v.unwaived).toHaveLength(1);
  });

  it('never blocks on INFO, and says so when a waiver names an INFO finding', () => {
    expect(verdict(report(), [])).toEqual({ blocking: 0, unwaived: [], problems: [] });
    const v = verdict(report(), [waiver('unindexed_foreign_keys', [INFO_FK.cacheKey])]);
    expect(v.problems).toEqual([
      `waivers[0] (unindexed_foreign_keys): ${INFO_FK.cacheKey} is reported at INFO, which never blocks; remove it from the register.`,
    ]);
  });
});

describe('the register is held to the bar it enforces', () => {
  const warn = finding('auth_rls_initplan', 'WARN', PROFILES_VIEW);

  it('fails a stale waiver, naming the findings nothing reported', () => {
    const v = verdict(report(warn), [
      waiver('auth_rls_initplan', [PROFILES_VIEW, 'gone_1', 'gone_2']),
    ]);
    expect(v.unwaived).toEqual([]);
    expect(v.problems).toEqual([
      'waivers[0] (auth_rls_initplan): the advisors no longer report gone_1, gone_2; remove them from the register.',
    ]);
  });

  it('an expired waiver covers nothing and says so', () => {
    const v = verdict(report(warn), [
      waiver('auth_rls_initplan', [PROFILES_VIEW], { expires: '2026-10-12' }),
    ]);
    expect(v.unwaived.map((f) => f.cacheKey)).toEqual([PROFILES_VIEW]);
    expect(v.problems).toEqual([
      'waivers[0] (auth_rls_initplan) expired on 2026-10-12: fix the findings or renew it with a new reason.',
    ]);
  });

  it('announces a waiver in its last 30 days, without failing', () => {
    const near = readWaivers(
      { waivers: [waiver('auth_rls_initplan', [PROFILES_VIEW], { expires: '2026-11-01' })] },
      TODAY
    );
    expect(near.problems).toEqual([]);
    expect(near.notices).toEqual([
      'waivers[0] (auth_rls_initplan) expires on 2026-11-01; after that its findings block every pull request.',
    ]);
    const far = readWaivers(
      { waivers: [waiver('auth_rls_initplan', [PROFILES_VIEW], { expires: '2027-01-11' })] },
      TODAY
    );
    expect(far.notices).toEqual([]);
  });

  it.each([
    ['no expires key', {}, '"expires" is required'],
    ['an impossible date', { expires: '2026-02-31' }, 'must be null or a real YYYY-MM-DD date'],
    ['a date too far out', { expires: '2027-06-01' }, 'more than 180 days out'],
    ['a short reason', { reason: 'fine' }, '"reason" must say why'],
    ['a malformed lint', { lint: 'Auth RLS' }, '"lint" must be the advisor'],
    ['no findings', { findings: [] }, '"findings" must list'],
    ['a findings entry that is not a string', { findings: [7] }, 'non-empty cacheKey string'],
  ])('rejects %s, and the invalid waiver covers nothing', (label, patch, message) => {
    /** @type {Record<string, unknown>} */
    const w = waiver('auth_rls_initplan', [PROFILES_VIEW], patch);
    if (label === 'no expires key') delete w.expires;
    const v = verdict(report(warn), [w]);
    expect(v.problems.join('\n')).toContain(message);
    expect(v.unwaived.map((f) => f.cacheKey)).toEqual([PROFILES_VIEW]);
  });

  it('rejects the same finding waived twice', () => {
    const { problems } = readWaivers(
      {
        waivers: [
          waiver('auth_rls_initplan', [PROFILES_VIEW]),
          waiver('auth_rls_initplan', [PROFILES_VIEW]),
        ],
      },
      TODAY
    );
    expect(problems).toEqual([`waivers[1]: ${PROFILES_VIEW} is already waived by waivers[0].`]);
  });
});

describe('"could not check" is never "clean"', () => {
  it.each([
    ['a CLI error', { _tag: 'Error', error: { message: 'failed to connect' } }],
    ['no results array', { message: 'db advisors' }],
    ['an empty report (examined nothing)', { results: [], message: 'db advisors' }],
    ['a non-object', []],
    ['a finding with no level', { results: [{ ...INFO_FK, level: undefined }] }],
    ['a finding with no cacheKey', { results: [{ ...INFO_FK, cacheKey: undefined }] }],
  ])('throws on %s', (_label, rep) => {
    expect(() => readFindings(rep)).toThrow(CheckError);
  });
});

describe('the script, end to end', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'advisors-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (/** @type {unknown} */ rep, /** @type {unknown[]} */ register) => {
    const input = path.join(dir, 'advisors.json');
    const waivers = path.join(dir, 'waivers.json');
    writeFileSync(input, typeof rep === 'string' ? rep : JSON.stringify(rep));
    writeFileSync(waivers, JSON.stringify({ waivers: register }));
    return spawnSync(
      process.execPath,
      [SCRIPT, '--input', input, '--waivers', waivers, '--today', '2026-10-13'],
      { encoding: 'utf8' }
    );
  };

  it('exits 0 when clean, 1 on an unwaived finding, 2 when it could not check', () => {
    const warn = finding('auth_rls_initplan', 'WARN', PROFILES_VIEW);
    const ok = [waiver('auth_rls_initplan', [PROFILES_VIEW])];
    expect(run(report(warn), ok).status).toBe(0);
    const blocked = run(
      report(warn, finding('rls_disabled_in_public', 'ERROR', 'rls_disabled_in_public_public_t')),
      ok
    );
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain(
      '::error::ERROR rls_disabled_in_public (rls_disabled_in_public_public_t)'
    );
    expect(run('Connecting to local database...', []).status).toBe(2);
  });
});

describe('the real register', () => {
  const register = JSON.parse(readFileSync(REGISTER, 'utf8'));

  it('parses with no problems of its own', () => {
    expect(readWaivers(register, TODAY).problems).toEqual([]);
  });

  it('waives the lints the M3.3 triage found, each with a decision on expiry', () => {
    // A literal, not derived from the file: the WARN lints a from-scratch build
    // reported on CLI 2.118.0 (2026-10-13). A new lint needs a new triage.
    expect(register.waivers.map((/** @type {{ lint: string }} */ w) => w.lint).sort()).toEqual([
      'auth_rls_initplan',
      'function_search_path_mutable',
      'multiple_permissive_policies',
    ]);
    for (const w of register.waivers) {
      expect(w.expires === null || /^\d{4}-\d{2}-\d{2}$/.test(w.expires)).toBe(true);
    }
  });
});
