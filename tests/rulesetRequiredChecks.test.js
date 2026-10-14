/**
 * Every status check `.github/rulesets/main.json` requires is a workflow job
 * that reports on every pull request to `main` (plan items M1.3, M3.2).
 *
 * A required check that never reports blocks a pull request forever, and
 * GitHub does not warn when a ruleset names a check no workflow produces. So
 * for each required context this test finds the one job, in all of
 * `.github/workflows/`, whose `name` it is, and fails if anything could stop
 * that job reporting on a pull request:
 *   - a `paths`, `paths-ignore` or `types` filter on its workflow's
 *     `pull_request` trigger, or a `branches` list without `main` (the
 *     workflow never starts, so nothing reports);
 *   - a job-level `if` other than the one proven to admit pull requests;
 *   - `needs` (a needed job that is skipped skips this one, and a skipped job
 *     reports as passing without having run) or a `strategy` (a matrix renames
 *     the check to `name (value)`);
 *   - no job, or more than one job across the workflows, with that name.
 * The ruleset's own shape (default branch, pull requests, strict checks, no
 * force pushes or deletion) is asserted too.
 *
 * The workflows are enumerated from the directory, not from the ruleset, and
 * read line by line, as the other workflow tests do (no YAML dependency); the
 * detectors are each shown catching a planted workflow.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RULESET_PATH = path.resolve('.github/rulesets/main.json');
const WORKFLOWS_DIR = path.resolve('.github/workflows');

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
  const inline = /^\s*pull_request:\s*(\S.*)?$/.exec(on[at])?.[1];
  if (inline !== undefined && !inline.startsWith('#')) {
    // `pull_request: { paths: [...] }` and the like: a form this reader does not parse.
    return { '(inline)': inline };
  }
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
 * Why a job of this workflow might never report on a pull request to main, from
 * its trigger alone; empty when the trigger always fires.
 * @param {string} workflow
 */
function triggerProblems(workflow) {
  const problems = [];
  const filters = pullRequestFilters(workflow);
  if (filters === null) {
    problems.push('the workflow has no pull_request trigger');
  } else {
    for (const key of Object.keys(filters)) {
      if (key !== 'branches') problems.push(`pull_request has a "${key}" filter`);
    }
    if ('branches' in filters) {
      // Only the one-line list form, every entry a plain branch name (no glob, no `!`).
      const list = /^\[(.*)\]$/.exec(filters.branches.trim());
      const entries = list ? list[1].split(',').map(unquote) : [];
      if (!list || entries.some((b) => !/^[\w./-]+$/.test(b)) || !entries.includes('main')) {
        problems.push(
          `pull_request branches (${filters.branches}) are not a plain list naming main`
        );
      }
    }
  }
  return problems;
}

/**
 * Why `context` might never report on a pull request to main; empty when it always does.
 * @param {Record<string, string>} workflows file name -> source, every workflow in the directory
 * @param {string} context
 */
function reportingProblems(workflows, context) {
  const matches = Object.entries(workflows).flatMap(([file, source]) =>
    workflowJobs(source)
      .filter((job) => job.name === context)
      .map((job) => ({ file, source, job }))
  );
  if (matches.length !== 1) {
    const where = matches.map((m) => `${m.file}:${m.job.id}`).join(', ');
    return [
      `${matches.length} jobs are named "${context}" (need exactly 1)${where ? `: ${where}` : ''}`,
    ];
  }
  const [{ file, source, job }] = matches;
  const problems = triggerProblems(source).map((p) => `${file}: ${p}`);
  if (job.if !== undefined && !IFS_ADMITTING_PULL_REQUESTS.has(job.if)) {
    problems.push(`job ${job.id} has "if: ${job.if}", not one known to admit pull requests`);
  }
  if (job.needs !== undefined) problems.push(`job ${job.id} needs ${job.needs}`);
  if (job.strategy !== undefined) problems.push(`job ${job.id} has a strategy (matrix)`);
  return problems;
}

const ruleset = JSON.parse(readFileSync(RULESET_PATH, 'utf8'));
/** Every workflow file, enumerated from the directory (never from the ruleset). */
const workflows = Object.fromEntries(
  readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => [f, readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')])
);
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

  it('requires CI, the Deno mirror, pgTAP, the dependency audit and the workflow audit from GitHub Actions, up to date (D5, M3.2, M3.5)', () => {
    const checks = rule('required_status_checks').parameters;
    expect(checks.strict_required_status_checks_policy).toBe(true);
    expect(requiredContexts).toEqual([
      'Build & Test',
      'Deno Mirror Tests',
      'Run pgTAP against local Supabase',
      'npm audit (high and critical block)',
      'Workflow audit (zizmor)',
    ]);
    for (const check of checks.required_status_checks) {
      expect(check.integration_id).toBe(15368); // the GitHub Actions app
    }
  });
});

