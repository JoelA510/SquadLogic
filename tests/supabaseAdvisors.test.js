/**
 * The Supabase advisors gate (`scripts/ci/supabaseAdvisors.mjs`, plan item M3.3): what it blocks,
 * what a waiver covers, and that "couldn't check" is never "clean".
 *
 * The report shape is the one `supabase db advisors --output-format json` printed on CLI 2.118.0
 * (`{"results": [...], "message": "db advisors"}`; an error is `{"_tag": "Error", "error": ...}`),
 * captured against a local PostgreSQL 16. The real register is read too: it must parse with no
 * problems of its own, and every waived object must be one the advisors could report.
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

/** One advisor result, as the CLI prints it. */
const finding = (name, level, schema, object, extra = {}) => ({
  name,
  title: name,
  level,
  facing: 'EXTERNAL',
  categories: ['SECURITY'],
  description: '',
  detail: `${schema}.${object} trips ${name}`,
  remediation: '',
  metadata: { name: object, type: 'table', schema },
  cacheKey: `${name}_${schema}_${object}`,
  ...extra,
});
const INFO_FK = finding('unindexed_foreign_keys', 'INFO', 'public', 'audit_log');
const report = (...results) => ({ results: [INFO_FK, ...results], message: 'db advisors' });
const waiver = (lint, objects, extra = {}) => ({
  lint,
  objects,
  reason: 'A reason long enough to say why this is acceptable in this repository.',
  expires: null,
  ...extra,
});
const verdict = (rep, register) =>
  evaluate(readFindings(rep), readWaivers({ waivers: register }, TODAY));

describe('the gate blocks what it should', () => {
  it('passes a report whose WARN findings are all waived', () => {
    const v = verdict(report(finding('auth_rls_initplan', 'WARN', 'public', 'profiles')), [
      waiver('auth_rls_initplan', ['public.profiles']),
    ]);
    expect(v).toEqual({ blocking: 1, unwaived: [], problems: [] });
  });

  it('blocks an unwaived WARN and an unwaived ERROR (a planted table without RLS)', () => {
    const v = verdict(
      report(
        finding('function_search_path_mutable', 'WARN', 'public', 'f'),
        finding('rls_disabled_in_public', 'ERROR', 'public', 'planted')
      ),
      []
    );
    expect(v.unwaived.map((f) => `${f.level} ${f.lint} ${f.object}`)).toEqual([
      'WARN function_search_path_mutable public.f',
      'ERROR rls_disabled_in_public public.planted',
    ]);
  });

  it('a waiver covers its lint on its objects only', () => {
    const v = verdict(
      report(
        finding('auth_rls_initplan', 'WARN', 'public', 'profiles'),
        finding('auth_rls_initplan', 'WARN', 'public', 'players'),
        finding('multiple_permissive_policies', 'WARN', 'public', 'profiles')
      ),
      [waiver('auth_rls_initplan', ['public.profiles'])]
    );
    expect(v.unwaived.map((f) => `${f.lint} ${f.object}`)).toEqual([
      'auth_rls_initplan public.players',
      'multiple_permissive_policies public.profiles',
    ]);
  });

  it('never reads INFO, so an INFO finding neither blocks nor keeps a waiver alive', () => {
    expect(verdict(report(), [])).toEqual({ blocking: 0, unwaived: [], problems: [] });
    const v = verdict(report(), [waiver('unindexed_foreign_keys', ['public.audit_log'])]);
    expect(v.problems).toEqual([
      'waivers[0] (unindexed_foreign_keys): the advisors no longer report public.audit_log; remove them from the register.',
    ]);
  });

  it('keys a project-level finding (no schema or object) as "project"', () => {
    const leaked = {
      ...finding('auth_leaked_password_protection', 'WARN', 'x', 'y'),
      metadata: {},
    };
    expect(verdict(report(leaked), []).unwaived.map((f) => f.object)).toEqual(['project']);
    expect(
      verdict(report(leaked), [waiver('auth_leaked_password_protection', ['project'])]).unwaived
    ).toEqual([]);
  });
});

