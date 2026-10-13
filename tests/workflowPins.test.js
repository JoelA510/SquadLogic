// @vitest-environment node
/**
 * The workflows' own supply chain and the coverage gate, held offline in
 * `npm run test` (plan items M3.5 and M3.1; audit findings 7.4 and 6.1).
 *
 * 1. Every `uses:` in `.github/workflows/` names a full 40-character commit
 *    SHA with its release in a `# vX.Y.Z` comment. A tag (`@v7`) runs whatever
 *    the tag is moved to; the comment is what Dependabot's github-actions
 *    updates rewrite beside the SHA, and what a reviewer reads. zizmor (below)
 *    checks the same online in CI; this is the offline floor.
 * 2. `workflow-audit.yml` runs a pinned zizmor on every pull request to main,
 *    where a finding fails the job: no paths filter, no `if`, no
 *    `continue-on-error`, no `|| true`, no `--no-exit-codes`, no SARIF output
 *    (which exits 0 on findings).
 * 3. Build & Test runs `npm run test:coverage`, and vitest.config.js carries
 *    the thresholds that make it fail.
 *
 * The workflows are read line by line, as the other workflow tests are (no
 * YAML dependency). The pin scan's subject set is every line that mentions
 * `uses:` outside a comment, counted independently of the pattern the pin must
 * match, so a step written in a shape the scanner misses is a loud failure.
 * Each detector is shown catching a planted defect.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_DIR = path.resolve('.github/workflows');
const AUDIT_WORKFLOW = 'workflow-audit.yml';
const CI_WORKFLOW = 'ci.yml';
/**
 * A literal floor, not derived from the files: the `uses:` lines on main when
 * the pins landed (2 in audit.yml, 13 in ci.yml, 3 in pgtap.yml, 1 in
 * workflow-audit.yml). A scan that finds fewer examined less than was there.
 */
const MIN_USES = 19;

const indentOf = (/** @type {string} */ line) => line.length - line.trimStart().length;
const isCode = (/** @type {string} */ line) =>
  line.trim() !== '' && !line.trimStart().startsWith('#');

/** The part of a line before a ` #` comment (YAML needs the space). */
const beforeComment = (/** @type {string} */ line) =>
  line.trimStart().startsWith('#') ? '' : line.replace(/\s+#.*$/, '');

const PIN = /^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})\s+#\s*v\d+\.\d+\.\d+\s*$/;
const LOCAL = /^\s*(?:-\s+)?uses:\s*\.\//;

/**
 * Every `uses:` that is not pinned by commit with its release in a comment.
 * @param {string} text workflow source
 * @returns {{ scanned: number, problems: string[] }}
 */
