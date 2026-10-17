// @vitest-environment node
/**
 * The workflows' own supply chain and the coverage gate, held offline in
 * `npm run test` (plan items M3.5 and M3.1; audit findings 7.4 and 6.1).
 *
 * 1. Every `uses:` in `.github/workflows/` names a full 40-character commit
 *    SHA with its release in a `# vX.Y.Z` comment. A tag (`@v7`) runs whatever
 *    the tag is moved to; the comment is what Dependabot's github-actions
 *    updates rewrite beside the SHA, and what a reviewer reads. Each action is
 *    on one release across every workflow. Whether a SHA really is the release
 *    its comment names can only be checked online: zizmor does that in CI.
 * 2. `workflow-audit.yml` runs a pinned zizmor on every pull request to main,
 *    where a finding fails the job: no paths or branch filter that skips main,
 *    no `if`, no `continue-on-error`, and the run line exactly the one known
 *    to fail on findings (an allowlist, not a list of the ways to defeat it:
 *    `--no-exit-codes`, SARIF output, `--min-severity`, `--offline`, a
 *    persona, another config, `|| :`). `.github/zizmor.yml` loosens nothing
 *    but the Dependabot cooldown, and that to the release wait npm uses.
 * 3. Build & Test runs `npm run test:coverage`, and vitest.config.js carries
 *    the thresholds that make it fail; the wall-clock benchmark is excluded
 *    from that run (coverage slows it ~9x) and runs alone as `test:perf`.
 * 4. Build & Test runs `npm run build` (the frontend build, M6.1), with a
 *    stand-in Sentry DSN so the bundle budget measures what production ships.
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
import { validateClientEnv } from '../frontend/src/envRules.js';

const WORKFLOWS_DIR = path.resolve('.github/workflows');
const AUDIT_WORKFLOW = 'workflow-audit.yml';
const CI_WORKFLOW = 'ci.yml';
/**
 * A literal floor, not derived from the files: the `uses:` lines when the pins
 * landed (2 in audit.yml, 13 in ci.yml, 1 in dbharness.yml, 3 in pgtap.yml, 1
 * in workflow-audit.yml). A scan that finds fewer examined less than was there.
 */
const MIN_USES = 20;

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

/**
 * Actions pinned to more than one SHA or release across the given workflows.
 * @param {string[]} texts workflow sources
 */
