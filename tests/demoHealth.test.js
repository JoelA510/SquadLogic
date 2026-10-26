// @vitest-environment node
/**
 * The demo purge's health check (plan `docs/changes/2026-10-22-demo-mode.md`, D3): the verdict
 * (`scripts/ci/demoHealth.mjs`) against planted answers, and the hourly workflow that runs it. The
 * database's half (what `demo_health()` reports for a planted stale log and a planted stale expired
 * demo) is `supabase/tests/demo_sessions.sql`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STALE_MINUTES, checkDemoHealth, evaluateDemoHealth } from '../scripts/ci/demoHealth.mjs';

const healthy = {
  healthy: true,
  problems: [],
  live_demos: 3,
  expired_stale: 0,
  minutes_since_purge: 7,
  checked_at: '2026-10-26T12:00:00Z',
};

describe('evaluateDemoHealth', () => {
  it('passes a healthy answer, including the edge of the limit', () => {
    expect(evaluateDemoHealth(healthy)).toEqual({ ok: true, problems: [] });
    expect(evaluateDemoHealth({ ...healthy, minutes_since_purge: STALE_MINUTES }).ok).toBe(true);
  });

  it('fails a planted stale log, even when the RPC itself said healthy', () => {
    const planted = { ...healthy, minutes_since_purge: 45 }; // healthy: true is the lie
    const verdict = evaluateDemoHealth(planted);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/45 minutes ago/);
    expect(evaluateDemoHealth({ ...healthy, minutes_since_purge: STALE_MINUTES + 1 }).ok).toBe(
      false
    );
  });

  it('fails a planted stale expired demo, even when the RPC itself said healthy', () => {
    const verdict = evaluateDemoHealth({ ...healthy, expired_stale: 2 });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/2 expired demo organization\(s\)/);
  });

  it("fails a purge that has never logged, and repeats the RPC's own problems once", () => {
    const never = evaluateDemoHealth({
      ...healthy,
      healthy: false,
      problems: ['the purge has never logged a run'],
      minutes_since_purge: null,
    });
    expect(never).toEqual({ ok: false, problems: ['the purge has never logged a run'] });
  });

  it('fails an unhealthy answer that gives no reason, and answers it cannot read', () => {
    expect(evaluateDemoHealth({ ...healthy, healthy: false }).ok).toBe(false);
    for (const bad of [
      null,
      undefined,
      'ok',
      [],
      {},
      { healthy: true },
      { ...healthy, expired_stale: 'none' },
      { ...healthy, minutes_since_purge: 'soon' },
      { ...healthy, minutes_since_purge: -1 },
    ]) {
      expect(evaluateDemoHealth(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('checkDemoHealth', () => {
  const answer =
    (body, status = 200) =>
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const run = (fetchImpl) =>
    checkDemoHealth({ url: 'https://project.example/', serviceRoleKey: 'key', fetchImpl });

  it('asks demo_health with the service key and passes a healthy answer', async () => {
    /** @type {{ url: any, init: any } | undefined} */
    let seen;
    const result = await run(async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(healthy), { status: 200 });
    });
    expect(result.ok).toBe(true);
    expect(seen?.url).toBe('https://project.example/rest/v1/rpc/demo_health');
    expect(seen?.init.method).toBe('POST');
    expect(seen?.init.headers.Authorization).toBe('Bearer key');
  });

  it('fails a planted stale log read through the whole path', async () => {
    const result = await run(answer({ ...healthy, minutes_since_purge: 90 }));
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/90 minutes ago/);
  });

  it('fails when it cannot run: no secrets, a network error, an HTTP error, a body that is not JSON', async () => {
    expect((await checkDemoHealth({ url: '', serviceRoleKey: '' })).ok).toBe(false);
    expect(
      (
        await run(async () => {
          throw new Error('socket hang up');
        })
      ).problems[0]
    ).toMatch(/could not be reached/);
    expect((await run(answer({ message: 'not found' }, 404))).problems[0]).toMatch(/HTTP 404/);
    expect((await run(answer('<html>', 200))).problems[0]).toMatch(/did not answer with JSON/);
  });
});

describe('the hourly workflow', () => {
  const source = readFileSync('.github/workflows/demo-health.yml', 'utf8');
  const code = source
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .join('\n');

  it('runs every hour and on demand', () => {
    expect(code).toMatch(/schedule:\n\s+- cron: '\d+ \* \* \* \*'/);
    expect(code).toMatch(/workflow_dispatch:/);
  });

  it('runs the script, with the service key from secrets and in no `with:` or inline command', () => {
    expect(code).toMatch(/run: node scripts\/ci\/demoHealth\.mjs/);
    expect(code).toMatch(
      /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/
    );
    expect(code.match(/secrets\./g)).toHaveLength(2);
    // The script is the verdict: nothing makes its failure pass.
    expect(code).not.toMatch(/continue-on-error|\|\| true|\|\| :/);
  });

  it('opens an issue only from a failed scheduled run, in a job of its own with the only write permission', () => {
    expect(code).toMatch(
      /report-scheduled-failure:[\s\S]*needs: \[health\][\s\S]*if: failure\(\) && github\.event_name == 'schedule'/
    );
    expect(code.match(/issues: write/g)).toHaveLength(1);
    expect(code).toMatch(/^permissions: \{\}$/m);
    expect(code).toMatch(/contents: read/);
  });
});
