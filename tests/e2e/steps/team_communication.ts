import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

Given('I need to announce a practice cancellation', async ({ page: _page }) => {
  // Context step, no action needed
});

When('I use the Team Communication tool', async ({ page }) => {
  // CRITICAL FIX: Navigate to the team portal first
  const teamId = await page.evaluate(() => localStorage.getItem('test_target_team_id') || 'team-1');
  await page.goto(`/team/${teamId}`);
  await expect(page.getByRole('heading', { name: /Team Chat/i }).first()).toBeVisible({
    timeout: 15000,
  });
});

Then('a notification should be sent to all parents of players on my roster', async ({ page }) => {
  const message = 'Practice is cancelled today due to rain.';
  const chatForm = page.locator('form').filter({ has: page.getByPlaceholder(/Type a message/i) });
  const input = chatForm.getByPlaceholder(/Type a message/i).first();
  const sendButton = chatForm.getByRole('button', { name: /Send team message/i }).first();

  await expect(sendButton).toBeVisible({ timeout: 10000 });
  await input.fill(message);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.getByText(message).first()).toBeVisible({ timeout: 15000 });
});

Then('I should be able to see a history of all sent messages', async ({ page }) => {
  await expect(page.getByText('Practice is cancelled today due to rain.').first()).toBeVisible();
});

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
          calendar_token: `mock-calendar-token-${teamId}`,
          calendar_token_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
        });

        db.team_messages =
          db.team_messages?.filter((m: Record<string, unknown>) => m.organization_id !== orgId) ||
          [];
        db.event_rsvps =
          db.event_rsvps?.filter((r: Record<string, unknown>) => r.organization_id !== orgId) || [];

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
  'my child {string} is also on the {string} team',
  async ({ page }, childName: string, teamName: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ child, team, mockOrgId }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const teamId = team.toLowerCase().replace(/\s+/g, '-');
        const playerId = `player-${child.toLowerCase()}`;

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

Given('there is an upcoming practice on {string}', async ({ page }, day: string) => {
  await waitForMockClient(page);
  await page.evaluate((d) => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.practice_assignments = db.practice_assignments || [];
    db.practice_slots = db.practice_slots || [];

    const slotId = `slot-${d.toLowerCase()}`;
    if (!db.practice_slots.find((s: Record<string, unknown>) => s.id === slotId)) {
      db.practice_slots.push({
        id: slotId,
        day_of_week: d.substring(0, 3).toLowerCase(),
        start_time: '17:00',
        end_time: '18:30',
      });
    }

    if (
      !db.practice_assignments.find((pa: Record<string, unknown>) => pa.practice_slot_id === slotId)
    ) {
      db.practice_assignments.push({
        id: `pa-${d.toLowerCase()}`,
        team_id: 'tigers',
        practice_slot_id: slotId,
        effective_date_range: '[2025-01-01,2025-12-31)',
        // CRITICAL FIX: Inject the 'slot' alias directly so useTeamPortal's expandPractices can read it
        slot: {
          day_of_week: d.substring(0, 3).toLowerCase(),
          start_time: '17:00',
          end_time: '18:30',
          field: { name: 'Main Field', location: { name: 'Complex' } },
        },
      });
    }
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  }, day);
  await page.reload();
  await expect(page.getByText(day, { exact: false }).first()).toBeVisible({ timeout: 10000 });
});

When(
  'I click {string} for {string} on the {string} practice',
  async ({ page }, action: string, child: string, day: string) => {
    const practiceCard = page
      .locator('.glass-panel')
      .filter({ hasText: new RegExp(day, 'i') })
      .filter({ hasText: /practice/i })
      .first();
    const playerRsvpRow = practiceCard
      .locator('.bg-bg-surface\\/30')
      .filter({ hasText: new RegExp(child, 'i') })
      .first();

    const titleMap: Record<string, string> = {
      Going: 'Going',
      'Not Going': 'Not Going',
      Maybe: 'Maybe',
    };

    const btn = playerRsvpRow.getByTitle(titleMap[action] || action, { exact: true }).first();
    await expect(btn).toBeVisible({ timeout: 10000 });
    await expect(btn).toBeEnabled({ timeout: 10000 });
    await btn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await btn.click();
    const isActive = async () => (await btn.getAttribute('class'))?.includes('scale-105') ?? false;
    if (!(await isActive())) {
      await expect(btn).toBeEnabled({ timeout: 10000 });
      await btn.click();
    }
    await expect(btn).toHaveClass(/scale-105/, { timeout: 10000 });

    // CRITICAL FIX: Allow the mock Supabase client and React state to settle
    // before proceeding to the next click, preventing read-modify-write race conditions.
    await page.waitForTimeout(500);
  }
);

