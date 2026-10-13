// @vitest-environment node
/**
 * The dependency audit gate (scripts/check-audit.mjs) and the workflow that
 * runs it (.github/workflows/audit.yml); plan item M2.1, audit finding 8.1.
 *
 * Ported from agent-ready-template 1.0.0's scripts/__tests__/check-audit.test.ts.
 * The gate is driven on saved `npm audit --json` reports (`--input`), so no
 * case depends on the network or on what the registry reports today. Every
 * failure the gate exists for (an unwaived high, an expired waiver, a stale
 * waiver, a report it cannot account for) is a case here that must exit
 * non-zero; the clean case beside each is what proves the failure is the
 * planted defect and not a broken harness.
 *
 * The workflow half reads audit.yml line by line, as the other workflow tests
 * do (no YAML dependency), and each detector is shown catching a planted
 * workflow.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/check-audit.mjs');
const REGISTER = path.resolve('docs/security/audit-waivers.json');
const WORKFLOW = path.resolve('.github/workflows/audit.yml');
const TODAY = '2026-10-13';
/** @type {string[]} */
const dirs = [];

// Shapes taken from a real `npm audit --json` report (auditReportVersion 2):
// each package entry lists advisories as objects in `via`, or as strings
// pointing at another package's entry, and `metadata.vulnerabilities` counts
// package entries by severity.
function advisory(ghsa, severity, title = `${ghsa} title`) {
  return {
    source: 1,
    name: 'x',
    title,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: '<1',
  };
}

function report(vulns, metadataOverride) {
  /** @type {Record<string, number>} */
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const v of Object.values(vulns)) counts[v.severity] = (counts[v.severity] ?? 0) + 1;
  return {
    auditReportVersion: 2,
    vulnerabilities: vulns,
    metadata: {
      vulnerabilities: metadataOverride ?? counts,
      dependencies: { prod: 80, dev: 500, optional: 0, peer: 0, peerOptional: 0, total: 580 },
    },
  };
}

const waiver = (overrides = {}) => ({
  advisory: 'GHSA-aaaa-bbbb-cccc',
  package: 'brace-expansion',
  reason: 'Only reachable through a build-time glob over our own source tree; no user input.',
  owner: 'repository owner',
  expires: '2026-11-30',
  ...overrides,
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'check-audit-'));
  dirs.push(dir);
  return dir;
}

/**
 * @param {unknown} auditReport a report object, or raw text
 * @param {unknown[] | string} [waivers] waiver entries, or raw register text
 * @param {string[]} [extra] more arguments
 * @param {Record<string, string>} [env] environment overrides
 */
