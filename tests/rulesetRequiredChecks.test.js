/**
 * Every status check `.github/rulesets/main.json` requires is a `ci.yml` job
 * that reports on every pull request to `main` (plan item M1.3).
 *
 * A required check that never reports blocks a pull request forever, and
 * GitHub does not warn when a ruleset names a check no workflow produces. So
 * for each required context this test finds the `ci.yml` job whose `name` it
 * is, and fails if anything could stop that job reporting on a pull request:
 *   - a `paths`, `paths-ignore` or `types` filter on the `pull_request`
 *     trigger, or a `branches` list without `main` (the workflow never starts,
 *     so nothing reports);
 *   - a job-level `if` other than the one proven to admit pull requests;
 *   - `needs` (a needed job that is skipped skips this one, and a skipped job
 *     reports as passing without having run) or a `strategy` (a matrix renames
 *     the check to `name (value)`).
 * The ruleset's own shape (default branch, pull requests, strict checks, no
 * force pushes or deletion) is asserted too.
 *
 * ci.yml is read line by line, as the other ci.yml tests do (no YAML
 * dependency); the detectors are each shown catching a planted workflow.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RULESET_PATH = path.resolve('.github/rulesets/main.json');
const CI_WORKFLOW_PATH = path.resolve('.github/workflows/ci.yml');

/** Job-level `if` expressions known to let a `pull_request` event through. */
const IFS_ADMITTING_PULL_REQUESTS = new Set(["github.event_name != 'schedule'"]);

const indentOf = (/** @type {string} */ line) => line.length - line.trimStart().length;
const unquote = (/** @type {string} */ value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The lines of the block under the top-level key `key:`, with their indent.
 * @param {string[]} lines
 * @param {string} key
 */
function topLevelBlock(lines, key) {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start === -1) throw new Error(`no top-level "${key}:" in the workflow`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && indentOf(l) === 0) break;
    block.push(l);
  }
  return block;
}

/**
 * The keys directly under `pull_request:` in the `on:` block, with their raw values.
 * @param {string} workflow
 * @returns {Record<string, string> | null} null when the workflow has no pull_request trigger
 */
function pullRequestFilters(workflow) {
  const on = topLevelBlock(workflow.split('\n'), 'on');
  const at = on.findIndex((l) => /^\s*pull_request:/.test(l));
  if (at === -1) return null;
  const triggerIndent = indentOf(on[at]);
  /** @type {Record<string, string>} */
  const filters = {};
  for (let i = at + 1; i < on.length; i += 1) {
    const l = on[i];
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
    if (indentOf(l) <= triggerIndent) break;
    const m = /^\s*([\w-]+):\s*(.*)$/.exec(l);
    if (m && indentOf(l) === triggerIndent + 2) filters[m[1]] = m[2];
  }
  return filters;
}

/**
 * Every job in the workflow: its id and the job-level keys this test reads.
 * @param {string} workflow
 * @returns {{ id: string, name?: string, if?: string, needs?: string, strategy?: string }[]}
 */
function workflowJobs(workflow) {
  const jobsBlock = topLevelBlock(workflow.split('\n'), 'jobs');
  /** @type {{ id: string, name?: string, if?: string, needs?: string, strategy?: string }[]} */
  const jobs = [];
  for (const l of jobsBlock) {
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
    const m = /^(\s*)([\w-]+):\s*(.*)$/.exec(l);
    if (!m) continue;
    if (m[1].length === 2) jobs.push({ id: m[2] });
    else if (m[1].length === 4 && jobs.length > 0) {
      const key = /** @type {'name' | 'if' | 'needs' | 'strategy'} */ (m[2]);
      if (['name', 'if', 'needs', 'strategy'].includes(key)) {
        jobs[jobs.length - 1][key] = key === 'strategy' ? 'present' : unquote(m[3]);
      }
    }
  }
  return jobs;
}

/**
 * Why `context` might never report on a pull request to main; empty when it always does.
 * @param {string} workflow
 * @param {string} context
 */
function reportingProblems(workflow, context) {
  const problems = [];
  const filters = pullRequestFilters(workflow);
  if (filters === null) {
    problems.push('the workflow has no pull_request trigger');
  } else {
    for (const key of Object.keys(filters)) {
      if (key !== 'branches') problems.push(`pull_request has a "${key}" filter`);
    }
    if ('branches' in filters && !/\bmain\b/.test(filters.branches)) {
      problems.push(`pull_request branches (${filters.branches}) leave out main`);
    }
  }
  const matches = workflowJobs(workflow).filter((job) => job.name === context);
  if (matches.length !== 1) {
    problems.push(`${matches.length} jobs are named "${context}" (need exactly 1)`);
    return problems;
  }
  const [job] = matches;
  if (job.if !== undefined && !IFS_ADMITTING_PULL_REQUESTS.has(job.if)) {
    problems.push(`job ${job.id} has "if: ${job.if}", not one known to admit pull requests`);
  }
  if (job.needs !== undefined) problems.push(`job ${job.id} needs ${job.needs}`);
  if (job.strategy !== undefined) problems.push(`job ${job.id} has a strategy (matrix)`);
  return problems;
}