describe('every required check reports on every pull request', () => {
  /**
   * What the line reader must see in each workflow this file was written
   * against: the pull_request filters (null: no pull_request trigger) and the
   * job ids, in order. A workflow added later only has to parse.
   */
  const KNOWN = {
    'audit.yml': { filters: { branches: '[main]' }, jobs: ['audit', 'report-scheduled-failure'] },
    'ci.yml': {
      filters: { branches: '[main]' },
      jobs: [
        'keepalive',
        'build-and-test',
        'deno-mirror-tests',
        'deploy-migrations',
        'deploy-edge-functions',
      ],
    },
    'cleanup-raw-imports.yml': { filters: null, jobs: ['cleanup'] },
    'pgtap.yml': { filters: { branches: '[main]' }, jobs: ['pgtap'] },
  };

  it('reads every workflow (meta: the parser sees each trigger and every job)', () => {
    expect(Object.keys(workflows)).toEqual(expect.arrayContaining(Object.keys(KNOWN)));
    for (const [file, { filters, jobs }] of Object.entries(KNOWN)) {
      expect(pullRequestFilters(workflows[file]), file).toEqual(filters);
      expect(
        workflowJobs(workflows[file]).map((j) => j.id),
        file
      ).toEqual(jobs);
    }
    for (const [file, source] of Object.entries(workflows)) {
      expect(workflowJobs(source).length, `${file}: no jobs parsed`).toBeGreaterThan(0);
    }
  });

  it.each(requiredContexts)('"%s" is a workflow job that always reports', (context) => {
    expect(reportingProblems(workflows, context)).toEqual([]);
  });
});

describe('the detectors catch what they guard against (planted workflows)', () => {
  /** `workflows` with one file's text replaced; throws if the target text is gone. */
  const plant = (
    /** @type {string} */ file,
    /** @type {string} */ from,
    /** @type {string} */ to
  ) => {
    if (!workflows[file].includes(from))
      throw new Error(`plant target not found in ${file}: ${from}`);
    return { ...workflows, [file]: workflows[file].replace(from, to) };
  };
  const CI_PR_TRIGGER = '  pull_request:\n    branches: [main]\n';

  it('a renamed job, in any of the workflows a required check comes from', () => {
    for (const [file, name] of [
      ['ci.yml', 'Build & Test'],
      ['pgtap.yml', 'Run pgTAP against local Supabase'],
      ['audit.yml', 'npm audit (high and critical block)'],
      ['workflow-audit.yml', 'Workflow audit (zizmor)'],
    ]) {
      const renamed = plant(file, `    name: ${name}\n`, `    name: ${name} (renamed)\n`);
      expect(reportingProblems(renamed, name)).toEqual([
        `0 jobs are named "${name}" (need exactly 1)`,
      ]);
    }
  });

  it('a second job with a required name, in another workflow', () => {
    const twice = {
      ...workflows,
      'copy.yml': workflows['pgtap.yml'].replace('  pgtap:\n', '  pgtap-copy:\n'),
    };
    expect(reportingProblems(twice, 'Run pgTAP against local Supabase')).toEqual([
      '2 jobs are named "Run pgTAP against local Supabase" (need exactly 1): pgtap.yml:pgtap, copy.yml:pgtap-copy',
    ]);
  });

  it('a paths filter on pull_request (pgtap.yml had one until M3.2)', () => {
    const filtered = plant(
      'pgtap.yml',
      CI_PR_TRIGGER,
      `${CI_PR_TRIGGER}    paths:\n      - 'supabase/migrations/**'\n`
    );
    expect(reportingProblems(filtered, 'Run pgTAP against local Supabase')).toEqual([
      'pgtap.yml: pull_request has a "paths" filter',
    ]);
    const ciFiltered = plant(
      'ci.yml',
      CI_PR_TRIGGER,
      `${CI_PR_TRIGGER}    paths: ['frontend/**']\n`
    );
    expect(reportingProblems(ciFiltered, 'Deno Mirror Tests')).toEqual([
      'ci.yml: pull_request has a "paths" filter',
    ]);
  });

  it('a job condition that excludes pull requests', () => {
    const pushOnly = plant(
      'ci.yml',
      "  deno-mirror-tests:\n    if: github.event_name != 'schedule'\n",
      "  deno-mirror-tests:\n    if: github.event_name == 'push'\n"
    );
    expect(reportingProblems(pushOnly, 'Deno Mirror Tests')).toEqual([
      `job deno-mirror-tests has "if: github.event_name == 'push'", not one known to admit pull requests`,
    ]);
  });

  it('a needs, which can skip the job and report it as passing', () => {
    const chained = plant(
      'ci.yml',
      '    name: Deno Mirror Tests\n',
      '    name: Deno Mirror Tests\n    needs: [build-and-test]\n'
    );
    expect(reportingProblems(chained, 'Deno Mirror Tests')).toEqual([
      'job deno-mirror-tests needs [build-and-test]',
    ]);
  });

  it('a branches list that excludes main, or names it only inside a pattern', () => {
    for (const branches of ["['**', '!main']", '[main-*]', '[release]']) {
      const narrowed = plant(
        'audit.yml',
        CI_PR_TRIGGER,
        `  pull_request:\n    branches: ${branches}\n`
      );
      expect(reportingProblems(narrowed, 'npm audit (high and critical block)')).toEqual([
        `audit.yml: pull_request branches (${branches}) are not a plain list naming main`,
      ]);
    }
  });

  it('an inline pull_request mapping it cannot read', () => {
    const inline = plant(
      'ci.yml',
      CI_PR_TRIGGER,
      "  pull_request: { branches: [main], paths: ['docs/**'] }\n"
    );
    expect(reportingProblems(inline, 'Build & Test')).toEqual([
      'ci.yml: pull_request has a "(inline)" filter',
    ]);
  });

  it('no pull_request trigger at all', () => {
    const noPr = plant('pgtap.yml', CI_PR_TRIGGER, '');
    expect(reportingProblems(noPr, 'Run pgTAP against local Supabase')).toEqual([
      'pgtap.yml: the workflow has no pull_request trigger',
    ]);
  });
});
