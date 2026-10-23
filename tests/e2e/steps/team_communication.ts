import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, Then } = createBdd();

/*
 * The team portal's shared steps. Availability marking (RSVP) and team chat
 * were removed (20261022030000; plan docs/changes/2026-10-22-admin-focus.md,
 * R2), and their feature and steps with them; what is left seeds a team and
 * opens its page, and checks the page as a coach sees it.
 */

// --- Existing Steps ---

Given(
  'my child {string} is on the {string} team',
  async ({ page }, childName: string, teamName: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ child, team, mockOrgId }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const teamId = team.toLowerCase().replace(/\s+/g, '-');
        const playerId = `player-${child.toLowerCase()}`;

        db.teams = db.teams || [];
        // CRITICAL FIX: Aggressively clear previous state to prevent cross-worker contamination
        db.teams =
          db.teams?.filter((t: Record<string, unknown>) => t.organization_id !== orgId) || [];
        db.teams.push({
          id: teamId,
          name: team,
          organization_id: orgId,
          // The portal places a team's practices on its division's season clock.
          division_id: 'u8-div-id',
        });
        // The team's calendar feed token lives in its own table (20261021020000).
        db.team_calendar_tokens = (db.team_calendar_tokens || []).filter(
          (row: Record<string, unknown>) => row.team_id !== teamId
        );
        db.team_calendar_tokens.push({
          team_id: teamId,
          token: `mock-calendar-token-${teamId}`,
          expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
        });

        db.players = db.players || [];
        // CRITICAL FIX: Remove existing player to prevent duplicate keys
        db.players = db.players.filter((p: Record<string, unknown>) => p.id !== playerId);
        db.players.push({
          id: playerId,
          first_name: child,
          last_name: 'Test',
          organization_id: orgId,
        });

        db.team_players = db.team_players || [];
        db.team_players = db.team_players.filter(
          (tp: Record<string, unknown>) => tp.player_id !== playerId
        );
        db.team_players.push({ team_id: teamId, player_id: playerId });

        db.profile_players = db.profile_players || [];
        db.profile_players = db.profile_players.filter(
          (pp: Record<string, unknown>) => pp.player_id !== playerId
        );
        db.profile_players.push({ profile_id: 'mock-parent-id', player_id: playerId });

        localStorage.setItem('test_target_team_id', teamId);
        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { child: childName, team: teamName, mockOrgId: MOCK_ORG_ID }
    );
  }
);

Given(
  'I am on the {string} page for the {string}',
  async ({ page }, pageName: string, teamName: string) => {
    const teamId =
      (await page.evaluate(() => localStorage.getItem('test_target_team_id'))) ||
      teamName.toLowerCase().replace(/\s+/g, '-');
    await page.goto(`/team/${teamId}`);
    await expect(page.getByRole('heading', { name: teamName }).first()).toBeVisible({
      timeout: 15000,
    });
  }
);

/*
 * R2: the team page for its coach. One Tuesday series on the coach's team (the
 * team the Pillar 2 background assigns), seeded with `organization_id` on
 * every row (AGENTS.md section 8, rule 1). Synthetic names; DOM assertions only.
 */
Given('my team has a practice series on Tuesdays', async ({ page }) => {
  await waitForMockClient(page);
  await page.evaluate(
    ({ mockOrgId }) => {
      const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      const teamId = localStorage.getItem('test_target_team_id') || 'team-1';
      db.practice_slots = (db.practice_slots || []).filter(
        (s: Record<string, unknown>) => s.id !== 'slot-e2e-coach-tue'
      );
      db.practice_slots.push({
        id: 'slot-e2e-coach-tue',
        organization_id: orgId,
        day_of_week: 'tue',
        start_time: '17:00',
        end_time: '18:30',
      });
      db.practice_assignments = (db.practice_assignments || []).filter(
        (a: Record<string, unknown>) => a.team_id !== teamId
      );
      db.practice_assignments.push({
        id: 'pa-e2e-coach-tue',
        organization_id: orgId,
        team_id: teamId,
        practice_slot_id: 'slot-e2e-coach-tue',
        effective_date_range: '[2026-11-03,2026-11-25)',
      });
      db.practice_exceptions = (db.practice_exceptions || []).filter(
        (e: Record<string, unknown>) => e.team_id !== teamId
      );
      window.__saveMockDB__(db);
    },
    { mockOrgId: MOCK_ORG_ID }
  );
});

Then('I should see the Tuesday practices on the team schedule', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Team Schedule' })).toBeVisible({
    timeout: 15000,
  });
  // 2026-11-03, -10, -17 and -24: four Tuesdays in the seeded range.
  await expect(page.getByRole('heading', { level: 3, name: 'Practice', exact: true })).toHaveCount(
    4,
    { timeout: 15000 }
  );
  await expect(page.getByText('17:00 - 18:30').first()).toBeVisible();
});

Then('I should see no RSVP controls and no team chat', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Team Chat/i })).toHaveCount(0);
  await expect(page.getByPlaceholder(/Type a message/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Send team message/i })).toHaveCount(0);
  for (const label of ['Going', 'Not Going', 'Maybe']) {
    await expect(page.getByTitle(label, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(/RSVP/)).toHaveCount(0);
});
