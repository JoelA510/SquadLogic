/**
 * The E2E accessibility scan (`tests/e2e/features/accessibility.feature`, plan item M4.2) must
 * cover every top-level route the app declares.
 *
 * The scan's route table is written by hand, so a route added to `App.jsx` would otherwise go
 * unscanned without anything failing. This test reads the routes from `App.jsx`, the source a new
 * route can't avoid, not from the feature file, and holds the two together: each static route is
 * scanned, each parameterised one is scanned on a seeded record or listed below with the reason
 * it isn't.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'frontend', 'src', 'App.jsx');
const FEATURE = path.join(ROOT, 'tests', 'e2e', 'features', 'accessibility.feature');

/** Routes the scan leaves out, each with why. A static route never belongs here. */
const NOT_SCANNED = {
  '*': 'the catch-all redirects to /, which is scanned',
};

/**
 * Whether the scanned path `scanned` is an instance of the declared route `route`: equal, or
 * equal segment by segment with each `:param` segment matching one non-empty segment.
 * `/players/player-1` covers `/players/:playerId`.
 */
function covers(route, scanned) {
  if (route === scanned) return true;
  if (!route.includes(':')) return false;
  const want = route.split('/');
  const got = scanned.split('/');
  return (
    want.length === got.length &&
    want.every((segment, i) => (segment.startsWith(':') ? got[i] !== '' : segment === got[i]))
  );
}

/**
 * Every `path="..."` in `text`, wherever it sits among a <Route>'s props. A `path` that is not a
 * string literal can't be read here, so it is returned as-is and fails the coverage check.
 */
function declaredRoutes(text) {
  return [...text.matchAll(/\bpath=(?:"([^"]+)"|(\{[^}]*\}))/g)].map((m) => m[1] ?? m[2]);
}

/**
 * The first column of the feature's Examples table, plus every route a scenario of its own scans
 * by name (`axe finds no serious or critical violations on "/login" in ...`): the sign-in page,
 * and the invite link, whose code is part of the path.
 */
function scannedRoutes(text) {
  const rows = [...text.matchAll(/^\s*\|\s*(\/[^\s|]*)\s*\|/gm)].map((m) => m[1]);
  // A live Gherkin step only: a `#`-commented step, or one in a description, names no scan.
  const named = [
    ...text.matchAll(
      /^[ \t]*(?:Given|When|Then|And|But)[ \t]+axe finds .*violations on "(\/[^"\s]*)" in the/gm
    ),
  ].map((m) => m[1]);
  return [...new Set([...rows, ...named])];
}

/** Declared routes neither scanned (directly or through a seeded record) nor in NOT_SCANNED. */
function unscannedRoutes(declared, scanned) {
  return declared.filter(
    (route) => !scanned.some((path) => covers(route, path)) && !Object.hasOwn(NOT_SCANNED, route)
  );
}

describe('accessibility scan coverage', () => {
  const declared = declaredRoutes(readFileSync(APP, 'utf8'));
  const scanned = scannedRoutes(readFileSync(FEATURE, 'utf8'));

  it('reads routes from both files (the parsers are not matching nothing)', () => {
    expect(declared.length).toBeGreaterThan(25);
    expect(declared).toContain('/');
    expect(declared).toContain('/schedule/game');
    expect(scanned.length).toBeGreaterThan(25);
    expect(scanned).toContain('/login');
  });

  it('scans every static route App.jsx declares', () => {
    expect(unscannedRoutes(declared, scanned)).toEqual([]);
  });

  it('leaves out only parameterised routes and the catch-all, and only ones that exist', () => {
    for (const route of Object.keys(NOT_SCANNED)) {
      expect(route === '*' || route.includes(':'), `${route} is static: scan it`).toBe(true);
      expect(declared, `${route} is no longer declared: drop it`).toContain(route);
    }
  });

  it('scans nothing App.jsx does not declare', () => {
    const unknown = scanned.filter(
      (path) => path !== '/login' && !declared.some((route) => covers(route, path))
    );
    expect(unknown).toEqual([]);
  });

  it('scans each record page on a seeded record, and matches a record path to its route', () => {
    for (const route of ['/players/:playerId', '/team/:teamId', '/invite/:code']) {
      expect(declared).toContain(route);
      expect(unscannedRoutes([route], scanned)).toEqual([]);
    }
    expect(covers('/players/:playerId', '/players/player-1')).toBe(true);
    expect(covers('/invite/:code', '/invite/SPRING2026')).toBe(true);
    expect(covers('/invite/:code', '/invite/')).toBe(false);
    expect(covers('/players/:playerId', '/players/')).toBe(false);
    expect(covers('/players/:playerId', '/players/player-1/edit')).toBe(false);
    expect(covers('/team/:teamId', '/teams/t1')).toBe(false);
    expect(covers('/teams', '/teams/builder')).toBe(false);
    // A record path dropped from the scan leaves its route unscanned.
    const withoutPlayer = scanned.filter((path) => path !== '/players/player-1');
    expect(unscannedRoutes(declared, withoutPlayer)).toEqual(['/players/:playerId']);
    // The invite link is scanned by scenarios of its own; without them its route is unscanned.
    const withoutInvite = scanned.filter((path) => !path.startsWith('/invite/'));
    expect(unscannedRoutes(declared, withoutInvite)).toEqual(['/invite/:code']);
  });

  it('counts a live scan step, and not a commented-out one or prose that quotes it', () => {
    const live =
      '    And axe finds no serious or critical violations on "/invite/SPRING2026" in the "light" theme';
    expect(scannedRoutes(live)).toEqual(['/invite/SPRING2026']);
    expect(
      scannedRoutes(
        `Then axe finds no serious or critical violations on "/login" in the "dark" theme`
      )
    ).toEqual(['/login']);
    // Negative controls: the step is not run when it is commented out.
    expect(scannedRoutes(`    # ${live.trim()}`)).toEqual([]);
    expect(
      scannedRoutes(
        `#And axe finds no serious or critical violations on "/login" in the "light" theme`
      )
    ).toEqual([]);
    expect(
      scannedRoutes(
        `  # Scenario notes: axe finds no serious or critical violations on "/login" in the "light" theme`
      )
    ).toEqual([]);
  });

  it('catches a route dropped from the scan, and one declared out of the usual order', () => {
    const withoutGame = scanned.filter((route) => route !== '/schedule/game');
    expect(unscannedRoutes(declared, withoutGame)).toEqual(['/schedule/game']);

    // `element` before `path`, with a self-closing child, and a computed path.
    const reordered = declaredRoutes(
      '<Route element={<Guard><NewPage /></Guard>} path="/new" />' +
        '<Route path={NEW_PATH} element={<NewPage />} />'
    );
    expect(reordered).toEqual(['/new', '{NEW_PATH}']);
    expect(unscannedRoutes(reordered, scanned)).toEqual(['/new', '{NEW_PATH}']);
  });
});
