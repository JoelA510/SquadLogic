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
 * and the scanner is run on constructed sources first: it must find a call, ignore an import and
 * the definition, count two calls as two, and see an alias that would hide a call.
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

/**
 * How many times `source` calls `name(`, read from the raw text: a mention of the call in a comment
 * counts too, because over-counting only ever fails the census where under-counting would let a second
 * call through (a stripped comment once hid code behind a `//` inside a string). An import, a
 * re-export and the function's own definition are not calls, so prose here must not spell the call as
 * `name(`.
 */
function callCount(source, name) {
  const call = new RegExp(`(?<!function\\s+)\\b${name}\\s*\\(`, 'g');
  return (source.match(call) ?? []).length;
}

/** Does `source` bind `name` to another name (`import { name as other }`), which hides its calls? */
function aliasesImport(source, name) {
  return new RegExp(`\\b${name}\\s+as\\s+\\w`).test(source);
}

/** Does `source` import from a module whose path ends in `file`? */
function importsFrom(source, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`from\\s+['"][^'"]*${escaped}['"]`).test(source);
}

const sources = SOURCE_ROOTS.flatMap(listSources);
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

describe('the scanner itself finds what it must, and only that', () => {
  it('finds a call, and ignores an import, a re-export and the definition', () => {
    expect(
      callCount('const a = applyPlayUpEligibility({ players });', 'applyPlayUpEligibility')
    ).toBe(1);
    expect(callCount('x = applyPlayUpEligibility ({ a })', 'applyPlayUpEligibility')).toBe(1);
    expect(callCount('x = playUp.applyPlayUpEligibility({ a })', 'applyPlayUpEligibility')).toBe(1);
    expect(
      callCount(
        [
          "import { applyPlayUpEligibility } from '@squadlogic/core/playUp.js';",
          'export { applyPlayUpEligibility };',
          'export function applyPlayUpEligibility({ players }) {}',
          'const note = `placed by applyPlayUpEligibility, once`;',
        ].join('\n'),
        'applyPlayUpEligibility'
      )
    ).toBe(0);
  });

  it('counts two calls as two, so a second site cannot hide behind the first', () => {
    const twice = 'a(applyPlayUpEligibility({ p }));\nb = applyPlayUpEligibility({ q });';
    expect(callCount(twice, 'applyPlayUpEligibility')).toBe(2);
  });

  it('does not let a call hide behind a // inside a string or after a comment-looking prefix', () => {
    const sneaky = "const s = 'a // b'; applyPlayUpEligibility({ p });";
    expect(callCount(sneaky, 'applyPlayUpEligibility')).toBe(1);
  });

  it('sees an alias, which would hide every call from the count', () => {
    expect(
      aliasesImport(
        "import { applyPlayUpEligibility as place } from '@squadlogic/core/playUp.js';",
        'applyPlayUpEligibility'
      )
    ).toBe(true);
    expect(
      aliasesImport(
        "import { applyPlayUpEligibility } from '@squadlogic/core/playUp.js';",
        'applyPlayUpEligibility'
      )
    ).toBe(false);
  });

  it('reads an import by the end of its path', () => {
    expect(
      importsFrom("import { x } from '@squadlogic/core/playUpSeats.js';", 'playUpSeats.js')
    ).toBe(true);
    expect(importsFrom("import { x } from './playUpSeatsOther.js';", 'playUpSeats.js')).toBe(false);
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
    // And no file binds the function to another name, which would hide a call from the count.
    expect(
      sources
        .filter((file) => file.startsWith('frontend/src/'))
        .filter((file) => aliasesImport(read(file), 'applyPlayUpEligibility'))
    ).toEqual([]);

    // And it is inside `placeImportRows`: the text from that function's start to the next top-level
    // function holds the one call.
    const page = read('frontend/src/pages/TeamAnalysisPage.jsx');
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

  it('counts seats from one module, imported by the Teams page and the views it feeds', () => {
    const importers = sources.filter((file) => importsFrom(read(file), 'playUpSeats.js'));
    // The page counts the file's seats (the overview), the Play-up section counts a run's listing
    // (`playUpReview.js`) and the roster list counts the seats on the rosters (`rosterAgeFlags.js`),
    // all through `summarizeSeats`. No feed, export, coach surface or calendar reads play-up or age
    // data; a new consumer is added here deliberately (play-down plan, PR 2 added the two utilities).
    expect(importers).toEqual([
      'frontend/src/pages/TeamAnalysisPage.jsx',
      'frontend/src/utils/playUpReview.js',
      'frontend/src/utils/rosterAgeFlags.js',
    ]);
    // The positive control for the walk: another module of the same family is imported by something.
    expect(sources.some((file) => importsFrom(read(file), 'playUp.js'))).toBe(true);
  });
});
