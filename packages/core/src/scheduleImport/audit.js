/**
 * The conflict audit of an imported schedule, with its coverage stated (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` section 4.4; PR 4, task D2).
 *
 * Owner's rule: conflicts in an imported schedule are **accepted and flagged, never rejected**. This
 * is the flagging. It asks the Games page's own question, `evaluateGameSchedule`, so the preview and
 * the page cannot disagree about what a clash is (lesson 77: a preview is a twin of the writer; the
 * safest twin is the same function). It adds what the page never had to say.
 *
 * ## What it does not claim ("declared is not enforced")
 *
 * - **It names what it did not check.** The three checks the Games page runs (a team, a coach and a
 *   field not in two places at once) and the hosting balance. Shared space and the travel time
 *   between fields are not checked (the generator does not consult them either, plan finding 8),
 *   and the sentence says so.
 * - **A team with no coach is "not judged", never "clear".** A schedule whose teams have no coach
 *   assigned must not read as "0 coach clashes". Each check has a status: `flagged`, `clear`,
 *   `partly-judged` (nothing found, but something was not looked at) or `not-judged`.
 * - **A game with no time is not checked at all** and is listed.
 * - **The subject set is the roster crossed with the schedule**, both sides of every game: a team
 *   that only ever visits is on the schedule, and a rostered team with no game is listed rather
 *   than counted as fine (the roster, not the games, is what a break could have emptied).
 *
 * ## Outside clubs
 *
 * An outside club is one team row per (division, label): it merges several real teams, so being in
 * two games at once is legal for it (plan 4.6) and "hosts none of its games" is a fact about the
 * label, not a fault. Its `team-double-booked` and `home-away-imbalance` are not reported. Its
 * games are still on fields and still count for the fields' overlap and for the own team's
 * coaches.
 *
 * ## One game, one key
 *
 * The evaluator reports a clash by slot id. A stored double booking puts two games in one slot, so
 * the audit gives each game its own `slotId` (the game's key): the report then names the games,
 * and `flags[].games` says which game, which team and which side (`home` or `away`).
 */

import { evaluateGameSchedule } from '../gameMetrics.js';
import { SCHEDULE_IMPORT_REASON as R } from './reasonCodes.js';

const CHECKED = Object.freeze([
  'team overlap',
  'coach overlap',
  'same-field overlap',
  'hosting balance',
]);
const NOT_CHECKED = Object.freeze(['shared space', 'travel time between fields']);
const AUDITED_TYPES = Object.freeze([
  R.FIELD_OVERLAP,
  R.COACH_CONFLICT,
  R.TEAM_DOUBLE_BOOKED,
  R.HOME_AWAY_IMBALANCE,
]);
/** The warning types that do not apply to an outside club. */
const NOT_FOR_OUTSIDE = Object.freeze([R.TEAM_DOUBLE_BOOKED, R.HOME_AWAY_IMBALANCE]);

/**
 * @typedef {Object} AuditGame
 * @property {string} key  unique in the audit
 * @property {number} weekIndex
 * @property {string} division
 * @property {string | null} fieldId
 * @property {string | null} start  an ISO instant carrying its offset, or null for a game with no time
 * @property {string | null} end
 * @property {string} homeTeamId
 * @property {string} awayTeamId
 */

/**
 * @typedef {Object} AuditTeam  the roster
 * @property {string} id
 * @property {string} division
 * @property {string[]} [coachIds]  every coach, first coach first
 * @property {boolean} [isExternal]  an outside club
 */

/**
 * The two sides of a game. Every per-team reading in this module goes through here, so that the home
 * team is never the only one looked at.
 *
 * @param {AuditGame} game
 * @returns {Array<{ teamId: string, role: 'home' | 'away' }>}
 */
function sidesOf(game) {
  return [
    { teamId: game.homeTeamId, role: 'home' },
    { teamId: game.awayTeamId, role: 'away' },
  ];
}

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Audit a schedule for conflicts, and say what it covered.
 *
 * @param {{ games: AuditGame[], teams: AuditTeam[] }} input
 * @returns {{
 *   warnings: Array<{ type: string, message: string, details: any }>,
 *   counts: Record<string, number>,
 *   flags: Array<{ type: string, subjectId: string, games: Array<{ key: string, teamId: string | null, role: 'home' | 'away' | null }> }>,
 *   checks: { teamOverlap: string, coachOverlap: string, fieldOverlap: string, hostingBalance: string },
 *   coverage: any,
 *   sentence: string,
 * }}
 * @throws {TypeError} on input that is not what it says, and on a game key used twice
 */
