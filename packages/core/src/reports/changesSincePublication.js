/**
 * "Changes since publication" (task G4 of PR 7 of the schedule expansion; plan 5.6): for every game, what it was in a
 * chosen published baseline, what it is in the saved schedule, and why. A view, not a store: nothing is written.
 *
 * **Games are enumerated from the baseline rows AND the saved rows together, never from the changed ones**, so a
 * cancelled game, which has no "now", is listed (the lesson `buildChangeNotices` states for teams). The counts
 * reconcile: baseline games = unchanged + changed + removed, and saved games = unchanged + changed + new.
 *
 * **Identity, truthfully.** A baseline records each game's teams, slot and week, not which game is which, so every
 * game is keyed by that tuple (`gameKey`, the one place that decides) and a game moved to another slot or week is one
 * game removed and one game new. That holds with or without an identity layer: the baseline never stored an id. The
 * view says so in its own words and never calls the two the same game; it only shows the same two teams beside each
 * other.
 *
 * **The baseline is the master export's rows** (`publication_baselines`), one row per team per event. A game is
 * rebuilt from its Home row and its Away row (the Home row names the opponent, the Away row has the away team's id);
 * a row that cannot be paired is counted and named, and the view says it cannot then be read as a verdict. The week
 * of a placed game comes from its slot; the week of a TIME TBD game is in its `Notes` sentence.
 *
 * **Why** is the audit: `game.publish_overridden` rows (`get_schedule_audit_log`) whose before-image names the game's
 * tuple, from the moment the baseline was recorded. That RPC returns only the two Published actions, so a save
 * (`game.saved`, a whole schedule) or a cancel (`game.cancelled`, an id the baseline does not hold) cannot be matched
 * to a game here; the view says it does not record whether a game was cancelled or moved.
 *
 * @module reports/changesSincePublication
 */

import { GAME_PUBLISH_REASONS } from '../gamePublished.js';
import { formatCsv } from '../outputGeneration.js';
import { PUBLICATION_TBD } from '../reserve/reasonCodes.js';
import { describeScheduleTbdReason, parseGameTbdNote } from '../scheduleTbd.js';
import { makeNamers } from './daySheet.js';
import { gameKey, positiveWeek, tbdGameKey } from './gameKey.js';
import { instantMs, wallOfInstant, weekdayOfDate } from './wall.js';

/** What happened to a game since the baseline. */
export const CHANGE_KIND = Object.freeze({
  CHANGED: 'changed',
  REMOVED: 'removed',
  ADDED: 'added',
  TBD_CLEARED: 'tbd-cleared',
  TBD_NEW: 'tbd-new',
  TBD_DATE_CHANGED: 'tbd-date-changed',
});

/** The words for each kind, as the page and the file say them. */
export const CHANGE_LABEL = Object.freeze({
  [CHANGE_KIND.CHANGED]: 'Time or field changed',
  [CHANGE_KIND.REMOVED]: 'No longer in the saved schedule',
  [CHANGE_KIND.ADDED]: 'New since publication',
  [CHANGE_KIND.TBD_CLEARED]: 'No longer on the TIME TBD list',
  [CHANGE_KIND.TBD_NEW]: 'Now on the TIME TBD list',
  [CHANGE_KIND.TBD_DATE_CHANGED]: 'TIME TBD game: date changed',
});

/** The file's columns, in order. */
export const CHANGES_COLUMNS = Object.freeze([
  'Change',
  'Division',
  'Home',
  'Away',
  'Originally',
  'Now',
  'Why',
]);

const KIND_ORDER = Object.freeze([
  CHANGE_KIND.CHANGED,
  CHANGE_KIND.REMOVED,
  CHANGE_KIND.ADDED,
  CHANGE_KIND.TBD_CLEARED,
  CHANGE_KIND.TBD_NEW,
  CHANGE_KIND.TBD_DATE_CHANGED,
]);

