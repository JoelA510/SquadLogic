/**
 * Text colour comes from the theme tokens, never from Tailwind's palette shades (plan item M4.2,
 * "Discovered during execution": 29 files used `-400` shades for text).
 *
 * The palette shades (`text-blue-400`, `text-red-300`, `text-amber-500`, ...) were picked for the
 * old dark-only UI. They do not change with the theme, and on the light theme's surfaces they
 * fall short of WCAG 2.2 AA's 4.5:1 for text (`blue-400` on white is 2.5:1, `amber-500` 2.1:1).
 * The tokens are AA in both themes: `text-text-{primary,secondary,muted,accent}` and
 * `text-status-{success,warning,error}-text` (`frontend/src/index.css`;
 * `docs/ui/agent-ui-ux-guidelines.md`, "Colors"). `text-brand-400` is the one theme class that
 * fails the same way (`--primary-light`, 3.4:1 on white), so it is refused too.
 *
 * Every shade of the default palette is refused, not only `-400`: the lighter ones are worse on a
 * light surface, and `-500` fails as well. An exception names its file, the exact class, and why.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|' +
  'pink|rose|slate|gray|zinc|neutral|stone';

/**
 * A text-colour class from the palette, with any variant prefixes (`hover:`, `dark:`) and any
 * opacity suffix (`/80`, `/[0.9]`), or `text-brand-400`.
 */
const PALETTE_TEXT = new RegExp(
  `(?<![\\w-])(?:[a-z0-9-]+:)*text-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|brand-400)` +
    `(?:\\/(?:\\d+|\\[[\\d.]+\\]))?(?![\\w-])`,
  'g'
);

/** Allowed occurrences: `{ file (relative to frontend/src), match, reason }`. */
const EXCEPTIONS = [
  {
    file: 'components/ui/DataErrorBanner.jsx',
    match: 'text-red-500',
    reason: 'a doc comment quoting the class the banner replaced; nothing renders it',
  },
];

/** @returns {string[]} every .js/.jsx file under `dir` */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(jsx?|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

/** Every palette text class in `text`, as `{ match, line }`. */
function findPaletteText(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const m of line.matchAll(PALETTE_TEXT)) found.push({ match: m[0], line: index + 1 });
  });
  return found;
}

describe('text colours come from the theme tokens, not palette shades', () => {
  const files = sourceFiles(FRONTEND_SRC);
  const hits = files.flatMap((file) =>
    findPaletteText(readFileSync(file, 'utf8')).map((hit) => ({
      ...hit,
      file: path.relative(FRONTEND_SRC, file).split(path.sep).join('/'),
    }))
  );
  const isExcepted = (hit) =>
    EXCEPTIONS.some((e) => e.file === hit.file && hit.match.endsWith(e.match));

  it('reads the frontend source (the walk is not matching nothing)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((file) => file.endsWith(path.join('pages', 'PlayersPage.jsx')))).toBe(true);
  });

  it('finds the classes it refuses, and not the tokens or other utilities', () => {
    const sample = [
      'className="text-blue-400"',
      "'hover:text-red-300'",
      '`text-sky-400/80 font-bold`',
      'dark:text-amber-500',
      'text-emerald-400/[0.9]',
      'text-brand-400',
      'text-[10px] text-green-500',
    ].join('\n');
    expect(findPaletteText(sample).map((hit) => hit.match)).toEqual([
      'text-blue-400',
      'hover:text-red-300',
      'text-sky-400/80',
      'dark:text-amber-500',
      'text-emerald-400/[0.9]',
      'text-brand-400',
      'text-green-500',
    ]);
    const allowed = [
      'text-text-accent text-text-muted text-status-error-text text-status-success-text',
      'bg-blue-400 border-red-400 from-sky-400 ring-amber-500 text-brand-500 text-brand-600',
      'text-text-blue-400-ish text-xs text-[10px] text-blue-4000',
    ].join('\n');
    expect(findPaletteText(allowed)).toEqual([]);
  });

  it('uses no palette shade for text outside the listed exceptions', () => {
    const offenders = hits.filter((hit) => !isExcepted(hit));
    expect(
      offenders.map((hit) => `${hit.file}:${hit.line} ${hit.match}`),
      'Use the theme tokens (text-text-*, text-status-*-text); see docs/ui/agent-ui-ux-guidelines.md'
    ).toEqual([]);
  });

  it('lists only exceptions that still occur, each with a reason', () => {
    for (const exception of EXCEPTIONS) {
      expect(exception.reason.length, `${exception.file}: give the reason`).toBeGreaterThan(10);
      expect(
        hits.some((hit) => hit.file === exception.file && hit.match.endsWith(exception.match)),
        `${exception.file} ${exception.match} no longer occurs: delete the exception`
      ).toBe(true);
    }
  });
});
