/**
 * Every `supabase/setup-cli` step pins an explicit CLI version.
 *
 * With `version: latest`, setup-cli resolves the newest release through an
 * unauthenticated GitHub API call. That call hit "rate limit exceeded" on
 * push-to-main runs 1156 (2026-09-29) and 1174 (2026-09-30); each time
 * "Deploy Edge Functions" and main went red before any deploy command ran.
 *
 * The scan is line-based on purpose (no YAML dependency): each step is found by
 * its `uses:` line, and its `version:` is read from the `with:` block of that
 * same step. A `${{ env.NAME }}` value is resolved against the workflow's
 * top-level `env:` block. The step count is checked against a raw substring
 * count, so a step written in a shape the scanner does not recognise is a loud
 * failure rather than a step nobody examined.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR = '.github/workflows';
const CI_WORKFLOW = 'ci.yml';
const GUARD_PATH = 'scripts/ci/migrationGuard.mjs';
const SETUP_CLI = 'supabase/setup-cli@';
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/** deploy-migrations and deploy-edge-functions. A literal, not derived from the file. */
const MIN_CI_STEPS = 2;

const indentOf = (/** @type {string} */ line) => line.length - line.trimStart().length;
const unquote = (/** @type {string} */ v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The workflow's top-level `env:` block, as NAME -> raw value. */
function topLevelEnv(/** @type {string[]} */ lines) {
  /** @type {Record<string, string>} */
  const env = {};
  const start = lines.findIndex((l) => l === 'env:');
  if (start < 0) return env;
  for (let j = start + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) === 0) break;
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) env[m[1]] = unquote(m[2]);
  }
  return env;
}

/**
 * @param {string} text workflow source
 * @returns {Array<{ line: number, raw: string | null, resolved: string | null }>}
 */
function scanSetupCliSteps(text) {
  const lines = text.split('\n');
  const env = topLevelEnv(lines);
  const steps = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(-\s+)?uses:\s*supabase\/setup-cli@/.exec(line);
    if (!m) return;
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0);
    let raw = null;
    let inWith = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue;
      const ind = indentOf(next);
      if (ind < keyIndent) break;
      if (ind === keyIndent) {
        inWith = next.trim() === 'with:';
        continue;
      }
      const v = inWith ? /^\s+version:\s*(.*)$/.exec(next) : null;
      if (v) raw = unquote(v[1].replace(/\s+#.*$/, ''));
    }
    let resolved = raw;
    const ref = raw === null ? null : /^\$\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}$/.exec(raw);
    if (ref) resolved = env[ref[1]] ?? null;
    steps.push({ line: i + 1, raw, resolved });
  });
  return steps;
}

/** Problems with the scanned steps; empty means every step pins a version. */
function pinProblems(/** @type {string} */ text) {
  return scanSetupCliSteps(text)
    .filter((s) => s.resolved === null || !SEMVER.test(s.resolved))
    .map(
      (s) => `line ${s.line}: version ${JSON.stringify(s.raw)} -> ${JSON.stringify(s.resolved)}`
    );
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (/** @type {string} */ f) => readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');

describe('Supabase CLI pin: the scanner can fail', () => {
  const step = (/** @type {string} */ withBlock) =>
    [
      'jobs:',
      '  j:',
      '    steps:',
      '      - name: Setup Supabase CLI',
      '        uses: supabase/setup-cli@v1',
      withBlock,
      '      - name: Next',
      '        run: echo version: latest',
    ].join('\n');

  it('flags version: latest', () => {
    expect(pinProblems(step('        with:\n          version: latest'))).toHaveLength(1);
  });

  it('flags a step with no version', () => {
    expect(pinProblems(step(''))).toHaveLength(1);
    expect(pinProblems(step('        with:\n          github-token: x'))).toHaveLength(1);
  });

  it('flags an env reference that resolves to latest or to nothing', () => {
    const body = step('        with:\n          version: ${{ env.SUPABASE_CLI_VERSION }}');
    expect(pinProblems(`env:\n  SUPABASE_CLI_VERSION: latest\n${body}`)).toHaveLength(1);
    expect(pinProblems(body)).toHaveLength(1);
  });

  it('passes a literal and an env-resolved semver pin', () => {
    expect(pinProblems(step("        with:\n          version: '2.118.0'"))).toEqual([]);
    const body = step('        with:\n          version: ${{ env.SUPABASE_CLI_VERSION }}');
    expect(pinProblems(`env:\n  SUPABASE_CLI_VERSION: 2.118.0\n${body}`)).toEqual([]);
  });
});

describe('Supabase CLI pin: the real workflows', () => {
  it('scans every setup-cli use, and ci.yml has at least the two deploy steps', () => {
    let total = 0;
    for (const f of workflowFiles) {
      const text = read(f);
      const rawCount = text.split(SETUP_CLI).length - 1;
      expect(scanSetupCliSteps(text), `${f}: steps the scanner did not recognise`).toHaveLength(
        rawCount
      );
      total += rawCount;
    }
    expect(scanSetupCliSteps(read(CI_WORKFLOW)).length).toBeGreaterThanOrEqual(MIN_CI_STEPS);
    expect(total).toBeGreaterThanOrEqual(MIN_CI_STEPS);
  });

  it.each(workflowFiles)('%s: no setup-cli step uses latest or omits version', (f) => {
    expect(pinProblems(read(f))).toEqual([]);
  });

  it('ci.yml uses one version in every setup-cli step, the one the guard parses', () => {
    const versions = new Set(scanSetupCliSteps(read(CI_WORKFLOW)).map((s) => s.resolved));
    expect(versions.size).toBe(1);
    const guardVersion = /CLI ([0-9]+\.[0-9]+\.[0-9]+)/.exec(readFileSync(GUARD_PATH, 'utf8'));
    expect(guardVersion, `${GUARD_PATH} header no longer names a CLI version`).not.toBeNull();
    expect([...versions][0]).toBe(guardVersion?.[1]);
  });
});