function run(auditReport, waivers = [], extra = [], env = {}) {
  const dir = scratch();
  writeFileSync(
    join(dir, 'audit.json'),
    typeof auditReport === 'string' ? auditReport : JSON.stringify(auditReport)
  );
  writeFileSync(
    join(dir, 'waivers.json'),
    typeof waivers === 'string' ? waivers : JSON.stringify({ waivers })
  );
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--input',
      join(dir, 'audit.json'),
      '--waivers',
      join(dir, 'waivers.json'),
      '--today',
      TODAY,
      ...extra,
    ],
    // GITHUB_STEP_SUMMARY is cleared so a run inside Actions does not write
    // these fixtures onto the real job summary.
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env } }
  );
  return { status: result.status, out: result.stdout + result.stderr };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HIGH = report({
  'brace-expansion': { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc', 'high')] },
  minimatch: { severity: 'high', via: ['brace-expansion'] },
});

describe('check-audit: advisories', () => {
  it('passes a clean report', () => {
    const { status, out } = run(report({}));
    expect(out).toContain('0 advisories, 0 high or critical');
    expect(status).toBe(0);
  });

  it('fails on an unwaived high advisory', () => {
    const { status, out } = run(HIGH);
    expect(out).toContain('Unwaived: high     GHSA-aaaa-bbbb-cccc  brace-expansion');
    expect(status).toBe(1);
  });

  it('counts one advisory once, but requires coverage in every package that carries it', () => {
    const shared = advisory('GHSA-aaaa-bbbb-cccc', 'high');
    const both = report({
      'react-router': { severity: 'high', via: [shared] },
      'react-router-dom': { severity: 'high', via: [shared] },
    });
    const { status, out } = run(both, [waiver({ package: 'react-router' })]);
    expect(out).toContain('1 advisory, 1 high or critical');
    expect(out).toContain('Unwaived: high     GHSA-aaaa-bbbb-cccc  react-router-dom');
    expect(out).not.toContain('Unwaived: high     GHSA-aaaa-bbbb-cccc  react-router —');
    expect(status).toBe(1);
  });

  it('treats critical as blocking too', () => {
    const critical = report({
      undici: { severity: 'critical', via: [advisory('GHSA-dddd-eeee-ffff', 'critical')] },
    });
    expect(run(critical).status).toBe(1);
  });

  it('lists but does not block moderate and low advisories', () => {
    const moderate = report({
      qs: { severity: 'moderate', via: [advisory('GHSA-1111-2222-3333', 'moderate')] },
    });
    const { status, out } = run(moderate);
    expect(out).toContain('(reported; below the blocking bar)');
    expect(status).toBe(0);
  });
});

describe('check-audit: refuses to read a report it cannot account for', () => {
  it.each([
    ['null vulnerabilities', { auditReportVersion: 2, vulnerabilities: null }],
    ['an array of vulnerabilities', { auditReportVersion: 2, vulnerabilities: [] }],
    ['an npm error payload', { error: { code: 'ENOTFOUND', summary: 'registry.npmjs.org' } }],
  ])('%s -> exit 2, not a pass', (_label, bad) => {
    const { status, out } = run(bad);
    expect(out).toContain('not an `npm audit --json` report');
    expect(status).toBe(2);
  });

  it('fails when a high entry traces to no parsed advisory (a changed `via` shape)', () => {
    const unparseable = report({ undici: { severity: 'high', via: ['GHSA-9999-9999-9999'] } });
    const { status, out } = run(unparseable);
    expect(out).toContain(
      "Couldn't trace these high/critical entries to an advisory: undici (high)"
    );
    expect(status).toBe(2);
  });

  it("fails when the parsed counts don't match npm's own totals", () => {
    const { status, out } = run(report({}, { info: 0, low: 0, moderate: 0, high: 1, critical: 0 }));
    expect(out).toContain("don't match npm's totals for high (0 vs 1)");
    expect(status).toBe(2);
  });

  it('fails a report that audited no dependencies (a check that examined nothing)', () => {
    const clean = report({});
    expect(run(clean).status).toBe(0);
    const empty = { ...clean, metadata: { ...clean.metadata, dependencies: { total: 0 } } };
    const { status, out } = run(empty);
    expect(out).toContain('examined 0 dependencies');
    expect(status).toBe(2);
    const noCount = { ...clean, metadata: { vulnerabilities: clean.metadata.vulnerabilities } };
    expect(run(noCount).out).toContain('examined null dependencies');
    expect(run(noCount).status).toBe(2);
  });

  it('fails a report with no severity totals to reconcile against', () => {
    const clean = report({});
    const noTotals = { ...clean, metadata: { dependencies: clean.metadata.dependencies } };
    const { status, out } = run(noTotals);
    expect(out).toContain('no metadata.vulnerabilities totals');
    expect(status).toBe(2);
    expect(run({ ...clean, metadata: undefined }).status).toBe(2);
  });

  it('reports invalid JSON as exit 2 with the reason, not a stack trace', () => {
    const { status, out } = run('{"vulnerabilities": {', []);
    expect(out).toContain('--input report is not valid JSON');
    expect(status).toBe(2);
  });
});

describe('check-audit: waivers', () => {
  it('passes a high advisory with a current waiver for that package, and says so', () => {
    const { status, out } = run(HIGH, [waiver()]);
    expect(out).toContain('waived until 2026-11-30, owner repository owner');
    expect(status).toBe(0);
  });

  it('does not let a waiver for one package cover the advisory in another', () => {
    const { status, out } = run(HIGH, [waiver({ package: 'not-the-package' })]);
    expect(out).toContain('Unwaived: high     GHSA-aaaa-bbbb-cccc  brace-expansion');
    expect(out).toContain(
      'Stale waiver: GHSA-aaaa-bbbb-cccc is no longer reported in not-the-package'
    );
    expect(status).toBe(1);
  });

  it('treats an expired waiver as covering nothing', () => {
    // Same report and waiver as the passing case above; only the expiry moved
    // to the day before TODAY.
    const { status, out } = run(HIGH, [waiver({ expires: '2026-10-12' })]);
    expect(out).toContain('Unwaived: high     GHSA-aaaa-bbbb-cccc  brace-expansion');
    expect(out).toContain('Expired waiver: GHSA-aaaa-bbbb-cccc');
    expect(out).not.toContain('waived until');
    expect(status).toBe(1);
  });

  it('matches a waiver whose package or advisory has stray whitespace, as validated', () => {
    const padded = waiver({ package: ' brace-expansion ', advisory: 'GHSA-aaaa-bbbb-cccc ' });
    const { status, out } = run(HIGH, [padded]);
    expect(out).not.toContain('Unwaived');
    expect(out).not.toContain('Stale waiver');
    expect(status).toBe(0);
  });

  it('still honours a waiver on its expiry day', () => {
    const { status } = run(HIGH, [waiver({ expires: TODAY })]);
    expect(status).toBe(0);
  });

  it('waives an advisory with no GHSA link by the npm id the report gives it', () => {
    const npmOnly = {
      source: 1234,
      name: 'x',
      title: 'old advisory',
      url: 'https://www.npmjs.com/advisories/1234',
      severity: 'high',
      range: '<1',
    };
    const noGhsa = report({ 'brace-expansion': { severity: 'high', via: [npmOnly] } });
    expect(run(noGhsa).out).toContain('Unwaived: high     npm-1234');
    const { status, out } = run(noGhsa, [waiver({ advisory: 'npm-1234' })]);
    expect(out).not.toContain('Unwaived');
    expect(status).toBe(0);
  });

  it('fails on a stale waiver whose advisory is no longer reported', () => {
    const { status, out } = run(report({}), [waiver()]);
    expect(out).toContain('Stale waiver: GHSA-aaaa-bbbb-cccc');
    expect(status).toBe(1);
  });

  it.each([
    ['a short reason', { reason: 'low risk' }, '"reason" must be a string'],
    ['a non-string reason', { reason: { length: 50 } }, '"reason" must be a string'],
    ['no owner', { owner: '' }, '"owner" is required'],
    ['no package', { package: undefined }, '"package" is required'],
    [
      'a CVE id, which the report never uses',
      { advisory: 'CVE-2026-1' },
      '"advisory" must be the id the audit reports',
    ],
    [
      'an npm id that is not a number',
      { advisory: 'npm-abc' },
      '"advisory" must be the id the audit reports',
    ],
    ['a malformed expiry', { expires: 'next year' }, '"expires" must be a real date'],
    ['an impossible date', { expires: '2026-02-31' }, '"expires" must be a real date'],
    ['a permanent expiry', { expires: '9999-12-31' }, 'more than 90 days out'],
  ])('rejects a waiver with %s', (_label, overrides, message) => {
    const { status, out } = run(HIGH, [waiver(overrides)]);
    expect(out).toContain(message);
    expect(status).toBe(2);
  });

  it('rejects duplicate waivers and non-object entries', () => {
    expect(run(HIGH, [waiver(), waiver()]).out).toContain(
      'duplicate waiver for GHSA-aaaa-bbbb-cccc in brace-expansion'
    );
    expect(run(HIGH, [null]).status).toBe(2);
  });

  it('reports an unreadable register as exit 2', () => {
    const { status, out } = run(HIGH, '{"waivers": [');
    expect(out).toContain('Waiver register is not valid JSON');
    expect(status).toBe(2);
  });

  it("this repository's register is valid, and blocks what it does not name", () => {
    const register = JSON.parse(readFileSync(REGISTER, 'utf8'));
    expect(Array.isArray(register.waivers)).toBe(true);
    const ids = new Set(register.waivers.map((w) => w.advisory));
    // An advisory the register does not waive: an id no real advisory has.
    expect(ids.has('GHSA-zzzz-zzzz-zzzz')).toBe(false);
    const planted = report({
      'planted-package': { severity: 'high', via: [advisory('GHSA-zzzz-zzzz-zzzz', 'high')] },
    });
    // Every waiver the register holds is reported, so none reads as stale here.
    const covered = Object.fromEntries(
      register.waivers.map((w) => [
        w.package,
        { severity: 'high', via: [advisory(w.advisory, 'high')] },
      ])
    );
    const dir = scratch();
    writeFileSync(
      join(dir, 'audit.json'),
      JSON.stringify(report({ ...covered, ...planted.vulnerabilities }))
    );
    const result = spawnSync(
      process.execPath,
      // No --today: the register is checked against the real date, as CI checks it, so a
      // waiver added later with a valid expiry is not judged against a frozen date.
      [SCRIPT, '--input', join(dir, 'audit.json')],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }
    );
    const out = result.stdout + result.stderr;
    expect(out).toContain('Unwaived: high     GHSA-zzzz-zzzz-zzzz  planted-package');
    expect(result.status).toBe(1);
  });
});

