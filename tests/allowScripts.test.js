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
 * - every such package has a decision, or is listed below as awaiting one;
 * - every decision names such a package (no stale entries, as
 *   `npm install-scripts prune` would remove).
 *
 * esbuild's postinstall (`node install.js`) was read for 0.28.2: it finds the
 * platform binary the lockfile already installs as an optional dependency
 * (`@esbuild/<platform>`), hard-links it over `bin/esbuild` and runs it with
 * `--version`. Only when that package is missing does it fetch the binary from
 * registry.npmjs.org, checked against the sha256 in esbuild's package.json.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.resolve('package-lock.json'), 'utf8'));

/**
 * Install scripts with no decision yet, each with the question it waits on.
 * Remove an entry once `allowScripts` records the decision. None today:
 * `fsevents` (macOS only, `node-gyp rebuild`; the template denies the same
 * 2.3.3) was decided by the owner on 2026-10-18 to stay denied.
 */
/** @type {Record<string, string>} */
const AWAITING_DECISION = {};

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
    expect(packageName('node_modules/esbuild')).toBe('esbuild');
    expect(packageName('node_modules/a/node_modules/@scope/b')).toBe('@scope/b');
    expect(packageName('esbuild@0.28.2')).toBe('esbuild');
    expect(packageName('@scope/b@^1 || ^2')).toBe('@scope/b');
    expect(
      withInstallScripts({
        packages: { '': {}, 'node_modules/x': { hasInstallScript: true }, 'node_modules/y': {} },
      })
    ).toEqual(['x']);
  });

  it('records a decision for every package with an install script', () => {
    // Meta: the lockfile scan found the install scripts there are (esbuild
    // and fsevents today), so an empty gap list is not an empty scan.
    expect(scripted).toContain('esbuild');
    expect(scripted).toContain('fsevents');
    const undecided = scripted.filter(
      (name) => !decided.includes(name) && !Object.hasOwn(AWAITING_DECISION, name)
    );
    expect(undecided).toEqual([]);
  });

  it('allows esbuild by name, reviewed', () => {
    expect(pkg.allowScripts?.esbuild).toBe(true);
  });

  it("denies fsevents by name, the owner's decision of 2026-10-18", () => {
    expect(scripted).toContain('fsevents');
    expect(pkg.allowScripts?.fsevents).toBe(false);
  });

  it('names no package without an install script, and none both decided and awaiting', () => {
    expect(decided.filter((name) => !scripted.includes(name))).toEqual([]);
    expect(Object.keys(AWAITING_DECISION).filter((name) => !scripted.includes(name))).toEqual([]);
    expect(decided.filter((name) => Object.hasOwn(AWAITING_DECISION, name))).toEqual([]);
  });
});
