/**
 * Repo-wide name guard: the pilot club's real name and its real venue names
 * stay out of the working tree.
 *
 * Before the heat feature, field-availability fixtures, tests and docs carried
 * a real club's name, its abbreviation and the real names of its venues. They
 * were replaced by synthetic ones (`Venue A` .. `Venue J`, "the pilot club",
 * "Example Club"); this file keeps the originals out of every scanned file. It
 * cannot name what it keeps out -- that would commit them again -- so the
 * denylist below holds only SHA-256 digests of the normalised forms, computed
 * outside the repo.
 *
 * Normalisation, applied identically to the denylist and to every file: words
 * are runs of letters or digits, split at camelCase and acronym boundaries,
 * lower-cased; everything else separates them. Each word, and each run of two
 * and three consecutive words, is hashed and looked up. So case, spacing, line
 * breaks, punctuation, `_`, `-` and camelCase joins between the words of a
 * name do not hide it.
 *
 * The files are the `tests/helpers/repoScanFiles.js` universe, the one
 * `tests/heatSyntheticCoordinates.test.js` scans.
 *
 * Statically out of reach, and so not claimed: misspellings; names split
 * across more than three words; names run together in one lower-case word
 * (a domain, an email address, a slug); non-ASCII spellings; anything outside
 * the helper's universe (its header lists the gaps); real names never put on
 * the denylist; and whether each digest was computed from the right text --
 * that was checked once, outside the repo, against the pre-scrub tree, and
 * nothing here re-checks it, so a digest added later must be checked the same
 * way.
 *
 * This is a regression check, not a privacy control: the names remain in git
 * history by operator ruling, and the digests are unsalted hashes of short
 * words, recoverable by a dictionary attack.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

import { REPO_ROOT, scannedFiles } from './helpers/repoScanFiles.js';

/**
 * Files deliberately not scanned, each with its reason. None today: this
 * file holds only digests, so it is scanned like any other.
 *
 * @type {Record<string, string>}
 */
const NOT_SCANNED = Object.freeze({});

/**
 * SHA-256 of each normalised denied n-gram: the club's name, its abbreviation
 * and its venue names, as single distinctive words and as the two- and
 * three-word forms they took. A word with an innocent use in the tree when
 * the list was built (a cited author's surname, an ordinary adjective) is
 * listed only inside its n-gram.
 */
const DENIED_DIGESTS = new Set([
  '030f6f7039e0979d409948fd3c0c387d2b09d1141608ff71f8103d491350800e',
  '03fd72f81572805dd59f829b94fd8a6f82077fb435ca2b406d9595718e521afa',
  '04bbafb0c830c964bc6a6933f637b84b7370e37d8c5ca4eee23b6ef271459cd1',
  '10777fd6555063e5b0ce799f73e322117f5c9b6e6742122f3dbf84b9b317cb43',
  '14463247c256f99bdd5f1bc889002310dc510b7549030e545c89dc42fb6126eb',
  '3fe3cd0790995b0d972a974cc53f44017ec58bcf378d263394631355ca0a3dbf',
  '81a2110b86f2dcafa103280425387eaaceb74952416db352845a703722f7f78d',
  '844f760eaf206c20320308ac7b865f7eb8d6a1d951531e7b375fa0cec4cdd099',
  '93f0c40e39fe5846e22e8e5d1cdd106783fe5c37f8d3a2c66f806b0c10369b3e',
  'a2ed9d831121916c65ce14fe996df3adc12cf54eba29df0927a54db418f4d563',
  'c1e6b44cf55d2c831a2a185cdd1ff5d17d2bb15f7f863a6891e7b476c988823a',
  'c6379bbc3e76035281b27699ce6f3b1a6cb685fc7bf79b4a3af4b92729f435cf',
  'df835dcf8d6c492c3d340604b9e58d8603d98cd5f90e754a3a85cf174488e17d',
  'e9694174600b4369d6e4ec5aad894f335f4da06173d6a7f5c6a6d843c28298f8',
  'f5147cbe513d63e3173a1158195f1b31fc69d8b6b6746ead4a5d24dc9f59acb7',
  'fcdb285b0b3457f6e64ed11a9ff4c1d2ba4ce49845d9d7b41cf434cc563ce7d9',
  'ff2a8a3987ef4645f85dd41ccf34338ef0044fcc1a5a6ae11887aa305ac7a997',
]);
/** How many digests the list was built with, so a truncated paste fails loudly. */
const DENIED_COUNT = 17;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** A camelCase-aware word: an acronym run, a capitalised or lower-case word, or digits. */
const WORD_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/**
 * The normalised words of `text`, each with its offset into `text`.
 *
 * @param {string} text
 * @returns {{ word: string, index: number }[]}
 */
const wordsOf = (text) =>
  [...text.matchAll(WORD_RE)].map((m) => ({ word: m[0].toLowerCase(), index: m.index }));

/**
 * Denied n-grams in `text`. A gram whose first word starts with a digit is
 * skipped: no denied name does, and the numeric fixtures are most of the
 * repo's words. Lookups are memoised per distinct gram.
 *
 * @param {string} text
 * @param {Set<string>} denied digests
 * @param {Map<string, string | null>} memo: gram -> its digest when denied, else null
 * @returns {{ hits: { index: number, digest: string }[], grams: number }}
 */