const ruleset = JSON.parse(readFileSync(RULESET_PATH, 'utf8'));
const workflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const rule = (/** @type {string} */ type) =>
  ruleset.rules.find((/** @type {{ type: string }} */ r) => r.type === type);
const requiredContexts = rule('required_status_checks').parameters.required_status_checks.map(
  (/** @type {{ context: string }} */ c) => c.context
);

describe('the main ruleset', () => {
  it('targets the default branch, active', () => {
    expect(ruleset.target).toBe('branch');
    expect(ruleset.enforcement).toBe('active');
    expect(ruleset.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
    expect(ruleset.bypass_actors).toEqual([]);
  });

  it('requires a pull request, and refuses force pushes and deletion', () => {
    expect(rule('pull_request').parameters.required_approving_review_count).toBe(0);
    expect(rule('non_fast_forward')).toBeDefined();
    expect(rule('deletion')).toBeDefined();
  });

  it('requires Build & Test and Deno Mirror Tests from GitHub Actions, up to date (D5)', () => {
    const checks = rule('required_status_checks').parameters;
    expect(checks.strict_required_status_checks_policy).toBe(true);
    expect(requiredContexts).toEqual(['Build & Test', 'Deno Mirror Tests']);
    for (const check of checks.required_status_checks) {
      expect(check.integration_id).toBe(15368); // the GitHub Actions app
    }
  });
});

describe('every required check reports on every pull request', () => {
  it('reads ci.yml (meta: the parser sees its trigger and all of its jobs)', () => {
    expect(pullRequestFilters(workflow)).toEqual({ branches: '[main]' });
    expect(workflowJobs(workflow).map((j) => j.id)).toEqual([
      'keepalive',
      'build-and-test',
      'deno-mirror-tests',
      'deploy-migrations',
      'deploy-edge-functions',
    ]);
  });

  it.each(requiredContexts)('"%s" is a ci.yml job that always reports', (context) => {
    expect(reportingProblems(workflow, context)).toEqual([]);
  });
});

describe('the detectors catch what they guard against (planted workflows)', () => {
  const plant = (/** @type {string} */ from, /** @type {string} */ to) => {
    if (!workflow.includes(from)) throw new Error(`plant target not found: ${from}`);
    return workflow.replace(from, to);
  };

  it('a renamed job', () => {
    const renamed = plant('    name: Build & Test\n', '    name: Build and Test\n');
    expect(reportingProblems(renamed, 'Build & Test')).toEqual([
      '0 jobs are named "Build & Test" (need exactly 1)',
    ]);
  });

  it('a paths filter on pull_request', () => {
    const filtered = plant(
      '  pull_request:\n    branches: [main]\n',
      "  pull_request:\n    branches: [main]\n    paths: ['frontend/**']\n"
    );
    expect(reportingProblems(filtered, 'Deno Mirror Tests')).toEqual([
      'pull_request has a "paths" filter',
    ]);
  });

  it('a job condition that excludes pull requests', () => {
    const pushOnly = plant(
      "  deno-mirror-tests:\n    if: github.event_name != 'schedule'\n",
      "  deno-mirror-tests:\n    if: github.event_name == 'push'\n"
    );
    expect(reportingProblems(pushOnly, 'Deno Mirror Tests')).toEqual([
      `job deno-mirror-tests has "if: github.event_name == 'push'", not one known to admit pull requests`,
    ]);
  });

  it('a needs, which can skip the job and report it as passing', () => {
    const chained = plant(
      '    name: Deno Mirror Tests\n',
      '    name: Deno Mirror Tests\n    needs: [build-and-test]\n'
    );
    expect(reportingProblems(chained, 'Deno Mirror Tests')).toEqual([
      'job deno-mirror-tests needs [build-and-test]',
    ]);
  });

  it('no pull_request trigger at all', () => {
    const noPr = plant('  pull_request:\n    branches: [main]\n', '');
    expect(reportingProblems(noPr, 'Build & Test')).toEqual([
      'the workflow has no pull_request trigger',
    ]);
  });
});