describe('check-audit: running npm', () => {
  // A stand-in `npm` on PATH: records its arguments and prints a canned
  // report, so the spawn-and-parse path CI uses runs without the network.
  function fakeNpm(output) {
    const bin = scratch();
    const argsFile = join(bin, 'args.txt');
    const reportFile = join(bin, 'report.json');
    writeFileSync(reportFile, `${output}\n`); // `read` drops a final line with no newline
    // Shell builtins only: PATH holds nothing but this directory.
    const script = `#!/bin/sh\necho "$@" > "${argsFile}"\nwhile IFS= read -r line; do printf '%s\\n' "$line"; done < "${reportFile}"\nexit 1\n`;
    writeFileSync(join(bin, 'npm'), script);
    chmodSync(join(bin, 'npm'), 0o755);
    return { bin, argsFile };
  }

  it.skipIf(process.platform === 'win32')(
    'includes every dependency class, whatever npm omit is set to',
    () => {
      const { bin, argsFile } = fakeNpm(JSON.stringify(HIGH));
      const result = spawnSync(process.execPath, [SCRIPT, '--today', TODAY], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin,
          NODE_ENV: 'production',
          npm_config_omit: 'dev',
          GITHUB_STEP_SUMMARY: '',
        },
      });
      expect(readFileSync(argsFile, 'utf8').trim()).toBe(
        'audit --json --include=dev --include=optional --include=peer'
      );
      expect(result.stderr).toContain('Unwaived: high     GHSA-aaaa-bbbb-cccc');
      expect(result.status).toBe(1);
    }
  );

  it.skipIf(process.platform === 'win32')('says why when npm cannot be run at all', () => {
    const empty = scratch();
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, PATH: empty, GITHUB_STEP_SUMMARY: '' },
    });
    expect(result.stderr).toContain('npm audit produced no report (ENOENT');
    expect(result.status).toBe(2);
  });

  it('resolves --waivers against the current directory, like --input', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a.json'), JSON.stringify(report({})));
    writeFileSync(join(dir, 'w.json'), JSON.stringify({ waivers: [] }));
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--input', 'a.json', '--waivers', 'w.json', '--today', TODAY],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }
    );
    expect(result.status).toBe(0);
  });

  it('writes the full picture to the GitHub Actions step summary', () => {
    const summary = join(scratch(), 'summary.md');
    run(HIGH, [], [], { GITHUB_STEP_SUMMARY: summary });
    const md = readFileSync(summary, 'utf8');
    expect(md).toContain('### Dependency audit');
    expect(md).toContain('✗ Unwaived: high     GHSA-aaaa-bbbb-cccc  brace-expansion');
  });

  it('rejects unknown arguments and bad dates', () => {
    expect(run(report({}), [], ['--strict']).status).toBe(2);
    expect(run(report({}), [], ['--today', '13/10/2026']).status).toBe(2);
  });
});