describe('the register is held to the bar it enforces', () => {
  const warn = finding('auth_rls_initplan', 'WARN', 'public', 'profiles');

  it('fails a stale waiver, naming the objects nothing reported', () => {
    const v = verdict(report(warn), [
      waiver('auth_rls_initplan', ['public.profiles', 'public.gone', 'public.also_gone']),
    ]);
    expect(v.unwaived).toEqual([]);
    expect(v.problems).toEqual([
      'waivers[0] (auth_rls_initplan): the advisors no longer report public.gone, public.also_gone; remove them from the register.',
    ]);
  });

  it('an expired waiver covers nothing and says so', () => {
    const v = verdict(report(warn), [
      waiver('auth_rls_initplan', ['public.profiles'], { expires: '2026-10-12' }),
    ]);
    expect(v.unwaived.map((f) => f.object)).toEqual(['public.profiles']);
    expect(v.problems).toEqual([
      'waivers[0] (auth_rls_initplan) expired on 2026-10-12: fix the findings or renew it with a new reason.',
    ]);
  });

  it.each([
    ['no expires key', {}, '"expires" is required'],
    ['an impossible date', { expires: '2026-02-31' }, 'must be null or a real YYYY-MM-DD date'],
    ['a date too far out', { expires: '2027-06-01' }, 'more than 180 days out'],
    ['a short reason', { reason: 'fine' }, '"reason" must say why'],
    ['a malformed lint', { lint: 'Auth RLS' }, '"lint" must be the advisor'],
    ['no objects', { objects: [] }, '"objects" must list'],
    ['an object that is not schema.name', { objects: ['profiles'] }, 'is not schema.name'],
  ])('rejects %s', (label, patch, message) => {
    /** @type {Record<string, unknown>} */
    const w = waiver('auth_rls_initplan', ['public.profiles'], patch);
    if (label === 'no expires key') delete w.expires;
    const { problems } = readWaivers({ waivers: [w] }, TODAY);
    expect(problems.join('\n')).toContain(message);
  });

  it('rejects the same lint and object waived twice', () => {
    const { problems } = readWaivers(
      {
        waivers: [
          waiver('auth_rls_initplan', ['public.profiles']),
          waiver('auth_rls_initplan', ['public.profiles']),
        ],
      },
      TODAY
    );
    expect(problems).toEqual([
      'waivers[1]: auth_rls_initplan on public.profiles is already waived by waivers[0].',
    ]);
  });
});

describe('"could not check" is never "clean"', () => {
  it.each([
    ['a CLI error', { _tag: 'Error', error: { message: 'failed to connect' } }],
    ['no results array', { message: 'db advisors' }],
    ['an empty report (examined nothing)', { results: [], message: 'db advisors' }],
    ['a non-object', []],
    ['a finding with no level', { results: [{ ...INFO_FK, level: undefined }] }],
    [
      'a finding with half an object',
      { results: [{ ...INFO_FK, metadata: { schema: 'public' } }] },
    ],
  ])('throws on %s', (_label, rep) => {
    expect(() => readFindings(rep)).toThrow(CheckError);
  });
});

describe('the script, end to end', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'advisors-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (rep, register) => {
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
    const warn = finding('auth_rls_initplan', 'WARN', 'public', 'profiles');
    expect(run(report(warn), [waiver('auth_rls_initplan', ['public.profiles'])]).status).toBe(0);
    const blocked = run(report(warn, finding('rls_disabled_in_public', 'ERROR', 'public', 't')), [
      waiver('auth_rls_initplan', ['public.profiles']),
    ]);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('::error::ERROR rls_disabled_in_public on public.t');
    expect(run('Connecting to local database...', []).status).toBe(2);
  });
});

describe('the real register', () => {
  const register = JSON.parse(readFileSync(REGISTER, 'utf8'));

  it('parses with no problems of its own', () => {
    expect(readWaivers(register, TODAY).problems).toEqual([]);
  });

  it('waives only WARN lints the gate reads, each with a reason and a decision on expiry', () => {
    // A meta-assertion over the file, not derived from it: these are the lints
    // the M3.3 triage found on a from-scratch build (CLI 2.118.0).
    expect(register.waivers.map((w) => w.lint).sort()).toEqual([
      'auth_rls_initplan',
      'function_search_path_mutable',
      'multiple_permissive_policies',
    ]);
    for (const w of register.waivers) {
      expect(w.expires === null || /^\d{4}-\d{2}-\d{2}$/.test(w.expires)).toBe(true);
    }
  });
});
