// @vitest-environment node
/**
 * Install scripts are reviewed before they run (remediation plan, Discovered
 * during execution, #559; the template's ADR 0019 and dependency policy).
 *
 * `package.json`'s `allowScripts` is npm 11's own record of that review: `true`
 * lets a dependency's install script run, `false` stops it. npm still runs a
 * script it does not name, with a warning (`strict-allow-scripts` is off), so
 * the record is only as good as its coverage. This holds it to the lockfile,
 * which names every package with an install script for every platform
 * (`hasInstallScript`), not only the ones this machine installed:
 *
 * - every such package has a decision;
 * - every decision names such a package (no stale entries, as
 *   `npm install-scripts prune` would remove).
 *
 * esbuild was approved here (its postinstall linked the platform binary and ran
 * `--version`) until Vite 8 (2026-10-19): Vite now bundles with Rolldown and
 * Oxc and lists esbuild only as an optional peer, so the lockfile no longer
 * holds it and the entry went with it. A decision for a package that is not
 * there is a stale entry, which the last test below refuses.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.resolve('package-lock.json'), 'utf8'));

/** The package name a lockfile key or an `allowScripts` key names. */
function packageName(/** @type {string} */ key) {
  const tail = key.split('node_modules/').pop() ?? key;
  const at = tail.indexOf('@', tail.startsWith('@') ? 1 : 0);
  return at === -1 ? tail : tail.slice(0, at);
}

/** Every package the lockfile marks as having an install script. */
function withInstallScripts(/** @type {any} */ lockfile) {
  return [
    ...new Set(
      Object.entries(lockfile.packages ?? {})
        .filter(([key, entry]) => key !== '' && entry.hasInstallScript === true)
        .map(([key]) => packageName(key))
    ),
  ].sort();
}

describe('allowScripts', () => {
  const scripted = withInstallScripts(lock);
  const decided = Object.keys(pkg.allowScripts ?? {}).map(packageName);

  it('the detector reads names from lockfile and allowScripts keys', () => {
    expect(packageName('node_modules/fsevents')).toBe('fsevents');
    expect(packageName('node_modules/a/node_modules/@scope/b')).toBe('@scope/b');
    expect(packageName('fsevents@2.3.3')).toBe('fsevents');
    expect(packageName('@scope/b@^1 || ^2')).toBe('@scope/b');
    expect(
      withInstallScripts({
        packages: { '': {}, 'node_modules/x': { hasInstallScript: true }, 'node_modules/y': {} },
      })
    ).toEqual(['x']);
  });

  it('records a decision for every package with an install script', () => {
    // Meta: the lockfile scan found the install script there is (fsevents
    // today), so an empty gap list is not an empty scan.
    expect(scripted).toContain('fsevents');
    const undecided = scripted.filter((name) => !decided.includes(name));
    expect(undecided).toEqual([]);
  });

  it("denies fsevents by name, the owner's decision of 2026-10-18", () => {
    expect(pkg.allowScripts?.fsevents).toBe(false);
  });

  it('names no package without an install script', () => {
    expect(decided.filter((name) => !scripted.includes(name))).toEqual([]);
  });
});
