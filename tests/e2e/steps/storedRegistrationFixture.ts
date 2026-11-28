import type { Page } from '@playwright/test';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/** Populate the season records that a completed registration import leaves behind.
 * Used by the teaming scenarios that seed a specific registration file instead of uploading it. */
export async function storeFixtureRegistrations(page: Page, importId: string) {
  await page.evaluate(
    ({ importId, defaultOrg }) => {
      type Row = Record<string, unknown>;
      const db = window.__MOCK_DB__ as Record<string, Row[]> & {
        __deleted__?: Record<string, string[]>;
      };
      const org = localStorage.getItem('squadlogic_active_org') || defaultOrg;
      const season = db.season_settings.find(
        (s) => s.organization_id === org && s.status === 'active'
      );
      const file = db.imports.find(
        (entry) => entry.id === importId && entry.organization_id === org
      );
      const rows = (file?.data as { data?: Row[] } | undefined)?.data;
      if (!season || !rows?.length)
        throw new Error('Missing registration fixture or active season');
      const inSeason = (row: Row) =>
        row.organization_id === org && row.season_settings_id === season.id;
      const players = rows.map((row) => {
        let division = db.divisions.find((d) => inSeason(d) && d.name === row.division);
        if (!division) {
          division = {
            id: crypto.randomUUID(),
            organization_id: org,
            season_settings_id: season.id,
            name: row.division,
            practices_per_week: 1,
          };
          db.divisions.push(division);
        }
        return {
          id: row.id,
          external_registration_id: row.id,
          organization_id: org,
          season_settings_id: season.id,
          division_id: division.id,
          first_name: row['First Name'],
          last_name: row['Last Name'],
          gender: row.Gender,
          status: row.waitlist === 'yes' ? 'waitlist' : 'active',
          rating: row['Skill Rating'],
          natural_age:
            row.natural_age ??
            (typeof season.season_year === 'number' && typeof row.Birthdate === 'string'
              ? season.season_year - Number(row.Birthdate.slice(0, 4))
              : null),
          play_up_requested: row['Play Up'] === 'Yes',
        };
      });
      // The mock rebuilds its built-in players after each navigation unless their
      // deletions are recorded. The active season in this fixture contains exactly the file.
      const replaced = db.players.filter(inSeason).map((p) => String(p.id));
      db.__deleted__ ??= {};
      db.__deleted__.players = [...new Set([...(db.__deleted__.players ?? []), ...replaced])];
      db.players = [...db.players.filter((p) => !inSeason(p)), ...players];
      window.__saveMockDB__(db);
    },
    { importId, defaultOrg: MOCK_ORG_ID }
  );
}