export function auditSchedule({ games, teams }) {
  if (!Array.isArray(games)) throw new TypeError('auditSchedule: games must be an array');
  if (!Array.isArray(teams)) throw new TypeError('auditSchedule: teams must be an array');
  const byKey = new Map();
  for (const game of games) {
    if (typeof game?.key !== 'string' || game.key === '') {
      throw new TypeError('auditSchedule: every game needs a non-empty string key');
    }
    if (byKey.has(game.key)) {
      throw new TypeError(`auditSchedule: the game key "${game.key}" is used twice`);
    }
    byKey.set(game.key, game);
  }
  const roster = new Map(teams.map((t) => [t.id, t]));
  const externalIds = new Set(teams.filter((t) => t.isExternal === true).map((t) => t.id));

  // A game with no time cannot be placed against another; it is listed, not judged.
  const auditable = games.filter((g) => g.start && g.end);
  const gamesNotJudged = games
    .filter((g) => !(g.start && g.end))
    .map((g) => ({ key: g.key, reason: 'no-time' }));

  const report = evaluateGameSchedule({
    assignments: auditable.map((g) => ({
      id: g.key,
      slotId: g.key,
      weekIndex: g.weekIndex,
      division: g.division,
      start: g.start,
      end: g.end,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      fieldId: g.fieldId ?? null,
    })),
    teams: teams.map((t) => {
      const coachIds = (t.coachIds ?? []).filter((c) => typeof c === 'string' && c !== '');
      return {
        id: t.id,
        name: t.id,
        division: t.division,
        ...(coachIds.length > 0
          ? { coachId: coachIds[0], assistantCoachIds: coachIds.slice(1) }
          : {}),
      };
    }),
  });

  const warnings = report.warnings.filter(
    (w) => !(NOT_FOR_OUTSIDE.includes(w.type) && externalIds.has(w.details?.teamId))
  );

  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(AUDITED_TYPES.map((type) => [type, 0]));
  const flags = [];
  /** @param {string} key @param {string | null} teamId */
  const gameRef = (key, teamId) => {
    const game = byKey.get(key);
    const side = teamId === null || !game ? null : sidesOf(game).find((s) => s.teamId === teamId);
    return { key, teamId, role: side ? side.role : null };
  };
  for (const w of warnings) {
    if (!AUDITED_TYPES.includes(w.type)) continue;
    counts[w.type] += 1;
    const d = w.details ?? {};
    if (w.type === R.FIELD_OVERLAP) {
      flags.push({
        type: w.type,
        subjectId: d.fieldId,
        games: (d.conflicts ?? []).map((c) => gameRef(c.slotId, null)),
      });
    } else if (w.type === R.HOME_AWAY_IMBALANCE) {
      flags.push({ type: w.type, subjectId: d.teamId, games: [] });
    } else {
      const subjectId = w.type === R.COACH_CONFLICT ? d.coachId : d.teamId;
      flags.push({
        type: w.type,
        subjectId,
        games: (d.conflicts ?? []).map((c) => gameRef(c.slotId, c.teamId ?? null)),
      });
    }
  }
  flags.sort(
    (a, b) =>
      AUDITED_TYPES.indexOf(a.type) - AUDITED_TYPES.indexOf(b.type) ||
      String(a.subjectId).localeCompare(String(b.subjectId))
  );

  // Coverage: the roster crossed with the schedule, both sides of every game.
  const onSchedule = new Set(games.flatMap((g) => sidesOf(g).map((s) => s.teamId)));
  const timedSides = new Set(auditable.flatMap((g) => sidesOf(g).map((s) => s.teamId)));
  const unknown = [...onSchedule].filter((id) => !roster.has(id)).sort();
  const ownOnSchedule = teams.filter((t) => t.isExternal !== true && onSchedule.has(t.id));
  const outsideOnSchedule = teams.filter((t) => t.isExternal === true && onSchedule.has(t.id));
  const withoutGames = teams
    .filter((t) => !onSchedule.has(t.id))
    .map((t) => t.id)
    .sort();
  const coachNotJudged = [];
  let coachJudged = 0;
  for (const t of ownOnSchedule) {
    const hasCoach = (t.coachIds ?? []).some((c) => typeof c === 'string' && c !== '');
    if (hasCoach && timedSides.has(t.id)) coachJudged += 1;
    else coachNotJudged.push({ teamId: t.id, reason: hasCoach ? 'no-timed-game' : 'no-coach' });
  }
  coachNotJudged.sort((a, b) => a.teamId.localeCompare(b.teamId));

  const status = (count, judgedAnything, partial) =>
    count > 0 ? 'flagged' : !judgedAnything ? 'not-judged' : partial ? 'partly-judged' : 'clear';
  const gamesPartial = gamesNotJudged.length > 0;
  const checks = {
    teamOverlap: status(counts[R.TEAM_DOUBLE_BOOKED], auditable.length > 0, gamesPartial),
    coachOverlap: status(
      counts[R.COACH_CONFLICT],
      coachJudged > 0,
      coachNotJudged.length > 0 || gamesPartial
    ),
    fieldOverlap: status(counts[R.FIELD_OVERLAP], auditable.length > 0, gamesPartial),
    hostingBalance: status(counts[R.HOME_AWAY_IMBALANCE], auditable.length > 0, gamesPartial),
  };

  const sentences = [
    `Checked: ${CHECKED.join(', ')}.`,
    `Not checked: ${NOT_CHECKED.join(', ')}.`,
    `Coach overlap was judged only for the teams that have a coach assigned (${coachJudged} of ${ownOnSchedule.length} teams).`,
  ];
  if (outsideOnSchedule.length > 0) {
    const n = outsideOnSchedule.length;
    sentences.push(
      `${n} outside ${plural(n, 'team is', 'teams are')} not judged for team overlap or hosting balance.`
    );
  }
  if (gamesNotJudged.length > 0) {
    const n = gamesNotJudged.length;
    sentences.push(
      `${n} ${plural(n, 'game', 'games')} with no time ${plural(n, 'was', 'were')} not checked.`
    );
  }

  return {
    warnings,
    counts,
    flags,
    checks,
    coverage: {
      checked: [...CHECKED],
      notChecked: [...NOT_CHECKED],
      gamesAudited: auditable.length,
      gamesNotJudged,
      teams: {
        onSchedule: ownOnSchedule.length + outsideOnSchedule.length,
        own: ownOnSchedule.length,
        outside: outsideOnSchedule.length,
        unknown,
        withoutGames,
        coachJudged,
        coachNotJudged,
      },
    },
    sentence: sentences.join(' '),
  };
}

