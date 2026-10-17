// @vitest-environment node
/**
 * Text is committed with LF line endings (plan item M6.2, audit finding 12.7,
 * standard core.lf-line-endings), checked offline in `npm run test` the way
 * the standard's probe checks it: `git ls-files --eol` reports what is in the
 * index, and an entry committed `i/crlf` or `i/mixed` fails.
 *
 * The exception is a file that must stay byte for byte as committed: the six
 * migrations applied with CRLF (or mixed) endings, which the migration tool
 * never re-runs and `scripts/ci/migrationVersions.mjs` refuses to see edited.
 * Each is marked `-text` in `.gitattributes` by name; a `-text` rule for a
 * folder or a pattern would also excuse every migration still to be written,
 * so only exact paths of applied migrations count.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/**
 * Each `git ls-files --eol` line as { index, attr, file }.
 * @param {string} output
 */
function parseEol(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      const [index, , attr] = meta.trim().split(/\s+/);
      return { index, attr: attr ?? '', file };
    });
}

/**
 * Committed CRLF or mixed files not kept as committed on purpose.
 * @param {{ index: string, attr: string, file: string }[]} entries
 */
function eolProblems(entries) {
  return entries
    .filter(({ index }) => index === 'i/crlf' || index === 'i/mixed')
    .filter(({ attr }) => !/(^|\/)-text\b|binary/.test(attr))
    .map(({ index, file }) => `${file} (${index})`);
}

/** The `-text` rules in a .gitattributes, as their patterns. */
function unTextRules(/** @type {string} */ gitattributes) {
  return gitattributes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => line.split(/\s+/).slice(1).includes('-text'))
    .map((line) => line.split(/\s+/)[0]);
}

const MIGRATION = /^supabase\/migrations\/\d{14}_[\w-]+\.sql$/;

describe('line endings', () => {
  const entries = parseEol(
    execFileSync('git', ['ls-files', '--eol'], { cwd: ROOT, encoding: 'utf8' })
  );

  it('commits no text file with CRLF or mixed endings, outside the named exceptions', () => {
    // Meta: the listing is the whole index, not an empty or failed one.
    expect(entries.length).toBeGreaterThan(1000);
    expect(entries.some(({ file }) => file === 'package.json')).toBe(true);
    expect(eolProblems(entries)).toEqual([]);
  });

  it('keeps as committed only applied migrations, each named, none by pattern', () => {
    const rules = unTextRules(readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((rule) => !MIGRATION.test(rule))).toEqual([]);
    // Every exception is a tracked file that still needs it: one later
    // normalized (or deleted) should lose its rule.
    const crlf = new Set(
      entries.filter(({ index }) => index === 'i/crlf' || index === 'i/mixed').map((e) => e.file)
    );
    expect(rules.filter((rule) => !crlf.has(rule))).toEqual([]);
  });

  it('the detectors catch a CRLF file, and pass a named -text or binary one', () => {
    const listing = [
      'i/crlf  w/crlf  attr/text=auto eol=lf \tdocs/a.md',
      'i/mixed w/mixed attr/text=auto eol=lf \tdocs/b.md',
      'i/lf    w/lf    attr/text=auto eol=lf \tdocs/c.md',
      'i/crlf  w/crlf  attr/-text            \tsupabase/migrations/20240101000000_x.sql',
      'i/-text w/-text attr/binary           \tpublic/x.png',
    ].join('\n');
    expect(eolProblems(parseEol(listing))).toEqual(['docs/a.md (i/crlf)', 'docs/b.md (i/mixed)']);
    expect(
      unTextRules('* text=auto eol=lf\n*.png binary\nsupabase/migrations/*.sql -text\n')
    ).toEqual(['supabase/migrations/*.sql']);
    expect(MIGRATION.test('supabase/migrations/*.sql')).toBe(false);
  });
});