/** The RSVP row of `child` on the `day` practice card. */
const rsvpRowOf = (page: Page, day: string, child: string) =>
  page
    .locator('.glass-panel')
    .filter({ hasText: new RegExp(day, 'i') })
    .filter({ hasText: /practice/i })
    .first()
    .locator('.bg-bg-surface\\/30')
    .filter({ hasText: new RegExp(child, 'i') })
    .first();

Then(
  'I should see {string} marked as {string} on the {string} practice',
  async ({ page }, child: string, action: string, day: string) => {
    const practiceCard = page
      .locator('.glass-panel')
      .filter({ hasText: new RegExp(day, 'i') })
      .filter({ hasText: /practice/i })
      .first();
    const playerRsvpRow = practiceCard
      .locator('.bg-bg-surface\\/30')
      .filter({ hasText: new RegExp(child, 'i') })
      .first();
    const button = playerRsvpRow.getByTitle(action, { exact: true }).first();

    // Check that it does NOT have grayscale (meaning it is active)
    await expect(button).not.toHaveClass(/grayscale/, { timeout: 10000 });
    await expect(button).toHaveClass(/scale-105/, { timeout: 10000 });
  }
);

Then(
  'after a reload {string} is still {string} and {string} still {string} on the {string} practice',
  async (
    { page },
    first: string,
    firstAction: string,
    second: string,
    secondAction: string,
    day: string
  ) => {
    // Two children, two different answers on one occurrence: both survive a reload only if each
    // was stored as its own record (one shared record would come back with one answer).
    await page.reload();
    for (const [child, action] of [
      [first, firstAction],
      [second, secondAction],
    ]) {
      const row = rsvpRowOf(page, day, child);
      await expect(row.getByTitle(action, { exact: true }).first()).toHaveClass(/scale-105/, {
        timeout: 15000,
      });
      for (const other of ['Going', 'Not Going', 'Maybe'].filter((a) => a !== action)) {
        await expect(row.getByTitle(other, { exact: true }).first()).not.toHaveClass(/scale-105/);
      }
    }
  }
);

When('I type {string} into the chat input', async ({ page }, msg: string) => {
  const input = page.getByPlaceholder('Type a message...').first();
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(msg);
});

When('I send the messenger chat', async ({ page }) => {
  const chatForm = page.locator('form').filter({ has: page.getByPlaceholder('Type a message...') });
  const input = chatForm.getByPlaceholder('Type a message...').first();
  const message = await input.inputValue();
  const sendButton = chatForm.getByRole('button', { name: /Send team message/i }).first();

  await expect(sendButton).toBeVisible({ timeout: 10000 });
  await sendButton.click();
  await expect(input).toHaveValue('', { timeout: 10000 });
  await expect
    .poll(
      async () =>
        page.evaluate((expectedMessage) => {
          const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
          return (db.team_messages || []).some(
            (entry: Record<string, unknown>) => entry.content === expectedMessage
          );
        }, message),
      { timeout: 10000 }
    )
    .toBe(true);
});

Then(
  'the message {string} should appear in the team chat feed immediately',
  async ({ page }, msg: string) => {
    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 15000 });
  }
);

Then(
  'the message {string} should still be in the team chat feed after a reload',
  async ({ page }, msg: string) => {
    // Read back from where the page stored it, not from the component state that showed it.
    await page.reload();
    await expect(page.getByText(msg, { exact: true }).first()).toBeVisible({ timeout: 15000 });
  }
);
