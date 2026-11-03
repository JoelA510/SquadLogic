// @vitest-environment node
/**
 * One placement, one count: a census of who asks core where a player plays and who counts the
 * seats (play-down plan, 2026-11-03, PR 1, task A2).
 *
 * The Teams page asked core's `applyPlayUpEligibility` from three places (the advice's not-eligible
 * set, the advice's destination divisions, and generation's "who plays here"), each building its own
 * players, and the three could drift: they once disagreed about which division a moved player was in.
 * They now share `placeImportRows`, the one call in `frontend/src`. This file fails a second one,
 * and it fails a count of the seats made anywhere but where it is wired, so a later surface (a feed,
 * an export, a coach page) must be added here on purpose, not by an import nobody noticed.
 *
 * A census that walked nothing would pass by looking at zero files, so the walk is held to a floor,
 * and the scanner is run on constructed sources first: it must find a call, ignore a comment and
 * an import, and count two calls as two.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['frontend/src', 'packages/core/src'];
const SOURCE_FILE = /\.(c|m)?(j|t)sx?$/;
/** Well under the real count (several hundred), so only a broken walk fails it. */
const MIN_FILES_SCANNED = 150;

/** Every source file under `dir`, as `/`-separated paths relative to the repository root. */
function listSources(dir) {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return [];
    const relative = `${dir}/${name}`;
    if (statSync(path.join(ROOT, relative)).isDirectory()) return listSources(relative);
    return SOURCE_FILE.test(name) ? [relative] : [];
  });
}

/** The source without its comments, so a mention in prose is not a call. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/**
 * How many times `source` calls `name(`. An import, a re-export, a comment and the function's own
 * definition are not calls.
 */
function callCount(source, name) {
  const call = new RegExp(`(?<!function\\s+)\\b${name}\\s*\\(`, 'g');
  return (withoutComments(source).match(call) ?? []).length;
}

/** Does `source` import from a module whose path ends in `file`? */
function importsFrom(source, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`from\\s+['"][^'"]*${escaped}['"]`).test(withoutComments(source));
}

const sources = SOURCE_ROOTS.flatMap(listSources);
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

describe('the scanner itself finds what it must, and only that', () => {
  it('finds a call, ignores a comment, an import and a mention in a string of prose', () => {
    expect(
      callCount('const a = applyPlayUpEligibility({ players });', 'applyPlayUpEligibility')
    ).toBe(1);
    expect(callCount('x = applyPlayUpEligibility ({ a })', 'applyPlayUpEligibility')).toBe(1);
    expect(
      callCount(
        [
          "import { applyPlayUpEligibility } from '@squadlogic/core/playUp.js';",
          '// the one call: applyPlayUpEligibility(players) is made in the helper',
          '/** placed by `applyPlayUpEligibility` and by applyPlayUpEligibility(x) too */',
          'export { applyPlayUpEligibility };',
          'export function applyPlayUpEligibility({ players }) {}',
        ].join('\n'),
        'applyPlayUpEligibility'
      )
    ).toBe(0);
  });

  it('counts two calls as two, so a second site cannot hide behind the first', () => {
    const twice = 'a(applyPlayUpEligibility({ p }));\nb = applyPlayUpEligibility({ q });';
    expect(callCount(twice, 'applyPlayUpEligibility')).toBe(2);
  });

  it('reads an import by the end of its path', () => {
    expect(
      importsFrom("import { x } from '@squadlogic/core/playUpSeats.js';", 'playUpSeats.js')
    ).toBe(true);
    expect(importsFrom("import { x } from './playUpSeatsOther.js';", 'playUpSeats.js')).toBe(false);
    expect(importsFrom("// from '@squadlogic/core/playUpSeats.js'", 'playUpSeats.js')).toBe(false);
  });
});

describe('the placement and the seat count have one caller each', () => {
  it('walks a real tree', () => {
    expect(sources.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
    expect(sources).toContain('frontend/src/pages/TeamAnalysisPage.jsx');
    expect(sources).toContain('packages/core/src/playUp.js');
  });

  it('asks core where a player plays from one place in the frontend: the page helper', () => {
    const callers = sources
      .filter((file) => file.startsWith('frontend/src/'))
      .map((file) => [file, callCount(read(file), 'applyPlayUpEligibility')])
      .filter(([, count]) => count > 0);
    // The positive control: the call exists, so a rename that hid it would fail here, not pass.
    expect(callers).toEqual([['frontend/src/pages/TeamAnalysisPage.jsx', 1]]);

    // And it is inside `placeImportRows`: the text from that function's start to the next top-level
    // function holds the one call.
    const page = withoutComments(read('frontend/src/pages/TeamAnalysisPage.jsx'));
    const start = page.indexOf('function placeImportRows(');
    expect(start).toBeGreaterThan(-1);
    const next = page.indexOf('\nfunction ', start + 1);
    const nextAsync = page.indexOf('\nasync function ', start + 1);
    const end = Math.min(...[next, nextAsync].filter((index) => index > -1));
    expect(callCount(page.slice(start, end), 'applyPlayUpEligibility')).toBe(1);
  });

  it('the core pipeline is the one other place, and it is core, not a page', () => {
    const callers = sources
      .filter((file) => file.startsWith('packages/core/src/'))
      .map((file) => [file, callCount(read(file), 'applyPlayUpEligibility')])
      .filter(([, count]) => count > 0);
    expect(callers).toEqual([['packages/core/src/teamingPipeline.js', 1]]);
  });

  it('counts seats from one module, imported by the Teams page alone', () => {
    const importers = sources.filter((file) => importsFrom(read(file), 'playUpSeats.js'));
    // `summarizeSeats` and `seatsFromPlacedPlayers` are used by the page. No feed, export, coach
    // surface or calendar reads play-up or age data; a new consumer is added here deliberately.
    expect(importers).toEqual(['frontend/src/pages/TeamAnalysisPage.jsx']);
    // The positive control for the walk: another module of the same family is imported by something.
    expect(sources.some((file) => importsFrom(read(file), 'playUp.js'))).toBe(true);
  });
});
