/**
 * An independent reading of a schedule, from CSV rows alone: all pairs, no sorting tricks, no
 * import of the product. It is the second opinion `tests/scheduleFixture.test.js` and
 * `tests/scheduleImportAudit.test.js` hold the importer's conflict audit against (plan 4.9: the
 * plants are counted from the CSV, not from the generator and not from the product's report).
 *
 * It is a different algorithm on purpose. `evaluateGameSchedule` sorts a field's games by start and
 * compares neighbours, and reports the first clash per subject; this compares every pair and keeps
 * them all. On a schedule where each clashing subject has one overlapping pair the two agree, and
 * that is what the fixture's plants are built to be.
 */

/** @param {string} hhmm */
export const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** @param {{ start: string, end: string }} a @param {{ start: string, end: string }} b */
export const overlaps = (a, b) =>
  minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);

/**
 * @param {Record<string, string>[]} rows schedule rows
 * @param {Map<string, string[]>} coachesOf own team label -> coach names
 */
export function sweep(rows, coachesOf) {
  const timed = rows.filter((r) => r['Start Time'] !== '' && r['End Time'] !== '');
  const item = (r) => ({
    id: r['Game ID'],
    start: r['Start Time'],
    end: r['End Time'],
  });

  /** same field, same day */
  const byField = new Map();
  for (const r of timed) {
    const key = `${r.Date}|${r.Venue}|${r.Field}`;
    byField.set(key, [...(byField.get(key) ?? []), item(r)]);
  }
  const fieldClashes = [];
  for (const [key, items] of byField) {
    const pairs = [];
    for (let i = 0; i < items.length; i += 1)
      for (let j = i + 1; j < items.length; j += 1)
        if (overlaps(items[i], items[j])) pairs.push([items[i].id, items[j].id]);
    if (pairs.length > 0) fieldClashes.push({ key, pairs });
  }

  /** one own team in two games at once, one coach in two games at once */
  const sides = (r) => [
    { team: r['Home Team'], role: 'home' },
    { team: r['Away Team'], role: 'away' },
  ];
  const byTeam = new Map();
  const byCoach = new Map();
  for (const r of timed) {
    for (const { team, role } of sides(r)) {
      if (!coachesOf.has(team)) continue; // an outside club: not an own team
      const key = `${r.Date}|${team}`;
      byTeam.set(key, [...(byTeam.get(key) ?? []), { ...item(r), role }]);
      for (const coach of coachesOf.get(team)) {
        const ckey = `${r.Date}|${coach}`;
        byCoach.set(ckey, [...(byCoach.get(ckey) ?? []), { ...item(r), role, team }]);
      }
    }
  }
  const clashesIn = (groups) => {
    const found = [];
    for (const [key, items] of groups) {
      const hits = [];
      for (let i = 0; i < items.length; i += 1)
        for (let j = i + 1; j < items.length; j += 1)
          if (items[i].id !== items[j].id && overlaps(items[i], items[j]))
            hits.push([items[i], items[j]]);
      if (hits.length > 0) found.push({ key, hits });
    }
    return found;
  };
  const teamClashes = clashesIn(byTeam);
  const coachClashes = clashesIn(byCoach);

  /** hosting: an own team's home minus away games over the games with a time */
  const load = new Map();
  for (const r of timed)
    for (const { team, role } of sides(r)) {
      if (!coachesOf.has(team)) continue;
      const tally = load.get(team) ?? { home: 0, away: 0 };
      tally[role] += 1;
      load.set(team, tally);
    }
  const imbalanced = [...load].filter(([, t]) => Math.abs(t.home - t.away) > 1).map(([n]) => n);

  return {
    examined: {
      games: timed.length,
      fieldDays: byField.size,
      teamDays: byTeam.size,
      coachDays: byCoach.size,
      teamsWithGames: load.size,
    },
    fieldClashes,
    teamClashes,
    coachClashes,
    imbalanced,
  };
}

/** @param {Record<string, string>[]} teamRows */
export function coachMap(teamRows) {
  return new Map(
    teamRows.map((t) => [
      t.Team,
      [t['Coach 1'], t['Coach 2'], t['Coach 3']].filter((c) => c !== ''),
    ])
  );
}