const MOVED_NOTE =
  "A baseline records each game's teams, slot and week, not which game is which, so a game moved to another time " +
  'slot or week appears here twice: once as no longer in the saved schedule, at its old time, and once as new, at ' +
  'its new time. This view does not link the two. A game that was cancelled appears only as no longer in the saved ' +
  'schedule: the app does not record whether a game was cancelled or moved.';

/** @param {unknown} value */
const text = (value) => (value === null || value === undefined ? '' : String(value));
/** @param {unknown} value */
const idText = (value) => text(value).trim().toLowerCase();

/** Two instants are the same moment, or, when one cannot be read, the same text. */
function sameInstant(a, b) {
  const x = instantMs(a);
  const y = instantMs(b);
  return x !== null && y !== null ? x === y : text(a).trim() === text(b).trim();
}

/**
 * Pair the Home rows of a baseline with their Away rows (the same slot, time and field, the two teams' names crossed;
 * the division only breaks a tie). A Home row with no Away row, or with more than one that
 * reads like it, is unreadable (and claims what is ambiguous, so the Away rows are not reported again); an Away row
 * nobody claimed is unreadable too.
 *
 * **An outside club has no rows of its own** (`generateScheduleExports` names it as the opponent only), so a game
 * against one is ONE row: the own team's. A row with no partner whose Opponent is exactly one outside club of its
 * division (`outsideClubOf`) is that game, the club's side made from the row; any other row with no partner is
 * unreadable, as before.
 */
function pairRows(homes, aways, matches, outsideClubOf) {
  const claimed = new Set();
  const pairs = [];
  const unreadable = [];
  for (const home of homes) {
    let candidates = aways.filter((away) => !claimed.has(away) && matches(home, away));
    // Teams of two divisions can share a name and a slot: the division then tells the games apart. It is not required
    // (a game between divisions is still a game), only a tie-breaker.
    if (candidates.length > 1) {
      const sameDivision = candidates.filter((away) => text(away.Division) === text(home.Division));
      if (sameDivision.length === 1) candidates = sameDivision;
    }
    if (candidates.length === 1) {
      claimed.add(candidates[0]);
      pairs.push([home, candidates[0]]);
      continue;
    }
    const club = candidates.length === 0 ? outsideClubOf(home) : null;
    if (club !== null) {
      pairs.push([home, clubSide(home, club)]);
      continue;
    }
    for (const candidate of candidates) claimed.add(candidate);
    unreadable.push({
      team: text(home['Team Name']),
      opponent: text(home.Opponent),
      why:
        candidates.length === 0
          ? 'the away side of the game is not in the baseline'
          : 'more than one row reads like the away side of the game',
    });
  }
  for (const away of aways) {
    if (claimed.has(away)) continue;
    const club = outsideClubOf(away);
    if (club !== null) {
      pairs.push([clubSide(away, club), away]);
      continue;
    }
    unreadable.push({
      team: text(away['Team Name']),
      opponent: text(away.Opponent),
      why: 'the home side of the game is not in the baseline',
    });
  }
  return { pairs, unreadable };
}

/**
 * The outside club's side of a one-row game: the own team's row with the two teams crossed (the slot, times, field,
 * division and note are the game's, the same on both sides).
 */
function clubSide(row, clubId) {
  return {
    ...row,
    'Team ID': clubId,
    'Team Name': text(row.Opponent),
    Opponent: text(row['Team Name']),
    Role: row.Role === 'Home' ? 'Away' : 'Home',
  };
}