// ── The workflow ────────────────────────────────────────────────────────────

const indentOf = (line) => line.length - line.trimStart().length;

/** The lines under the top-level key `key:`. */
function topLevelBlock(lines, key) {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start === -1) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && indentOf(l) === 0) break;
    block.push(l);
  }
  return block;
}

/**
 * Why audit.yml could not block a pull request or catch an advisory on the
 * schedule; empty when it can do both.
 * @param {string} workflow
 * @returns {string[]}
 */
function workflowProblems(workflow) {
  const lines = workflow.split('\n');
  const problems = [];
  const on = topLevelBlock(lines, 'on');
  if (!on) return ['no top-level "on:" block'];
  const code = (l) => l.trim() !== '' && !l.trimStart().startsWith('#');
  const at = on.findIndex((l) => /^\s*pull_request:/.test(l));
  if (at === -1) problems.push('no pull_request trigger');
  else {
    const prIndent = indentOf(on[at]);
    for (let i = at + 1; i < on.length && (!code(on[i]) || indentOf(on[i]) > prIndent); i += 1) {
      if (/^\s*(paths|paths-ignore|types):/.test(on[i])) {
        problems.push(`pull_request is filtered (${on[i].trim()})`);
      }
      if (/^\s*branches:/.test(on[i]) && !/\bmain\b/.test(on[i])) {
        problems.push('pull_request branches do not include main');
      }
    }
  }
  if (!on.some((l) => /^\s*- cron: '[^']+'/.test(l))) problems.push('no schedule cron');
  const runs = lines.filter((l) => /^\s*run: npm run check:audit\s*$/.test(l));
  if (runs.length !== 1)
    problems.push(`expected one "run: npm run check:audit" step, found ${runs.length}`);
  if (lines.some((l) => code(l) && /continue-on-error:\s*true/.test(l))) {
    problems.push('a step or job sets continue-on-error');
  }
  const stepIf = lines.findIndex((l) => /^\s*run: npm run check:audit/.test(l));
  // The audit step must not carry its own `if` (it would be skipped, and a
  // skipped step passes). Look back to the step's start (`- name:`).
  for (let i = stepIf - 1; i >= 0 && stepIf !== -1; i -= 1) {
    if (/^\s*if:/.test(lines[i])) problems.push('the audit step has an if');
    if (/^\s*- /.test(lines[i])) break;
  }
  // The job that runs the gate: from its `name:` line back to its key, then on to the next job.
  const jobs = topLevelBlock(lines, 'jobs') ?? [];
  const nameAt = jobs.findIndex((l) =>
    /^ {4}name: npm audit \(high and critical block\)\s*$/.test(l)
  );
  if (nameAt === -1) problems.push('no job named "npm audit (high and critical block)"');
  else {
    let start = nameAt;
    while (start > 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(jobs[start])) start -= 1;
    let end = start + 1;
    while (end < jobs.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(jobs[end])) end += 1;
    const job = jobs.slice(start, end);
    if (job.some((l) => code(l) && /^ {4}if:/.test(l))) problems.push('the job has an if');
    if (job.some((l) => code(l) && /^ {4}needs:/.test(l))) problems.push('the job has needs');
    if (!job.some((l) => /^\s*run: npm run check:audit\s*$/.test(l))) {
      problems.push('the audit job does not run npm run check:audit');
    }
  }
  return problems;
}

describe('audit.yml', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  it('runs the gate on every pull request to main and on a schedule, able to fail', () => {
    expect(workflowProblems(workflow)).toEqual([]);
  });

  it('runs the script package.json names, and that is this gate', () => {
    const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
    expect(pkg.scripts['check:audit']).toBe('node scripts/check-audit.mjs');
  });

  it.each([
    [
      'a paths filter',
      (w) =>
        w.replace('    branches: [main]\n  # Adv', '    branches: [main]\n    paths: [x]\n  # Adv'),
      'pull_request is filtered',
    ],
    [
      'no pull_request trigger',
      (w) => w.replace('  pull_request:\n', '  pull_request_x:\n'),
      'no pull_request trigger',
    ],
    ['no schedule', (w) => w.replace(/- cron: '[^']+'/, "- cronx: ''"), 'no schedule cron'],
    [
      'continue-on-error',
      (w) =>
        w.replace(
          '        run: npm run check:audit',
          '        continue-on-error: true\n        run: npm run check:audit'
        ),
      'continue-on-error',
    ],
    [
      'an `|| true`',
      (w) => w.replace('run: npm run check:audit', 'run: npm run check:audit || true'),
      'expected one "run: npm run check:audit" step, found 0',
    ],
    [
      'an if on the step',
      (w) =>
        w.replace(
          '      - name: Audit dependencies\n',
          "      - name: Audit dependencies\n        if: github.event_name == 'push'\n"
        ),
      'the audit step has an if',
    ],
    [
      'an if on the job',
      (w) =>
        w.replace(
          '    runs-on: ubuntu-latest',
          "    if: github.event_name == 'schedule'\n    runs-on: ubuntu-latest"
        ),
      'the job has an if',
    ],
    [
      'needs on the job',
      (w) =>
        w.replace(
          '    name: npm audit (high and critical block)\n',
          '    name: npm audit (high and critical block)\n    needs: [other]\n'
        ),
      'the job has needs',
    ],
    [
      'the job renamed',
      (w) => w.replace('name: npm audit (high and critical block)', 'name: npm audit'),
      'no job named',
    ],
  ])('catches a planted workflow with %s', (_label, plant, problem) => {
    const planted = plant(workflow);
    expect(planted).not.toBe(workflow);
    expect(workflowProblems(planted).join('\n')).toContain(problem);
  });
});
