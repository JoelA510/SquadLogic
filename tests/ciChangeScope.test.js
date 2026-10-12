/**
 * The Build & Test job's "Determine change scope" and "Docs-only diff check"
 * steps survive a push whose `github.event.before` is not in the checkout.
 *
 * main was force-pushed (an approved history rewrite) from 84df0dc to 834b40a.
 * The push run diffed the replaced SHA, which no ref reaches any more, and
 * "Determine change scope" died with `fatal: bad object` (exit 128). An unknown
 * base must force the full matrix, never docs-only: a docs-only fallback would
 * skip the tests on a rewritten history.
 *
 * The step scripts are read out of ci.yml (line-based, no YAML dependency) and
 * executed with bash against a scratch git repo, so the test runs the shipped
 * code rather than a copy of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CI_WORKFLOW_PATH = path.resolve('.github/workflows/ci.yml');
/** The commit the force-push replaced. It does not exist in the scratch repo. */
const UNKNOWN_SHA = '84df0dc760ec984ec2fa51f76fb672cef7a223d9';

const indentOf = (/** @type {string} */ line) => line.length - line.trimStart().length;

/**
 * Returns the `run: |` body of the step with this exact name, dedented.
 * Throws when the step or its run block is missing, so a renamed step is a
 * loud failure rather than an empty script that trivially exits 0.
 * @param {string} stepName
 */
function stepScript(stepName) {
  const lines = readFileSync(CI_WORKFLOW_PATH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (start === -1) throw new Error(`step "${stepName}" not found in ci.yml`);
  const stepIndent = indentOf(lines[start]);
  let runAt = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== '' && indentOf(l) <= stepIndent) break;
    if (l.trim() === 'run: |') {
      runAt = i;
      break;
    }
  }
  if (runAt === -1) throw new Error(`step "${stepName}" has no run: | block`);
  const runIndent = indentOf(lines[runAt]);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== '' && indentOf(l) <= runIndent) break;
    body.push(l.trim() === '' ? '' : l.slice(runIndent + 2));
  }
  const script = body.join('\n').trim();
  if (script === '') throw new Error(`step "${stepName}" has an empty run block`);
  return script;
}

/** @type {string} */
let root;
/** @type {string} */
let repo;
/** @type {Record<string, string>} */
const sha = {};

/** @param {string[]} args */
function git(...args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ci-test',
      GIT_AUTHOR_EMAIL: 'ci-test@example.invalid',
      GIT_COMMITTER_NAME: 'ci-test',
      GIT_COMMITTER_EMAIL: 'ci-test@example.invalid',
    },
  });
}

/** @param {string} file @param {string} message */
function commit(file, message) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), `${message}\n`);
  expect(git('add', file).status).toBe(0);
  expect(git('commit', '-q', '-m', message).status).toBe(0);
  return git('rev-parse', 'HEAD').stdout.trim();
}

/**
 * Runs a ci.yml step as a push event.
 * @param {string} stepName
 * @param {string} beforeSha
 * @param {string} currentSha
 */
function runPushStep(stepName, beforeSha, currentSha) {
  const outputFile = path.join(root, `output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(outputFile, '');
  const r = spawnSync('bash', ['-c', stepScript(stepName)], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: 'push',
      BASE_SHA: '',
      HEAD_SHA: currentSha,
      BEFORE_SHA: beforeSha,
      CURRENT_SHA: currentSha,
      GITHUB_OUTPUT: outputFile,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    output: readFileSync(outputFile, 'utf8'),
  };
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ci-change-scope-'));
  repo = path.join(root, 'repo');
  mkdirSync(repo);
  expect(git('init', '-q').status).toBe(0);
  sha.base = commit('src/app.js', 'base');
  sha.docs = commit('docs/guide.md', 'docs change');
  sha.code = commit('src/app.js', 'code change');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('ci.yml Determine change scope', () => {
  it('the scratch repo really lacks the before SHA (the old diff exits 128)', () => {
    expect(git('cat-file', '-e', `${UNKNOWN_SHA}^{commit}`).status).not.toBe(0);
    expect(git('diff', '--name-only', UNKNOWN_SHA, sha.code).status).toBe(128);
  });

  it('forces the full matrix when the before SHA is unknown', () => {
    const r = runPushStep('Determine change scope', UNKNOWN_SHA, sha.code);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.output).toBe('docs_only=false\n');
    expect(r.stdout).toContain(`Before SHA ${UNKNOWN_SHA} is unknown`);
  });

  it('still detects a docs-only push against a known before SHA', () => {
    const r = runPushStep('Determine change scope', sha.base, sha.docs);
    expect(r.status).toBe(0);
    expect(r.output).toBe('docs_only=true\n');
    expect(r.stdout).toContain('docs/guide.md');
  });

  it('still runs the full matrix for a code push against a known before SHA', () => {
    const r = runPushStep('Determine change scope', sha.docs, sha.code);
    expect(r.status).toBe(0);
    expect(r.output).toBe('docs_only=false\n');
    expect(r.stdout).toContain('src/app.js');
  });
});

describe('ci.yml Docs-only diff check', () => {
  it('does not exit 128 when the before SHA is unknown', () => {
    const r = runPushStep('Docs-only diff check', UNKNOWN_SHA, sha.docs);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Before SHA ${UNKNOWN_SHA} is unknown`);
  });

  it('diffs against a known before SHA', () => {
    const r = runPushStep('Docs-only diff check', sha.base, sha.docs);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('is unknown');
  });
});