function deniedIn(text, denied, memo) {
  const words = wordsOf(text);
  const hits = [];
  let grams = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i].word.charCodeAt(0) <= 57) continue;
    let gram = '';
    for (let n = 0; n < 3 && i + n < words.length; n++) {
      gram = n === 0 ? words[i].word : `${gram} ${words[i + n].word}`;
      grams += 1;
      let digest = memo.get(gram);
      if (digest === undefined) {
        const d = sha256(gram);
        digest = denied.has(d) ? d : null;
        memo.set(gram, digest);
      }
      if (digest) hits.push({ index: words[i].index, digest });
    }
  }
  return { hits, grams };
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Read each of `files` and report every denied n-gram in it.
 *
 * @param {string[]} files repo-relative paths
 * @param {Set<string>} denied digests
 */
function scanFiles(files, denied) {
  const memo = new Map();
  let grams = 0;
  /** @type {string[]} */
  const offenders = [];
  for (const rel of files) {
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const r = deniedIn(text, denied, memo);
    grams += r.grams;
    // File, line and a digest prefix only: the matched text is a real name,
    // and a failure log on a public repo must not print it.
    for (const h of r.hits)
      offenders.push(`${rel}:${lineOf(text, h.index)} (${h.digest.slice(0, 12)})`);
  }
  return { files, grams, distinct: memo.size, offenders };
}

const scan = () => scanFiles(scannedFiles({ notScanned: NOT_SCANNED }), DENIED_DIGESTS);

/*
 * Stated floors. Measured when the guard was added: 1406 files scanned,
 * 7,174,480 n-grams examined and 1,560,511 distinct n-grams hashed. The file
 * floor is the heat guard's, over the same universe; the others leave headroom
 * for churn. A walk or a tokeniser that broke shows here first rather than as
 * a clean scan of nothing.
 */
const MIN_FILES = 1300;
const MIN_GRAMS = 6_000_000;
const MIN_DISTINCT = 1_300_000;

/**
 * The whole-tree scan, run once before the tests rather than at collection,
 * so a filtered run elsewhere does not pay for it. About 7 s on a laptop; the
 * hook's timeout leaves room for a slow CI runner.
 */
let scanned;
beforeAll(() => {
  scanned = scan();
}, 60_000);
const result = () => scanned;

describe('real names :: the denylist and the scan exercised the data', () => {
  it(`holds ${DENIED_COUNT} well-formed SHA-256 digests`, () => {
    expect(DENIED_DIGESTS.size).toBe(DENIED_COUNT);
    for (const d of DENIED_DIGESTS) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it(`scans at least ${MIN_FILES} files, ${MIN_GRAMS} n-grams, ${MIN_DISTINCT} distinct`, () => {
    const { files, grams, distinct } = result();
    expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);
    expect(grams).toBeGreaterThanOrEqual(MIN_GRAMS);
    expect(distinct).toBeGreaterThanOrEqual(MIN_DISTINCT);
  });

  it.each([
    'supabase/tests/fixtures/fall_2026_field_availability.csv',
    'supabase/tests/field_availability_import_phase1.sql',
    'tests/fieldAvailabilityLifecycle.test.js',
    'packages/core/src/playUp.js',
    'docs/fixtures/fall-2026-field-availability.md',
    'CHANGELOG.md',
  ])('scans %s', (rel) => {
    expect(result().files).toContain(rel);
  });

  it('flags a denied n-gram however it is cased, spaced or joined (positive control)', () => {
    // A synthetic denylist, built here exactly as the real one was built
    // outside the repo, so the matcher is proven without naming a real name.
    const denied = new Set(['venue a elementary', 'zzqx'].map(sha256));
    const found = (text) => deniedIn(text, denied, new Map()).hits.length;
    expect(found('location: Venue A Elementary')).toBe(1);
    expect(found('VENUE   a\n  elementary')).toBe(1);
    expect(found('venue_a-elementary')).toBe(1);
    expect(found('venueAElementary')).toBe(1);
    expect(found('fooZzqx bar')).toBe(1);
    expect(found('the zzqx, the ZZQX')).toBe(2);
    expect(found('Venue A Middle')).toBe(0);
    expect(found('zzqxy')).toBe(0);
    // Line numbers point at the hit.
    const text = 'one\ntwo\nthree zzqx';
    const [hit] = deniedIn(text, denied, new Map()).hits;
    expect(lineOf(text, hit.index)).toBe(3);
  });

  it('reports a denied n-gram read from a real file, by file and line (pipeline control)', () => {
    // The same read-and-report path the guard runs, over a tracked file, with
    // a synthetic n-gram that file is known to carry on four rows.
    const csv = 'supabase/tests/fixtures/fall_2026_field_availability.csv';
    const { offenders } = scanFiles([csv], new Set([sha256('venue j potential')]));
    expect(offenders.map((o) => o.split(' ')[0])).toEqual(
      [13, 14, 15, 16].map((n) => `${csv}:${n}`)
    );
  });
});

describe('real names :: no scanned file carries one', () => {
  it('holds every scanned file to the denylist', () => {
    const { offenders } = result();
    expect(offenders, `denied real name at: ${offenders.join('; ')}`).toEqual([]);
  });
});