/** The games of a baseline's rows: placed games, TIME TBD games, and the rows that could not be read. */
function readBaselineGames(rows, weekOfSlot, outsideClubOf) {
  const dated = { homes: [], aways: [] };
  const tbd = { homes: [], aways: [] };
  const unreadable = [];
  for (const row of rows) {
    // Practices are not part of this view.
    if (row['Event Type'] !== 'Game') continue;
    const bucket = row.Start === PUBLICATION_TBD.TIME ? tbd : dated;
    if (row.Role === 'Home') bucket.homes.push(row);
    else if (row.Role === 'Away') bucket.aways.push(row);
    else {
      unreadable.push({
        team: text(row['Team Name']),
        opponent: text(row.Opponent),
        why: 'its row says neither Home nor Away',
      });
    }
  }
  const crossNames = (home, away) =>
    text(away['Team Name']) === text(home.Opponent) &&
    text(away.Opponent) === text(home['Team Name']);

  const placed = pairRows(
    dated.homes,
    dated.aways,
    (home, away) =>
      crossNames(home, away) &&
      text(away.Slot) === text(home.Slot) &&
      text(away.Start) === text(home.Start) &&
      text(away.End) === text(home.End) &&
      text(away.Field) === text(home.Field),
    outsideClubOf
  );
  const waiting = pairRows(
    tbd.homes,
    tbd.aways,
    (home, away) => crossNames(home, away) && text(away.Notes) === text(home.Notes),
    outsideClubOf
  );
  unreadable.push(...placed.unreadable, ...waiting.unreadable);

  const games = placed.pairs.map(([home, away]) => ({
    homeTeamId: text(home['Team ID']),
    awayTeamId: text(away['Team ID']),
    slotId: text(home.Slot),
    weekIndex: weekOfSlot.get(idText(home.Slot)) ?? null,
    start: text(home.Start),
    end: text(home.End),
    fieldId: text(home.Field),
    division: text(home.Division),
    homeName: text(home['Team Name']),
    awayName: text(home.Opponent),
  }));
  const tbdGames = [];
  for (const [home, away] of waiting.pairs) {
    const note = parseGameTbdNote(home.Notes);
    if (note === null) {
      unreadable.push({
        team: text(home['Team Name']),
        opponent: text(home.Opponent),
        why: 'its TIME TBD note could not be read',
      });
      continue;
    }
    tbdGames.push({
      homeTeamId: text(home['Team ID']),
      awayTeamId: text(away['Team ID']),
      weekIndex: note.weekIndex,
      // the date an import gave the game, when the note carries one (`parseGameTbdNote`)
      gameDate: note.gameDate ?? null,
      why: note.why,
      division: text(home.Division),
      homeName: text(home['Team Name']),
      awayName: text(home.Opponent),
    });
  }
  return { games, tbdGames, unreadable };
}

/** @param {string} code */
const reasonLabel = (code) =>
  GAME_PUBLISH_REASONS.find((reason) => reason.code === code)?.label ?? text(code);

/**
 * Build the view.
 *
 * @param {Object} input
 * @param {{ rows: Array<Record<string, string>>, recordedAt: string, version?: number | null, label?: string | null }} input.baseline
 *   the chosen baseline: the master export's rows as they were published, and when the baseline was recorded
 * @param {Array<Record<string, any>>} input.savedGames - the saved schedule (camelCase rows of the latest run)
 * @param {Array<{ homeTeamId: string, awayTeamId: string, weekIndex: number, reason: string, gameDate?: string | null }>} [input.tbdGames] - the TIME TBD games now
 * @param {Array<{ id: string, name: string, division?: string | null, isExternal?: boolean }>} input.teams - the registry,
 *   outside clubs included (a game against one is one row of the baseline)
 * @param {Array<{ id: string, name: string, venueId?: string | null }>} input.fields
 * @param {Array<{ id: string, name: string }>} input.venues
 * @param {Array<{ id: string, weekIndex: number }>} input.slots - the game slots, for the week of a baseline's slot
 * @param {string} input.timeZone
 * @param {Array<Record<string, any>>} [input.auditRows] - `get_schedule_audit_log` rows, newest first
 * @param {number} [input.auditLimit] - the limit the audit rows were asked with
 */