/**
 * Audit the rows of a resolved import: the rows `resolveScheduleRows` placed or left TIME TBD, against
 * the league's teams (with their coaches) and the teams the import would create (no coach; an
 * outside club is flagged external).
 *
 * @param {{ league: { teams: Array<{ id: string, divisionId: string, coachIds?: string[], isExternal?: boolean }> }, rows: Array<any> }} input
 */
export function auditResolvedRows({ league, rows }) {
  if (!league || !Array.isArray(league.teams)) {
    throw new TypeError('auditResolvedRows: league.teams must be an array');
  }
  if (!Array.isArray(rows)) throw new TypeError('auditResolvedRows: rows must be an array');
  const used = rows.filter((r) => (r.status === 'ok' || r.status === 'tbd') && r.ids);
  /** @type {Map<string, AuditTeam>} */
  const roster = new Map(
    league.teams.map((t) => [
      t.id,
      {
        id: t.id,
        division: t.divisionId,
        coachIds: t.coachIds ?? [],
        isExternal: t.isExternal === true,
      },
    ])
  );
  for (const r of used) {
    for (const id of [r.ids.home, r.ids.away]) {
      if (!roster.has(id) && id.startsWith('new:')) {
        roster.set(id, {
          id,
          division: r.ids.division,
          coachIds: [],
          isExternal: id.startsWith('new:outside:'),
        });
      }
    }
  }
  return auditSchedule({
    games: used.map((r) => ({
      key: r.rowKey,
      weekIndex: r.weekIndex,
      division: r.ids.division,
      // A TIME TBD game is not placed: no field, no instant.
      fieldId: r.status === 'ok' ? r.ids.field : null,
      start: r.status === 'ok' ? r.start : null,
      end: r.status === 'ok' ? r.end : null,
      homeTeamId: r.ids.home,
      awayTeamId: r.ids.away,
    })),
    teams: [...roster.values()],
  });
}
