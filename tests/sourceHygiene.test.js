/**
 * Repo-level source hygiene for `packages/core/src`.
 *
 * The one rule here has a history. A raw `U+0000` used as a map-key separator
 * makes the whole file **binary** to every tool that reads bytes: `file` reports
 * `data`, ripgrep skips it silently, and git records it as
 * `Bin 0 -> 57224 bytes` with zero insertions — which is how a 1,460-line rule
 * file once merged as an opaque blob that no diff review could read. It was
 * caught and fixed during Prompt 1.1 and it came back in Prompt 2.3, so it gets
 * a standing guard rather than a third fix.
 *
 * The separator itself is fine and stays; only the *raw byte* is refused. The
 * `\u0000` escape sequence compiles to the same character and keeps the file
 * text, which is exactly what `facility/facilityGraph.js` and
 * `facility/occupancy.js` already do.
 *
 * The second rule has a history too, and it is the other half of the class
 * `tests/unknownSurfaceDiscipline.test.js` guards. `effectiveSeverityTable()`
 * returns a **severity table and a report about how the registry was read** —
 * which records it could not judge here, which it retyped, where two of equal
 * specificity disagreed. Twice now a caller has bound the whole thing and read
 * only the table, so a constraint the lookup could not decide about was
 * silently not applied and nothing anywhere said so: round 1 in
 * `externalImport`'s `planFindings()`, round 2 in `resolve/legality.js`
 * `checkPlacement()`, which had the game in its hand and did not pass the
 * teams. Dropping the report is sometimes right — a caller that holds no teams
 * and no people learns nothing from being told it could not judge a team scope
 * — so the rule is not "never drop it" but **"say so"**: a call site that does
 * not read `.findings` must be named below with a reason.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = path.join(ROOT, 'packages', 'core', 'src');
/** The tests walk too: a test file merged as a binary blob is as unreadable as a source file. */
const TESTS_DIR = path.join(ROOT, 'tests');