function pinProblems(text) {
  const problems = [];
  let scanned = 0;
  text.split('\n').forEach((line, i) => {
    if (!beforeComment(line).includes('uses:')) return;
    scanned += 1;
    if (!PIN.test(line) && !LOCAL.test(line)) problems.push(`line ${i + 1}: ${line.trim()}`);
  });
  return { scanned, problems };
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (/** @type {string} */ f) => readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');

describe('action pins: the scanner can fail', () => {
  const step = (/** @type {string} */ uses) =>
    [
      'jobs:',
      '  j:',
      '    steps:',
      `      - uses: ${uses}`,
      '        with:',
      '          a: b',
    ].join('\n');
  const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

  it.each([
    ['a tag', 'actions/checkout@v7'],
    ['a full release tag', 'actions/checkout@v7.0.1'],
    ['a branch', 'actions/checkout@main'],
    ['a short SHA', 'actions/checkout@3d3c42e # v7.0.1'],
    ['a SHA with no comment', `actions/checkout@${SHA}`],
    ['a SHA commented with a major only', `actions/checkout@${SHA} # v7`],
    ['an uppercase (non-git) SHA', `actions/checkout@${SHA.toUpperCase()} # v7.0.1`],
  ])('flags %s', (_label, uses) => {
    const { scanned, problems } = pinProblems(step(uses));
    expect(scanned).toBe(1);
    expect(problems).toHaveLength(1);
  });

  it('passes a SHA pin with its release, a sub-path action and a local action', () => {
    expect(pinProblems(step(`actions/checkout@${SHA} # v7.0.1`)).problems).toEqual([]);
    expect(pinProblems(step(`github/codeql-action/init@${SHA} # v4.31.2`)).problems).toEqual([]);
    expect(pinProblems(step('./.github/actions/setup')).problems).toEqual([]);
  });

  it('counts a step in a shape the pattern does not know, and ignores comments', () => {
    const odd = '      - { name: x, uses: actions/checkout@v7 }';
    expect(pinProblems(odd).scanned).toBe(1);
    expect(pinProblems(odd).problems).toHaveLength(1);
    expect(pinProblems('# every `uses:` is pinned\n  x: 1 # uses: y@v1').scanned).toBe(0);
  });
});

describe('action pins: the real workflows', () => {
  it('pins every action by full commit SHA with a # vX.Y.Z comment', () => {
    let total = 0;
    const problems = [];
    for (const f of workflowFiles) {
      const result = pinProblems(read(f));
      total += result.scanned;
      problems.push(...result.problems.map((p) => `${f} ${p}`));
    }
    expect(problems).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(MIN_USES);
  });

  it('keeps one release per action, so each SHA matches its comment everywhere', () => {
    /** @type {Map<string, Set<string>>} */
    const seen = new Map();
    for (const f of workflowFiles) {
      for (const line of read(f).split('\n')) {
        const m = PIN.exec(line);
        if (!m) continue;
        const key = `${m[1]}@${m[2]}`;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)?.add(line.replace(/^.*#\s*/, '').trim());
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const [key, comments] of seen)
      expect([key, [...comments]]).toEqual([key, [...comments].slice(0, 1)]);
  });

  it('has Dependabot updating the pins (github-actions ecosystem)', () => {
    const dependabot = readFileSync(path.resolve('.github/dependabot.yml'), 'utf8');
    expect(dependabot).toMatch(/^\s*- package-ecosystem: github-actions\s*$/m);
  });
});

// ── zizmor ──────────────────────────────────────────────────────────────────

/** The lines under the top-level key `key:`. */
function topLevelBlock(/** @type {string[]} */ lines, /** @type {string} */ key) {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start === -1) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (isCode(l) && indentOf(l) === 0) break;
    block.push(l);
  }
  return block;
}

/** Problems with the `on:` block's pull_request trigger; empty when it fires on every PR to main. */
function pullRequestProblems(/** @type {string[]} */ lines) {
  const on = topLevelBlock(lines, 'on');
  if (!on) return ['no top-level "on:" block'];
  const at = on.findIndex((l) => /^\s*pull_request:/.test(l));
  if (at === -1) return ['no pull_request trigger'];
  const problems = [];
  const prIndent = indentOf(on[at]);
  for (let i = at + 1; i < on.length && (!isCode(on[i]) || indentOf(on[i]) > prIndent); i += 1) {
    if (/^\s*(paths|paths-ignore|types):/.test(on[i])) {
      problems.push(`pull_request is filtered (${on[i].trim()})`);
    }
    if (/^\s*branches:/.test(on[i]) && !/\bmain\b/.test(on[i])) {
      problems.push('pull_request branches do not include main');
    }
  }
  return problems;
}

/**
 * The step (from its `- ` line to the next) that contains line `at`.
 * @param {string[]} lines
 * @param {number} at
 */
function stepAround(lines, at) {
  let start = at;
  while (start > 0 && !/^\s*- /.test(lines[start])) start -= 1;
  const stepIndent = indentOf(lines[start]);
  let end = at + 1;
  while (end < lines.length && !(isCode(lines[end]) && indentOf(lines[end]) <= stepIndent))
    end += 1;
  return lines.slice(start, end);
}

/**
 * Why workflow-audit.yml could not fail a pull request on a zizmor finding;
 * empty when it can.
 * @param {string} workflow
 * @returns {string[]}
 */
function zizmorProblems(workflow) {
  const lines = workflow.split('\n');
  const problems = pullRequestProblems(lines);
  const runs = lines
    .map((l, i) => ({ l: beforeComment(l), i }))
    .filter(({ l }) => /^\s*run:.*\bzizmor\b/.test(l));
  if (runs.length !== 1) return [...problems, `expected one zizmor run step, found ${runs.length}`];
  const { l: run, i } = runs[0];
  if (!/zizmor==\d+\.\d+\.\d+['"\s]/.test(run))
    problems.push('zizmor is not pinned to one release');
  if (/--no-exit-codes|--format[= ]sarif|\|\||;\s*true|\bexit 0\b/.test(run)) {
    problems.push(`the zizmor step cannot fail (${run.trim()})`);
  }
  if (!/\s\.\s*$/.test(run)) problems.push('zizmor does not audit the whole repository (.)');
  if (stepAround(lines, i).some((l) => isCode(l) && /^\s*if:/.test(l))) {
    problems.push('the zizmor step has an if');
  }
  if (lines.some((l) => isCode(l) && /continue-on-error:\s*true/.test(l))) {
    problems.push('a step or job sets continue-on-error');
  }
  const jobs = topLevelBlock(lines, 'jobs') ?? [];
  if (jobs.some((l) => isCode(l) && /^ {4}(if|needs):/.test(l))) {
    problems.push('the job has an if or needs');
  }
  return problems;
}

describe('workflow-audit.yml', () => {
  const workflow = read(AUDIT_WORKFLOW);

  it('runs a pinned zizmor on every pull request to main, able to fail', () => {
    expect(zizmorProblems(workflow)).toEqual([]);
  });

  it('configures zizmor with the same release wait as npm and Dependabot', () => {
    const config = readFileSync(path.resolve('.github/zizmor.yml'), 'utf8');
    const days = /^\s*days:\s*(\d+)\s*$/m.exec(config)?.[1];
    const npmrc = readFileSync(path.resolve('.npmrc'), 'utf8');
    const npmDays = /^min-release-age=(\d+)\s*$/m.exec(npmrc)?.[1];
    expect(days).toBeDefined();
    expect(days).toBe(npmDays);
    const dependabot = readFileSync(path.resolve('.github/dependabot.yml'), 'utf8');
    const cooldowns = [...dependabot.matchAll(/^\s*default-days:\s*(\d+)\s*$/gm)].map((m) => m[1]);
    expect(cooldowns.length).toBeGreaterThanOrEqual(2);
    for (const d of cooldowns) expect(Number(d)).toBeGreaterThanOrEqual(Number(days));
  });

  const RUN = "run: pipx run --spec 'zizmor==1.30.1' zizmor --format=github .";

  it.each([
    [
      'a paths filter',
      (/** @type {string} */ w) =>
        w.replace(
          '  pull_request:\n    branches: [main]\n',
          '  pull_request:\n    branches: [main]\n    paths: [x]\n'
        ),
      'pull_request is filtered',
    ],
    [
      'no pull_request trigger',
      (/** @type {string} */ w) => w.replace('  pull_request:\n', '  pull_request_target:\n'),
      'no pull_request trigger',
    ],
    [
      'zizmor unpinned',
      (/** @type {string} */ w) => w.replace("--spec 'zizmor==1.30.1' zizmor", 'zizmor'),
      'not pinned',
    ],
    [
      '--no-exit-codes',
      (/** @type {string} */ w) =>
        w.replace(RUN, RUN.replace('zizmor --format', 'zizmor --no-exit-codes --format')),
      'cannot fail',
    ],
    [
      'SARIF output',
      (/** @type {string} */ w) => w.replace(RUN, RUN.replace('--format=github', '--format=sarif')),
      'cannot fail',
    ],
    ['an `|| true`', (/** @type {string} */ w) => w.replace(RUN, `${RUN} || true`), 'cannot fail'],
    [
      'one workflow instead of the repository',
      (/** @type {string} */ w) => w.replace(RUN, RUN.replace(/ \.$/, ' .github/workflows/ci.yml')),
      'whole repository',
    ],
    [
      'continue-on-error',
      (/** @type {string} */ w) =>
        w.replace(
          '        env:\n          GH_TOKEN',
          '        continue-on-error: true\n        env:\n          GH_TOKEN'
        ),
      'continue-on-error',
    ],
    [
      'an if on the step',
      (/** @type {string} */ w) =>
        w.replace(
          '      - name: Audit the workflows (zizmor)\n',
          "      - name: Audit the workflows (zizmor)\n        if: github.event_name == 'push'\n"
        ),
      'the zizmor step has an if',
    ],
    [
      'an if on the job',
      (/** @type {string} */ w) =>
        w.replace('    runs-on: ubuntu-latest', '    if: false\n    runs-on: ubuntu-latest'),
      'the job has an if or needs',
    ],
    [
      'the step removed',
      (/** @type {string} */ w) => w.replace(RUN, 'run: echo skipped'),
      'expected one zizmor run step, found 0',
    ],
  ])('catches a planted workflow with %s', (_label, plant, problem) => {
    const planted = plant(workflow);
    expect(planted).not.toBe(workflow);
    expect(zizmorProblems(planted).join('\n')).toContain(problem);
  });
});

// ── Coverage (M3.1) ─────────────────────────────────────────────────────────

const TEST_STEP = 'Unit & Integration Tests';

/** Why Build & Test's test step would not fail on coverage below the thresholds. */
function coverageStepProblems(/** @type {string} */ workflow) {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${TEST_STEP}`);
  if (at === -1) return [`no step named "${TEST_STEP}"`];
  const step = stepAround(lines, at);
  const problems = [];
  const run = step.find((l) => /^\s*run:/.test(l));
  if (!run || !/^\s*run: npm run test:coverage\s*$/.test(beforeComment(run))) {
    problems.push(`the step does not run exactly "npm run test:coverage" (${run?.trim()})`);
  }
  if (step.some((l) => isCode(l) && /continue-on-error:\s*true/.test(l))) {
    problems.push('the step sets continue-on-error');
  }
  // The one `if` it may carry is the docs-only skip every Build & Test step has.
  const ifs = step.filter((l) => isCode(l) && /^\s*if:/.test(l)).map((l) => l.trim());
  if (ifs.some((l) => l !== "if: steps.changes.outputs.docs_only != 'true'")) {
    problems.push(`the step has another if (${ifs.join('; ')})`);
  }
  return problems;
}

describe('coverage in CI', () => {
  const workflow = read(CI_WORKFLOW);

  it('Build & Test runs npm run test:coverage, able to fail', () => {
    expect(coverageStepProblems(workflow)).toEqual([]);
  });

  it('test:coverage is vitest with coverage, and the config sets every threshold', async () => {
    const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
    expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage');
    const { default: config } = await import('../vitest.config.js');
    const thresholds = config.test?.coverage?.thresholds ?? {};
    for (const key of ['statements', 'branches', 'functions', 'lines']) {
      expect(thresholds[key], key).toBeGreaterThan(0);
    }
  });

  it.each([
    [
      'the plain test command',
      (/** @type {string} */ w) => w.replace('run: npm run test:coverage', 'run: npm run test'),
      'does not run exactly',
    ],
    [
      'an `|| true`',
      (/** @type {string} */ w) =>
        w.replace('run: npm run test:coverage', 'run: npm run test:coverage || true'),
      'does not run exactly',
    ],
    [
      'continue-on-error',
      (/** @type {string} */ w) =>
        w.replace(
          `      - name: ${TEST_STEP}\n`,
          `      - name: ${TEST_STEP}\n        continue-on-error: true\n`
        ),
      'continue-on-error',
    ],
    [
      'another if',
      (/** @type {string} */ w) =>
        w.replace(
          `      - name: ${TEST_STEP}\n        if: steps.changes.outputs.docs_only != 'true'`,
          `      - name: ${TEST_STEP}\n        if: github.event_name == 'push'`
        ),
      'another if',
    ],
    [
      'the step renamed',
      (/** @type {string} */ w) => w.replace(`- name: ${TEST_STEP}`, '- name: Tests'),
      'no step named',
    ],
  ])('catches a planted ci.yml with %s', (_label, plant, problem) => {
    const planted = plant(workflow);
    expect(planted).not.toBe(workflow);
    expect(coverageStepProblems(planted).join('\n')).toContain(problem);
  });
});