export function buildChangesSincePublication({
  baseline,
  savedGames,
  tbdGames = [],
  teams,
  fields,
  venues,
  slots,
  timeZone,
  auditRows = [],
  auditLimit = 500,
}) {
  if (!timeZone) throw new TypeError('the changes view needs the season’s time zone');
  if (!baseline || !Array.isArray(baseline.rows) || baseline.rows.length === 0) {
    throw new TypeError('the baseline has no rows to compare against');
  }
  const recordedMs = instantMs(baseline.recordedAt);
  if (recordedMs === null) throw new TypeError('the baseline has no readable time it was recorded');
  const names = makeNamers({ teams, fields, venues });

  // The week of a slot: the saved games that name it, then the registry. Only a real week (a positive whole number)
  // is written: a slot whose `week_index` is null must not overwrite the week a saved game carries with 0.
  const weekOfSlot = new Map();
  for (const game of savedGames) {
    const slot = idText(game.slotId ?? game.gameSlotId);
    const week = positiveWeek(game.weekIndex);
    if (slot && week !== null) weekOfSlot.set(slot, week);
  }
  for (const slot of slots) {
    const week = positiveWeek(slot.weekIndex);
    if (week !== null) weekOfSlot.set(idText(slot.id), week);
  }

  // An outside club, by the name and division a row prints (`pairRows`): one exactly, and only when no team of the
  // league's own has that name in that division (a row whose opponent could be either is not guessed: it stays
  // unreadable, as every one-row game was before).
  const clubKey = (division, name) => `${text(division)}\u0000${text(name)}`;
  const outsideClubs = new Map();
  const ownTeams = new Set();
  for (const team of teams) {
    const key = clubKey(team?.division, team?.name);
    if (team?.isExternal === true)
      outsideClubs.set(key, [...(outsideClubs.get(key) ?? []), text(team.id)]);
    else ownTeams.add(key);
  }
  const outsideClubOf = (row) => {
    const key = clubKey(row.Division, row.Opponent);
    if (ownTeams.has(key)) return null;
    const ids = outsideClubs.get(key) ?? [];
    return ids.length === 1 ? ids[0] : null;
  };

  const read = readBaselineGames(baseline.rows, weekOfSlot, outsideClubOf);

  /** The team's name now, else the name the baseline printed, else the id. */
  const nameNow = (id, printed) => names.team(id)?.name ?? (printed || names.teamName(id));
  const describePlaced = (start, end, fieldId) => {
    const from = wallOfInstant(start, timeZone);
    const to = wallOfInstant(end, timeZone);
    const place = names.location(fieldId);
    if (from === null || to === null) {
      return ['Date and time cannot be read', place].filter(Boolean).join(', ');
    }
    const day = weekdayOfDate(from.date)?.short ?? '';
    const until = to.date === from.date ? to.time : `${to.date} ${to.time}`;
    return `${day} ${from.date} ${from.time} to ${until}${place ? `, ${place}` : ''}`;
  };
  const describeWaiting = (weekIndex, why, gameDate = null) =>
    `${PUBLICATION_TBD.TIME} (week ${weekIndex}${gameDate ? `, on ${gameDate}` : ''}): ${why}`;

  // ---- placed games: match baseline and saved by the key; whatever has no partner is listed ----
  const savedByKey = new Map();
  const unmatchedSaved = [];
  for (const game of savedGames) {
    const key = gameKey(game);
    if (key === null) unmatchedSaved.push(game);
    else savedByKey.set(key, [...(savedByKey.get(key) ?? []), game]);
  }
  const unchangedKeys = new Set();
  const changed = [];
  const removed = [];
  let unchanged = 0;
  for (const then of read.games) {
    const key = gameKey(then);
    const candidates = key === null ? undefined : savedByKey.get(key);
    const now = candidates?.shift();
    if (now === undefined) {
      removed.push(then);
    } else if (
      sameInstant(then.start, now.start) &&
      sameInstant(then.end, now.end) &&
      idText(then.fieldId) === idText(now.fieldId)
    ) {
      unchanged += 1;
      unchangedKeys.add(key);
    } else {
      changed.push({ then, now });
    }
  }
  const added = [...unmatchedSaved, ...[...savedByKey.values()].flat()];

  // ---- TIME TBD games, then and now ----
  const nowWaiting = new Map();
  for (const game of tbdGames) {
    const key = tbdGameKey(game);
    nowWaiting.set(key ?? `unkeyed-${nowWaiting.size}`, [...(nowWaiting.get(key) ?? []), game]);
  }
  const cleared = [];
  // A game still waiting whose DATE is not the one that was published (given, moved or taken away): the families were
  // told a day, so it is a change to report. Its teams and week are the same, which is how it is known to be the game.
  const dateChanged = [];
  let tbdUnchanged = 0;
  for (const then of read.tbdGames) {
    const key = tbdGameKey(then);
    const match = key === null ? undefined : nowWaiting.get(key)?.shift();
    if (match === undefined) cleared.push(then);
    else if ((then.gameDate ?? null) !== (match.gameDate ?? null))
      dateChanged.push({ then, now: match });
    else tbdUnchanged += 1;
  }
  const tbdNew = [...nowWaiting.values()].flat();

  // ---- why: the Published overrides recorded since the baseline, by the tuple in their before-image ----
  let auditUnkeyed = 0;
  const overrides = new Map();
  for (const row of auditRows) {
    if (row?.action !== 'game.publish_overridden') continue;
    const when = instantMs(row.created_at);
    if (when === null) {
      auditUnkeyed += 1;
      continue;
    }
    if (when < recordedMs) continue;
    const before = row.metadata?.before;
    const key = gameKey({
      homeTeamId: before?.home_team_id,
      awayTeamId: before?.away_team_id,
      slotId: before?.game_slot_id,
      weekIndex: before?.week_index,
    });
    if (key === null) {
      auditUnkeyed += 1;
      continue;
    }
    overrides.set(key, [
      ...(overrides.get(key) ?? []),
      {
        when: text(row.created_at),
        whenMs: when,
        who: text(row.actor_name) || 'Unknown User',
        reasonCode: text(row.metadata?.reason_code),
        reason: reasonLabel(row.metadata?.reason_code),
        note: row.metadata?.note ? text(row.metadata.note) : null,
      },
    ]);
  }
  for (const list of overrides.values()) list.sort((a, b) => b.whenMs - a.whenMs);
  const usedKeys = new Set();
  const whyOf = (key) => {
    if (key === null || !overrides.has(key)) return [];
    usedKeys.add(key);
    return overrides.get(key).map(({ whenMs: _ms, ...entry }) => entry);
  };
  // The on-screen line carries the optional note; the file carries the reason and who and when, and no free text
  // (the note's helper text asks for no personal information, which is a soft control, and a file leaves the app).
  const whyLine = (entry, withNote = true) => {
    const day = wallOfInstant(entry.when, timeZone)?.date ?? entry.when;
    return `${entry.reason}${withNote && entry.note ? `: ${entry.note}` : ''} (${day}, ${entry.who})`;
  };

  // ---- the rows ----
  const rows = [];
  const push = (row) => rows.push({ whyNote: '', sameTeamsNew: [], sameTeamsOld: [], ...row });
  const placedRow = (kind, then, now) => {
    const homeId = then?.homeTeamId ?? now.homeTeamId;
    const awayId = then?.awayTeamId ?? now.awayTeamId;
    const why = whyOf(gameKey(then ?? now));
    const startMs = instantMs(then?.start ?? now.start);
    push({
      kind,
      label: CHANGE_LABEL[kind],
      homeTeamId: text(homeId),
      awayTeamId: text(awayId),
      division: text(names.team(homeId)?.division || then?.division || now?.division),
      home: nameNow(homeId, then?.homeName),
      away: nameNow(awayId, then?.awayName),
      originally: then ? describePlaced(then.start, then.end, then.fieldId) : null,
      now: now ? describePlaced(now.start, now.end, now.fieldId) : null,
      why,
      whyLines: why.map((entry) => whyLine(entry)),
      whyFileLines: why.map((entry) => whyLine(entry, false)),
      sortAt: startMs ?? Number.MAX_SAFE_INTEGER,
    });
  };
  for (const { then, now } of changed) placedRow(CHANGE_KIND.CHANGED, then, now);
  for (const then of removed) placedRow(CHANGE_KIND.REMOVED, then, null);
  for (const now of added) {
    placedRow(CHANGE_KIND.ADDED, null, now);
    const row = rows[rows.length - 1];
    if (row.why.length === 0) {
      row.whyNote = 'A new game: no history is recorded for it yet.';
    }
  }
  const waitingRow = (kind, game, originally, now) =>
    push({
      kind,
      label: CHANGE_LABEL[kind],
      homeTeamId: text(game.homeTeamId),
      awayTeamId: text(game.awayTeamId),
      division: text(names.team(game.homeTeamId)?.division || game.division),
      home: nameNow(game.homeTeamId, game.homeName),
      away: nameNow(game.awayTeamId, game.awayName),
      originally,
      now,
      why: [],
      whyLines: [],
      whyFileLines: [],
      sortAt: Number.MAX_SAFE_INTEGER,
    });
  for (const game of cleared) {
    waitingRow(
      CHANGE_KIND.TBD_CLEARED,
      game,
      describeWaiting(game.weekIndex, game.why, game.gameDate),
      null
    );
  }
  for (const game of tbdNew) {
    waitingRow(
      CHANGE_KIND.TBD_NEW,
      game,
      null,
      describeWaiting(game.weekIndex, describeScheduleTbdReason('game', game.reason), game.gameDate)
    );
  }
  for (const { then, now } of dateChanged) {
    waitingRow(
      CHANGE_KIND.TBD_DATE_CHANGED,
      then,
      describeWaiting(then.weekIndex, then.why, then.gameDate),
      describeWaiting(now.weekIndex, describeScheduleTbdReason('game', now.reason), now.gameDate)
    );
  }

  // The same two teams, shown beside each other: a fact about the rows, never a claim that they are one game.
  const pairKey = (row) => `${idText(row.homeTeamId)}|${idText(row.awayTeamId)}`;
  const newByTeams = new Map();
  const oldByTeams = new Map();
  for (const row of rows) {
    if (row.kind === CHANGE_KIND.ADDED) {
      newByTeams.set(pairKey(row), [...(newByTeams.get(pairKey(row)) ?? []), row.now]);
    }
    if (row.kind === CHANGE_KIND.REMOVED || row.kind === CHANGE_KIND.TBD_CLEARED) {
      oldByTeams.set(pairKey(row), [...(oldByTeams.get(pairKey(row)) ?? []), row.originally]);
    }
  }
  for (const row of rows) {
    if (row.kind === CHANGE_KIND.REMOVED || row.kind === CHANGE_KIND.TBD_CLEARED) {
      row.sameTeamsNew = newByTeams.get(pairKey(row)) ?? [];
    }
    if (row.kind === CHANGE_KIND.ADDED) row.sameTeamsOld = oldByTeams.get(pairKey(row)) ?? [];
  }

  rows.sort(
    (a, b) =>
      a.sortAt - b.sortAt ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.home.localeCompare(b.home) ||
      a.away.localeCompare(b.away)
  );
  const keyed = rows.map((row, index) => ({ ...row, key: `${row.kind}-${index}` }));

  // ---- what the audit holds that no listed game carries ----
  let allowedWithoutChange = 0;
  let auditUnmatched = 0;
  for (const [key, list] of overrides) {
    if (usedKeys.has(key)) continue;
    if (unchangedKeys.has(key)) allowedWithoutChange += list.length;
    else auditUnmatched += list.length;
  }
  const oldest = auditRows.reduce((least, row) => {
    const at = instantMs(row?.created_at);
    return at !== null && (least === null || at < least) ? at : least;
  }, /** @type {number | null} */ (null));
  const auditMayBeCut = auditRows.length >= auditLimit && (oldest === null || oldest >= recordedMs);

  const counts = {
    baselineGames: read.games.length,
    baselineTbd: read.tbdGames.length,
    savedGames: savedGames.length,
    nowTbd: tbdGames.length,
    unchanged,
    changed: changed.length,
    removed: removed.length,
    added: added.length,
    tbdUnchanged,
    tbdDateChanged: dateChanged.length,
    tbdCleared: cleared.length,
    tbdNew: tbdNew.length,
    baselineUnreadable: read.unreadable.length,
    allowedWithoutChange,
    auditUnmatched,
    auditUnkeyed,
  };

  const notes = [];
  if (counts.removed > 0 || counts.added > 0) notes.push(MOVED_NOTE);
  if (counts.baselineUnreadable > 0) {
    notes.push(
      `${counts.baselineUnreadable} game ${counts.baselineUnreadable === 1 ? 'row' : 'rows'} could not be read from the baseline and ${counts.baselineUnreadable === 1 ? 'is' : 'are'} not compared, so a saved game ${counts.baselineUnreadable === 1 ? 'it stands' : 'they stand'} for may be listed as new. This comparison cannot be read as a verdict.`
    );
  }
  if (auditMayBeCut) {
    notes.push(
      `The audit list was cut at ${auditLimit} rows, so the reasons for older changes may be missing.`
    );
  }
  if (counts.allowedWithoutChange > 0) {
    notes.push(
      `Changes were allowed ${counts.allowedWithoutChange} ${counts.allowedWithoutChange === 1 ? 'time' : 'times'} on games that have not changed since publication.`
    );
  }
  if (counts.auditUnmatched > 0) {
    notes.push(
      `${counts.auditUnmatched} audit ${counts.auditUnmatched === 1 ? 'row names' : 'rows name'} a game that is in neither the baseline nor the saved schedule (it was added, then moved or cancelled).`
    );
  }
  if (counts.auditUnkeyed > 0) {
    notes.push(
      `${counts.auditUnkeyed} audit ${counts.auditUnkeyed === 1 ? 'row' : 'rows'} could not be matched to a game (no readable before-image or time).`
    );
  }
  notes.push('This view covers games only: practices are not compared.');

  return {
    baseline: {
      version: baseline.version ?? null,
      label: baseline.label ?? null,
      recordedAt: baseline.recordedAt,
    },
    rows: keyed,
    counts,
    unreadable: read.unreadable,
    notes,
    auditMayBeCut,
    sound: read.unreadable.length === 0,
  };
}

/**
 * The view as CSV, through the export's one cell writer (formula neutralised, RFC 4180 quoting).
 *
 * @param {{ rows: Array<Record<string, any>> }} result
 */
export function changesCsv(result) {
  return formatCsv(
    [...CHANGES_COLUMNS],
    result.rows.map((row) => ({
      Change: row.label,
      Division: row.division,
      Home: row.home,
      Away: row.away,
      Originally:
        row.originally ??
        (row.kind === CHANGE_KIND.ADDED || row.kind === CHANGE_KIND.TBD_NEW
          ? '(not in the baseline)'
          : ''),
      Now:
        row.now ??
        (row.kind === CHANGE_KIND.REMOVED
          ? '(not in the saved schedule)'
          : row.kind === CHANGE_KIND.TBD_CLEARED
            ? '(not on the TIME TBD list)'
            : ''),
      Why: row.whyFileLines.length > 0 ? row.whyFileLines.join('; ') : row.whyNote,
    }))
  );
}
