// @vitest-environment node
/**
 * README's release line names the current release (plan item M6.4, audit
 * finding 12.9): the version in package.json, which Sentry reports as the
 * release, and the newest released entry in CHANGELOG.md, with its date. The
 * line had not moved in six months; this fails the first time a release is
 * cut without it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (/** @type {string} */ file) => readFileSync(path.resolve(file), 'utf8');

/** The `> **Release status**:` line of a README, or undefined. */
function releaseLine(/** @type {string} */ readme) {
  return readme.split('\n').find((line) => line.startsWith('> **Release status**:'));
}

/** The newest `## [x.y.z] - YYYY-MM-DD` heading of a changelog. */
function latestRelease(/** @type {string} */ changelog) {
  const match = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/m.exec(changelog);
  return match ? { version: match[1], date: match[2] } : undefined;
}

/** Why the release line does not name this release; empty when it does. */
function releaseProblems(
  /** @type {string | undefined} */ line,
  /** @type {{ version: string, date: string } | undefined} */ release,
  /** @type {string} */ pkgVersion
) {
  if (!line) return ['README has no release status line'];
  if (!release) return ['CHANGELOG has no released entry'];
  const problems = [];
  if (release.version !== pkgVersion) {
    problems.push(
      `CHANGELOG's latest release ${release.version} is not package.json's ${pkgVersion}`
    );
  }
  if (!line.includes(`v${release.version} (${release.date})`)) {
    problems.push(`the release line does not name v${release.version} (${release.date})`);
  }
  return problems;
}

describe('README release line', () => {
  const pkgVersion = JSON.parse(read('package.json')).version;

  it('names the current release, as package.json and CHANGELOG.md record it', () => {
    expect(
      releaseProblems(
        releaseLine(read('README.md')),
        latestRelease(read('CHANGELOG.md')),
        pkgVersion
      )
    ).toEqual([]);
  });

  it('fails a release cut without the README, or a changelog ahead of package.json', () => {
    const line = releaseLine(read('README.md'));
    // The release after the current one, so the case holds whatever the current version is.
    const [major, minor] = pkgVersion.split('.').map(Number);
    const next = { version: `${major}.${minor + 1}.0`, date: '2099-01-01' };
    expect(releaseProblems(line, next, next.version)).toEqual([
      `the release line does not name v${next.version} (2099-01-01)`,
    ]);
    expect(releaseProblems(line, next, pkgVersion).join('\n')).toContain('is not package.json');
    expect(releaseProblems(undefined, next, next.version)).toEqual([
      'README has no release status line',
    ]);
    expect(
      latestRelease('## [Unreleased]\n\n## [2.0.0] - 2027-01-01\n## [1.0.0] - 2026-01-01')
    ).toEqual({
      version: '2.0.0',
      date: '2027-01-01',
    });
  });
});