function releaseProblems(texts) {
  /** @type {Map<string, Set<string>>} */
  const pins = new Map();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const m = PIN.exec(line);
      if (!m) continue;
      const release = /#\s*(v\S+)/.exec(line)?.[1];
      if (!pins.has(m[1])) pins.set(m[1], new Set());
      pins.get(m[1])?.add(`${m[2]} ${release}`);
    }
  }
  return {
    actions: pins.size,
    problems: [...pins]
      .filter(([, set]) => set.size > 1)
      .map(([action, set]) => `${action}: ${[...set].join(' | ')}`),
  };
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

  it('flags an action on two releases, or one SHA under two release comments', () => {
    const OTHER = '820762786026740c76f36085b0efc47a31fe5020';
    const two = releaseProblems([
      step(`actions/checkout@${SHA} # v7.0.1`),
      step(`actions/checkout@${OTHER} # v7.0.0`),
    ]);
    expect(two.problems).toHaveLength(1);
    const relabelled = releaseProblems([
      step(`actions/checkout@${SHA} # v7.0.1`),
      step(`actions/checkout@${SHA} # v6.0.0`),
    ]);
    expect(relabelled.problems).toHaveLength(1);
    expect(releaseProblems([step(`actions/checkout@${SHA} # v7.0.1`)]).problems).toEqual([]);
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

  it('keeps each action on one SHA and one release across every workflow', () => {
    const { actions, problems } = releaseProblems(workflowFiles.map(read));
    expect(problems).toEqual([]);
    // checkout, setup-node, upload-artifact, setup-deno, setup-cli.
    expect(actions).toBeGreaterThanOrEqual(5);
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
    if (/^\s*(paths|paths-ignore|branches-ignore|types):/.test(on[i])) {
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
 * The one run line known to fail on any finding: a pinned release, online
 * (the job's token), every audit at its default severity, persona and
 * configuration, GitHub annotations (exit 14 on findings, unlike SARIF), over
 * the live `.github` directory, and nothing after it.
 */
const ZIZMOR_RUN =
  /^\s*run: pipx run --spec 'zizmor==\d+\.\d+\.\d+' zizmor --format=github \.github\s*$/;

/**
 * Why .github/zizmor.yml loosens more than it should; empty when the only rule
 * it configures is the Dependabot cooldown, and it disables and ignores nothing.
 * @param {string} config
 */
function zizmorConfigProblems(config) {
  const lines = config.split('\n').filter(isCode);
  const problems = [];
  for (const l of lines.filter((x) => indentOf(x) === 0)) {
    if (l.trim() !== 'rules:') problems.push(`unexpected top-level key (${l.trim()})`);
  }
  for (const l of lines.filter((x) => indentOf(x) === 2)) {
    if (l.trim() !== 'dependabot-cooldown:') problems.push(`configures ${l.trim()}`);
  }
  for (const l of lines) {
    if (/^\s*(disable|ignore):/.test(l)) problems.push(`turns an audit off (${l.trim()})`);
  }
  return problems;
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
  if (!ZIZMOR_RUN.test(run)) {
    problems.push(`the zizmor run line is not the one known to fail on findings (${run.trim()})`);
  }
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

  it('configures zizmor with the same release wait as npm and Dependabot, and nothing else', () => {
    const config = readFileSync(path.resolve('.github/zizmor.yml'), 'utf8');
    expect(zizmorConfigProblems(config)).toEqual([]);
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

  it.each([
    ['a disabled audit', '  unpinned-uses:\n    disable: true\n', 'configures unpinned-uses'],
    ['an ignored file', '  artipacked:\n    ignore:\n      - ci.yml\n', 'turns an audit off'],
    [
      'an ignore on the cooldown rule',
      '    ignore:\n      - dependabot.yml\n',
      'turns an audit off',
    ],
  ])('catches a planted zizmor.yml with %s', (_label, plant, problem) => {
    const config = readFileSync(path.resolve('.github/zizmor.yml'), 'utf8');
    expect(zizmorConfigProblems(`${config}${plant}`).join('\n')).toContain(problem);
  });

  const RUN = "run: pipx run --spec 'zizmor==1.30.1' zizmor --format=github .github";
  const runWith =
    (/** @type {string} */ from, /** @type {string} */ to) => (/** @type {string} */ w) =>
      w.replace(RUN, RUN.replace(from, to));

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
      'branches-ignore: [main]',
      (/** @type {string} */ w) =>
        w.replace(
          '  pull_request:\n    branches: [main]\n',
          '  pull_request:\n    branches-ignore: [main]\n'
        ),
      'pull_request is filtered',
    ],
    [
      'zizmor unpinned',
      runWith("--spec 'zizmor==1.30.1' zizmor", 'zizmor'),
      'not the one known to fail',
    ],
    ['a version range', runWith('zizmor==1.30.1', 'zizmor>=1.30'), 'not the one known to fail'],
    [
      '--no-exit-codes',
      runWith('zizmor --format', 'zizmor --no-exit-codes --format'),
      'not the one known to fail',
    ],
    ['SARIF output', runWith('--format=github', '--format=sarif'), 'not the one known to fail'],
    [
      '--min-severity',
      runWith('--format=github', '--format=github --min-severity=high'),
      'not the one known to fail',
    ],
    [
      '--offline',
      runWith('--format=github', '--format=github --offline'),
      'not the one known to fail',
    ],
    [
      'another persona',
      runWith('--format=github', '--format=github --persona=regular'),
      'not the one known to fail',
    ],
    [
      'another config',
      runWith('--format=github', '--format=github --config /dev/null'),
      'not the one known to fail',
    ],
    ['an `|| true`', runWith('.github', '.github || true'), 'not the one known to fail'],
    ['an `|| :`', runWith('.github', '.github || :'), 'not the one known to fail'],
    [
      'one workflow only',
      runWith(' .github', ' .github/workflows/ci.yml'),
      'not the one known to fail',
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

// ── Coverage (M3.1) and the benchmark it must not time ──────────────────────

const TEST_STEP = 'Unit & Integration Tests';
const PERF_STEP = 'Performance benchmark';
const PERF_FILE = 'tests/performance.test.js';

/**
 * Why a Build & Test step would not run `command` able to fail the job.
 * @param {string} workflow
 * @param {string} name the step's name
 * @param {string} command the exact `run:` it must have
 */
function stepProblems(workflow, name, command) {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at === -1) return [`no step named "${name}"`];
  const step = stepAround(lines, at);
  const problems = [];
  const run = step.find((l) => /^\s*run:/.test(l));
  if (!run || beforeComment(run).trim() !== `run: ${command}`) {
    problems.push(`the step does not run exactly "${command}" (${run?.trim()})`);
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

describe('coverage and the benchmark in CI', () => {
  const workflow = read(CI_WORKFLOW);
  const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));

  it('Build & Test runs npm run test:coverage, able to fail', () => {
    expect(stepProblems(workflow, TEST_STEP, 'npm run test:coverage')).toEqual([]);
  });

  it('Build & Test runs the benchmark alone, without coverage, able to fail', () => {
    expect(stepProblems(workflow, PERF_STEP, 'npm run test:perf')).toEqual([]);
    expect(pkg.scripts['test:perf']).toBe(`vitest run ${PERF_FILE}`);
  });

  it('test:coverage excludes the benchmark, and only that one file', () => {
    // v8's instrumentation slows the team-generation engine about 9x, so the
    // benchmark timed under coverage measured the instrumentation.
    expect(pkg.scripts['test:coverage']).toBe(`vitest run --coverage --exclude ${PERF_FILE}`);
  });

  it('the config sets every threshold, overall and for the hooks', async () => {
    const { default: config } = await import('../vitest.config.js');
    const thresholds = config.test?.coverage?.thresholds ?? {};
    const hooks = thresholds['frontend/src/hooks/**'] ?? {};
    for (const key of ['statements', 'branches', 'functions', 'lines']) {
      expect(thresholds[key], key).toBeGreaterThan(0);
      // The hooks' own floor: the core outweighs them in the overall figure.
      expect(hooks[key], `hooks ${key}`).toBeGreaterThan(0);
    }
  });

  it.each([
    [
      'the plain test command',
      TEST_STEP,
      'npm run test:coverage',
      (/** @type {string} */ w) => w.replace('run: npm run test:coverage', 'run: npm run test'),
      'does not run exactly',
    ],
    [
      'an `|| true`',
      TEST_STEP,
      'npm run test:coverage',
      (/** @type {string} */ w) =>
        w.replace('run: npm run test:coverage', 'run: npm run test:coverage || true'),
      'does not run exactly',
    ],
    [
      'continue-on-error',
      TEST_STEP,
      'npm run test:coverage',
      (/** @type {string} */ w) =>
        w.replace(
          `      - name: ${TEST_STEP}\n`,
          `      - name: ${TEST_STEP}\n        continue-on-error: true\n`
        ),
      'continue-on-error',
    ],
    [
      'another if',
      TEST_STEP,
      'npm run test:coverage',
      (/** @type {string} */ w) =>
        w.replace(
          `      - name: ${TEST_STEP}\n        if: steps.changes.outputs.docs_only != 'true'`,
          `      - name: ${TEST_STEP}\n        if: github.event_name == 'push'`
        ),
      'another if',
    ],
    [
      'the step renamed',
      TEST_STEP,
      'npm run test:coverage',
      (/** @type {string} */ w) => w.replace(`- name: ${TEST_STEP}`, '- name: Tests'),
      'no step named',
    ],
    [
      'the benchmark step removed',
      PERF_STEP,
      'npm run test:perf',
      (/** @type {string} */ w) => w.replace(`- name: ${PERF_STEP}`, '- name: Benchmark'),
      'no step named',
    ],
    [
      'the benchmark made unable to fail',
      PERF_STEP,
      'npm run test:perf',
      (/** @type {string} */ w) =>
        w.replace('run: npm run test:perf', 'run: npm run test:perf || true'),
      'does not run exactly',
    ],
    [
      'the benchmark on push only',
      PERF_STEP,
      'npm run test:perf',
      (/** @type {string} */ w) =>
        w.replace(
          `      - name: ${PERF_STEP}\n        if: steps.changes.outputs.docs_only != 'true'`,
          `      - name: ${PERF_STEP}\n        if: github.event_name == 'push'`
        ),
      'another if',
    ],
  ])('catches a planted ci.yml with %s', (_label, name, command, plant, problem) => {
    const planted = plant(workflow);
    expect(planted).not.toBe(workflow);
    expect(stepProblems(planted, name, command).join('\n')).toContain(problem);
  });
});

// ── The build (M6.1, audit finding 7.5) ─────────────────────────────────────

const BUILD_STEP = 'Build Frontend';

/**
 * The `env:` of Build & Test's build step, as name to value (quotes stripped).
 * @param {string} workflow
 * @returns {Record<string, string>}
 */
function buildStepEnv(workflow) {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${BUILD_STEP}`);
  if (at === -1) return {};
  const step = stepAround(lines, at);
  const start = step.findIndex((l) => /^\s*env:\s*$/.test(l));
  if (start === -1) return {};
  const indent = indentOf(step[start]);
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of step.slice(start + 1)) {
    if (!isCode(line)) continue;
    if (indentOf(line) <= indent) break;
    const match = /^\s*([A-Z_][A-Z0-9_]*):\s*'?([^'#]*?)'?\s*$/.exec(beforeComment(line));
    if (match) env[match[1]] = match[2];
  }
  return env;
}

describe('the build in CI', () => {
  const workflow = read(CI_WORKFLOW);
  const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));

  it('Build & Test runs npm run build, able to fail', () => {
    // Standard node.ci-runs-gate: CI runs the project's `build` script. It used
    // to be `node scripts/build.js`, an import check CI never ran, while CI
    // built through `frontend:build`.
    expect(stepProblems(workflow, BUILD_STEP, 'npm run build')).toEqual([]);
  });

  it('npm run build is the frontend build', () => {
    expect(pkg.scripts.build).toBe('npm run frontend:build');
    expect(pkg.scripts['frontend:build']).toBe(
      'node scripts/runViteWithPersistenceEndpoint.js build'
    );
  });

  it('builds with Sentry on, as production does, so the bundle budget measures that shape', () => {
    // Without a DSN, main.jsx's `if (SENTRY_DSN)` folds away and the SDK's
    // init and integrations are not bundled (plan M6). The value is a
    // well-formed stand-in on a host that never resolves.
    const env = buildStepEnv(workflow);
    const dsn = env.VITE_SENTRY_DSN;
    expect(dsn, 'the build step sets no VITE_SENTRY_DSN').toBeDefined();
    expect(new URL(dsn).hostname).toMatch(/\.invalid$/);
    const { problems } = validateClientEnv(env, { production: true });
    expect(problems).toEqual([]);
  });

  it('catches a planted build step without the DSN', () => {
    const planted = workflow.replace(/^\s+VITE_SENTRY_DSN: .*\n/m, '');
    expect(planted).not.toBe(workflow);
    expect(buildStepEnv(planted).VITE_SENTRY_DSN).toBeUndefined();
    // Meta: the parser still reads the step's other variables.
    expect(Object.keys(buildStepEnv(planted))).toContain('VITE_SUPABASE_URL');
  });

  it.each([
    [
      'the frontend build named directly',
      (/** @type {string} */ w) => w.replace('run: npm run build', 'run: npm run frontend:build'),
      'does not run exactly',
    ],
    [
      'an `|| true`',
      (/** @type {string} */ w) => w.replace('run: npm run build', 'run: npm run build || true'),
      'does not run exactly',
    ],
    [
      'the step renamed',
      (/** @type {string} */ w) => w.replace(`- name: ${BUILD_STEP}`, '- name: Build'),
      'no step named',
    ],
  ])('catches a planted ci.yml with %s', (_label, plant, problem) => {
    const planted = plant(workflow);
    expect(planted).not.toBe(workflow);
    expect(stepProblems(planted, BUILD_STEP, 'npm run build').join('\n')).toContain(problem);
  });
});
