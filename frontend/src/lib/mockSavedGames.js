/**
 * How the mock answers a read of `game_assignments` that embeds other tables (F11-3 of
 * `docs/changes/2026-11-06-games-table-source-of-truth.md`: every reader of a game reads the saved game).
 *
 * PostgREST resolves an embed through a foreign key, refuses one it cannot resolve, and returns only the columns a
 * select names. A mock that answers anything makes a reader look finished that the database refuses (lessons 104 to
 * 108), so this follows the schema's own facts:
 *
 * - `game_assignments` has TWO foreign keys to `game_slots` (`game_slot_id`, `slot_id`) and TWO to `teams`
 *   (`home_team_id`, `away_team_id`): an embed of either without a column hint is PGRST201, and a hint that names no
 *   such column is PGRST200. `fields` is reached by one key (`field_id`), a slot's `fields` and a field's `locations`
 *   by one each, a team's `divisions` by one.
 * - `game_scores` points AT the game, by a key of four columns that is not a unique key of `game_scores` by itself,
 *   so PostgREST answers that embed as a list: one row for a scored game, none otherwise. `!inner` keeps only the
 *   games that have one.
 * - An embedded row carries the columns its select names and no other; `*` is every column. A table that is not
 *   related, embedded anywhere, is PGRST200.
 *
 * What it does not mirror: a constraint-name hint (names differ between environments, so readers hint by column, as
 * the practice embeds do), embedded-resource filters and orders, and column-level errors for a top-level column that
 * does not exist (`tests/pagedReadOrderColumns.test.js` holds every such read to the real column lists instead).
 */

/** The foreign keys an embed may follow: parent table -> embedded table -> how it is reached. */
const RELATIONS = {
  game_assignments: {
    game_slots: { columns: ['game_slot_id', 'slot_id'] },
    teams: { columns: ['home_team_id', 'away_team_id'] },
    fields: { columns: ['field_id'] },
    game_scores: { reverse: 'game_id' },
  },
  game_slots: { fields: { columns: ['field_id'] } },
  fields: { locations: { columns: ['location_id'] } },
  teams: { divisions: { columns: ['division_id'] } },
};

/** Split a select list at its top-level commas. @param {string} text */
function topLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * A select list as a tree: plain columns, and embeds with their alias, hints and own list.
 *
 * @param {string} select
 * @returns {{ columns: string[], embeds: Array<{ key: string, table: string, hints: string[], inner: boolean,
 *   node: any }> }}
 */
export function parseSelect(select) {
  const node = { columns: [], embeds: [] };
  for (const part of topLevel(String(select ?? ''))) {
    const embed = /^(?:(\w+)\s*:\s*)?(\w+)((?:\s*!\s*\w+)*)\s*\(([\s\S]*)\)$/.exec(part);
    if (!embed) {
      node.columns.push(part.replace(/^(\w+)\s*:\s*/, ''));
      continue;
    }
    const bangs = embed[3]
      .split('!')
      .map((word) => word.trim())
      .filter(Boolean);
    node.embeds.push({
      key: embed[1] || embed[2],
      table: embed[2],
      hints: bangs.filter((word) => word !== 'inner' && word !== 'left'),
      inner: bangs.includes('inner'),
      node: parseSelect(embed[4]),
    });
  }
  return node;
}

/** Whether a select of `game_assignments` embeds anything (a plain read is the mock's generic one). */
export function embedsOfSavedGames(select) {
  return parseSelect(select).embeds.length > 0;
}

const pickColumns = (row, columns) =>
  columns.includes('*')
    ? { ...row }
    : Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));

/**
 * Resolve the embeds of one level. Returns the rows with each embed under its key and a `project` that drops what the
 * select did not name, or the error PostgREST gives.
 */
function resolve(table, rows, node, getTable) {
  let out = rows.map((row) => ({ ...row }));
  /** @type {string[]} */
  const embedKeys = [];
  for (const embed of node.embeds) {
    const relation = RELATIONS[table]?.[embed.table];
    if (!relation) {
      return {
        error: {
          code: 'PGRST200',
          message: `Could not find a relationship between '${table}' and '${embed.table}' in the schema cache`,
        },
      };
    }
    if (relation.reverse) {
      const children = getTable(embed.table);
      for (const row of out) {
        const mine = children.filter((child) => String(child[relation.reverse]) === String(row.id));
        const inner = resolve(embed.table, mine, embed.node, getTable);
        if (inner.error) return inner;
        row[embed.key] = inner.rows.map(inner.project);
      }
      if (embed.inner) out = out.filter((row) => row[embed.key].length > 0);
      embedKeys.push(embed.key);
      continue;
    }
    const hint = embed.hints[0];
    if (relation.columns.length > 1 && !hint) {
      return {
        error: {
          code: 'PGRST201',
          message: `Could not embed because more than one relationship was found for '${table}' and '${embed.table}': hint the column, as in ${embed.table}!${relation.columns[0]}`,
        },
      };
    }
    if (hint && !relation.columns.includes(hint)) {
      return {
        error: {
          code: 'PGRST200',
          message: `Could not find a relationship between '${table}' and '${embed.table}' using the hint '${hint}'`,
        },
      };
    }
    const column = hint || relation.columns[0];
    const parents = getTable(embed.table);
    for (const row of out) {
      const parent = parents.find((candidate) => String(candidate.id) === String(row[column]));
      if (!parent) {
        row[embed.key] = null;
        continue;
      }
      const inner = resolve(embed.table, [parent], embed.node, getTable);
      if (inner.error) return inner;
      row[embed.key] = inner.project(inner.rows[0]);
    }
    if (embed.inner) out = out.filter((row) => row[embed.key] !== null);
    embedKeys.push(embed.key);
  }
  const project = (row) => ({
    ...pickColumns(row, node.columns),
    ...Object.fromEntries(embedKeys.map((key) => [key, row[key]])),
  });
  return { rows: out, project };
}

/**
 * The rows of `game_assignments` with the select's embeds resolved. The rows keep EVERY column of their own until
 * `project` is applied, so the filters and orders that follow the select see the table's columns, as PostgREST's do.
 *
 * @param {string} select
 * @param {any[]} rows
 * @param {(table: string) => any[]} getTable
 * @returns {{ rows: any[], project: (row: any) => any } | { error: { code: string, message: string } }}
 */
export function resolveSavedGameEmbeds(select, rows, getTable) {
  return resolve('game_assignments', rows, parseSelect(select), getTable);
}