/**
 * Every `.js` file under one directory, recursively.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFilesUnder(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFilesUnder(full));
    else if (entry.endsWith('.js')) files.push(full);
  }
  return files;
}

describe('source hygiene :: no source file under packages/core/src is binary', () => {
  const files = [...sourceFilesUnder(CORE_SRC), ...sourceFilesUnder(TESTS_DIR)];

  it('scans a plausible number of files', () => {
    // The meta-assertion the rest of this file rests on: a walk that found
    // nothing would pass the NUL check for the worst possible reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith(path.join('ruleEngine', 'rules.js')))).toBe(true);
  });

  it('detects a raw NUL byte when there is one', () => {
    // The positive control: the check below is only worth reading if it can
    // fail, so the same predicate is run against a buffer that does contain one.
    expect(Buffer.from([0x61, 0x00, 0x62]).includes(0)).toBe(true);
    // …and the escape sequence this file asks for is plain ASCII on disk.
    expect(Buffer.from(String.raw`a\u0000b`, 'utf8').includes(0)).toBe(false);
  });

  it('holds no raw NUL byte in any of them', () => {
    /** @type {string[]} */
    const offenders = [];
    for (const file of files) {
      if (readFileSync(file).includes(0)) offenders.push(path.relative(ROOT, file));
    }
    expect(
      offenders,
      `these files contain a raw U+0000 and are binary to git, ripgrep and every diff review; write the separator as the \\u0000 escape instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The registry seam returns two halves, and dropping one is a stated act       */
/* -------------------------------------------------------------------------- */

/**
 * Call sites that read `effectiveSeverityTable()`'s table and not its report,
 * each with the reason it is right to.
 *
 * Keyed by the file's path under `packages/core/src`. A new call site that drops
 * the report and is not named here fails the check below; a name here that no
 * longer drops it fails too, so the list cannot rot into a permanent excuse.
 *
 * @type {Record<string, string>}
 */
const DROPS_THE_SEAM_REPORT = Object.freeze({
  'attribution/explain.js':
    'the two boundary questions are asked of a *place* — a surface, a venue and a date — and `where` carries no sides at all, so an unjudged team or person scope from here says only "the question named no team", which is true of every call. The game-shaped answers reach `checkPlacement()`, which does report it.',
  'feasibility/verdict.js':
    'the same reason, one module along: `probeKickoff()` asks about a slot rather than a fixture, so there is no team in hand to judge a team scope against. A feasibility answer still sees the team-scoped verdict, through `attribution/explain.js` and `checkPlacement()`.',
  'constraints/whatIf.js':
    'a projection asks the registry twice over one unchanged context and publishes the *difference*; the seam would report the same thing on both sides, so its report carries no delta and the module merges both `meta` blocks instead, which is the half that does differ.',
  'placement/replaceGames.js':
    'a bounded single-venue harness whose stated purpose is to show that the registry is the only thing differing between two runs. It throws on every malformed input rather than reporting, and it reads the table for exactly one comparison.',
});

describe('source hygiene :: dropping the registry seam report is a stated act', () => {
  const files = sourceFilesUnder(CORE_SRC);

  /**
   * Every file that binds `effectiveSeverityTable()`'s result, and whether it
   * ever reads that binding's `.findings`.
   *
   * @returns {{ reads: string[], drops: string[] }}
   */
  function callSites() {
    /** @type {Set<string>} */
    const reads = new Set();
    /** @type {Set<string>} */
    const drops = new Set();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const key = path.relative(CORE_SRC, file).split(path.sep).join('/');
      for (const match of source.matchAll(/const\s+(\w+)\s*=\s*effectiveSeverityTable\(/g)) {
        const binder = match[1];
        if (new RegExp(`\\b${binder}\\.findings\\b`).test(source)) reads.add(key);
        else drops.add(key);
      }
    }
    return { reads: [...reads].sort(), drops: [...drops].sort() };
  }

  const sites = callSites();

  it('finds the seam being called at all', () => {
    // The meta-assertion. A regex that matched nothing would make the check
    // below pass for the worst possible reason, and a list of readers that was
    // empty would mean nothing has ever been shown to read the report.
    expect(sites.reads.length + sites.drops.length).toBeGreaterThan(3);
    expect(sites.reads).toContain('resolve/legality.js');
    // `ruleEngine/engine.js` is the precedent the fix in `resolve/legality.js`
    // followed: it aggregates every cached table's findings into the run,
    // because "discarding them threw away the provenance of every severity this
    // run reports". Asserted here so the two cannot drift apart again.
    expect(sites.reads).toContain('ruleEngine/engine.js');
  });

  it('names every call site that drops it', () => {
    const unstated = sites.drops.filter((file) => !(file in DROPS_THE_SEAM_REPORT));
    expect(
      unstated,
      `these call sites bind effectiveSeverityTable() and never read its .findings; either read them or add the file to DROPS_THE_SEAM_REPORT with the reason it is right to drop them: ${unstated.join(', ')}`
    ).toEqual([]);
    const stale = Object.keys(DROPS_THE_SEAM_REPORT).filter((file) => !sites.drops.includes(file));
    expect(
      stale,
      `these files are excused from reading the seam report and no longer drop it: ${stale.join(', ')}`
    ).toEqual([]);
    // A one-word reason is not a reason.
    for (const [file, reason] of Object.entries(DROPS_THE_SEAM_REPORT)) {
      expect(reason.length, file).toBeGreaterThan(80);
    }
  });

  it('detects a call site that drops it', () => {
    // The positive control: the same predicate, run over source that does drop
    // the report and over source that reads it.
    const drops =
      'const table = effectiveSeverityTable(registry, context);\nreturn table.severityByCode;';
    const reads =
      'const table = effectiveSeverityTable(registry, context);\nfindings.push(...table.findings);';
    const dropsIt = (source) => {
      const match = /const\s+(\w+)\s*=\s*effectiveSeverityTable\(/.exec(source);
      return match !== null && !new RegExp(`\\b${match[1]}\\.findings\\b`).test(source);
    };
    expect(dropsIt(drops)).toBe(true);
    expect(dropsIt(reads)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* A trace field produced and read by nobody is not a fix                       */
/* -------------------------------------------------------------------------- */

/**
 * Fields a module returns **solely** so that something downstream can report a
 * trace, and the file that produces each.
 *
 * The rule this exists for is round 3's finding 5. Round 2 stopped
 * `resolve/legality.js` `checkPlacement()` from discarding the registry seam's
 * report by returning it on `registryFindings` / `registryStatus` — and then no
 * production caller read either field. All four consumers took `legal`,
 * `findings`, `blockingCodes` and `availability`, so the unjudged-scope trace
 * the change existed for reached exactly as many reports as before: none. The
 * fix passed its own tests, because its own tests were the only readers.
 *
 * A field like that is worse than the drop it replaced: the drop is visible in
 * a diff and the field looks like a fix. So each one declared here must have at
 * least one reader under `packages/core/src` **other than the file that
 * produces it**. There are only two honest states — carried and read, or not
 * carried and said so in the docstring — and this check is what makes the
 * middle one fail.
 *
 * @type {Record<string, string>}
 */
const CARRIED_TRACE_FIELDS = Object.freeze({
  registryFindings: 'resolve/legality.js',
});

describe('source hygiene :: a carried trace field has a production reader', () => {
  const files = sourceFilesUnder(CORE_SRC);

  /**
   * Files that read `.<field>` off something, other than the named producer.
   *
   * A read is `.field` appearing anywhere but the producing file. Deliberately
   * crude: the question is whether *any* production module consumes the field
   * at all, and a check that tried to prove the read was of this particular
   * object would fail open on every indirection.
   *
   * @param {string} field
   * @param {string} producer
   * @returns {string[]}
   */
  function readersOf(field, producer) {
    /** @type {string[]} */
    const readers = [];
    for (const file of files) {
      const key = path.relative(CORE_SRC, file).split(path.sep).join('/');
      if (key === producer) continue;
      const source = readFileSync(file, 'utf8');
      // Field reads only: `x.registryFindings`, never the `registryFindings:`
      // that declares one, and never a mention inside a comment line.
      const lines = source
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join('\n');
      if (new RegExp(`\\.${field}\\b`).test(lines)) readers.push(key);
    }
    return readers.sort();
  }

  it('finds the producers it names', () => {
    // The meta-assertion. A table naming a file that does not exist, or a field
    // nothing produces, would make every check below pass for the wrong reason.
    for (const [field, producer] of Object.entries(CARRIED_TRACE_FIELDS)) {
      const full = path.join(CORE_SRC, ...producer.split('/'));
      expect(files, producer).toContain(full);
      expect(readFileSync(full, 'utf8'), `${producer} does not produce ${field}`).toMatch(
        new RegExp(`\\b${field}\\s*:`)
      );
    }
  });

  it('detects a field that nothing outside its producer reads', () => {
    // The positive control: the same predicate over a field name no module
    // anywhere mentions must come back with no readers, so a green result below
    // is a result rather than a regex that never matches.
    expect(readersOf('aFieldNobodyProduces', 'resolve/legality.js')).toEqual([]);
  });

  it('has at least one production reader for every field it carries', () => {
    for (const [field, producer] of Object.entries(CARRIED_TRACE_FIELDS)) {
      const readers = readersOf(field, producer);
      expect(
        readers,
        `"${field}" is produced by ${producer} and read by no other file under packages/core/src. Either surface it at a consumer that can afford it, merge it where the severity belongs, or delete it and say plainly in the docstring that the trace is not carried — a field nobody reads is the appearance of a fix, not a fix (round 3, finding 5).`
      ).not.toEqual([]);
    }
  });
});

/**
 * `timing/index.js` declares that `Date` construction inside `timing/` lives in
 * exactly one file. Declared is not enforced (CLAUDE.md §3), and a carve-out is
 * easier to breach than a blanket ban precisely because it reads as already
 * broken, so the claim is checked rather than trusted.
 */
describe('the timing package keeps its Date construction in one file', () => {
  const TIMING_DIR = path.join(CORE_SRC, 'timing');
  /** The one file the barrel names as the boundary. */
  const BOUNDARY = 'seasonClock.js';

  /**
   * Lines that construct a `Date`, ignoring comments and JSDoc.
   *
   * @param {string} file
   * @returns {string[]}
   */
  function dateConstructionsIn(file) {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => /\bnew Date\s*\(/.test(line));
  }

  const timingFiles = sourceFilesUnder(TIMING_DIR);

  it('finds the timing package at all', () => {
    // Meta-assertion: a walk that matched nothing would make the rule below
    // pass over an empty set, which is the shape this whole file exists for.
    expect(timingFiles.length).toBeGreaterThan(5);
    expect(timingFiles.map((f) => path.basename(f))).toContain(BOUNDARY);
  });

  it('can see a Date construction when there is one (positive control)', () => {
    // The boundary file must itself trip the detector, or the rule below is a
    // regex that never matches dressed up as a clean result.
    expect(dateConstructionsIn(path.join(TIMING_DIR, BOUNDARY)).length).toBeGreaterThan(0);
  });

  it('constructs no Date anywhere else under timing/', () => {
    const offenders = timingFiles
      .filter((file) => path.basename(file) !== BOUNDARY)
      .flatMap((file) =>
        dateConstructionsIn(file).map(
          (line) => `${path.relative(CORE_SRC, file).split(path.sep).join('/')}: ${line.trim()}`
        )
      );
    expect(
      offenders,
      `timing/index.js states that ${BOUNDARY} is the only place in this package that turns a value into a Date. Either compose through timing/seasonClock.js or change the claim in the barrel -- a stated invariant nothing checks is how GAP-30 survived.`
    ).toEqual([]);
  });
});
