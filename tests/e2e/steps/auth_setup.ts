import { createBdd } from 'playwright-bdd';
import { expect, Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const { Given, After } = createBdd();

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const isMockMode = !supabaseUrl || !supabaseKey || process.env.VITE_USE_MOCK_SUPABASE === 'true';

async function setupIsolatedTenant(page: Page, role: string = 'admin') {
  // In mock mode, use 'org-1' to align with pre-seeded initialMockData.
  // Random UUIDs cause org ID fragmentation — hooks filter by active org and find nothing.
  const dynamicOrgId = isMockMode ? 'org-1' : randomUUID();
  const _email =
    role === 'coach'
      ? 'coach@squadlogic.app'
      : role === 'parent'
        ? 'parent@squadlogic.app'
        : 'admin@squadlogic.app';
  const userId = `mock-${role}-id`;

  if (!supabaseUrl || !supabaseKey || process.env.VITE_USE_MOCK_SUPABASE === 'true') {
    console.warn(
      'Skipping isolated tenant setup due to missing Supabase credentials or mock mode.'
    );

    // CRITICAL FIX: Fully seed the mock DB so the app doesn't get stuck on "Loading League Data"
    await page.evaluate(
      ({ orgId, roleName, uId }) => {
        localStorage.setItem('squadlogic_active_org', orgId);
        localStorage.setItem('squadlogic-current-season', 'Fall 2026');

        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');

        db.organizations = db.organizations || [];
        if (
          !db.organizations.find((o: Record<string, unknown>) => (o as { id: string }).id === orgId)
        ) {
          db.organizations.push({
            id: orgId,
            name: `E2E-Isolation-${orgId}`,
            status: 'active',
            is_onboarded: true,
          });
        }

        db.organization_members = db.organization_members || [];
        if (
          !db.organization_members.find(
            (m: Record<string, unknown>) => m.organization_id === orgId && m.profile_id === uId
          )
        ) {
          db.organization_members.push({
            organization_id: orgId,
            profile_id: uId,
            role: roleName,
            organizations: { id: orgId, name: `E2E-Isolation-${orgId}`, is_onboarded: true },
          });
        }

        db.season_settings = db.season_settings || [];
        let activeSeason = db.season_settings.find(
          (s: Record<string, unknown>) => s.organization_id === orgId && s.id === 'season-1'
        );
        if (!activeSeason) {
          activeSeason = db.season_settings.find(
            (s: Record<string, unknown>) =>
              s.organization_id === orgId && (s.name === 'Fall 2026' || s.id === 's1')
          );
        }
        if (activeSeason) {
          Object.assign(activeSeason, {
            id: 'season-1',
            organization_id: orgId,
            name: 'Fall 2026',
            status: 'active',
            // A season with no timezone has no clock to place a slot on and
            // the grid refuses rather than guessing (GAP-30), so the seed has
            // to carry one exactly as a real season does.
            timezone: (activeSeason.timezone as string) || 'America/Los_Angeles',
            created_at: activeSeason.created_at || new Date().toISOString(),
          });
        } else {
          db.season_settings.push({
            id: 'season-1',
            organization_id: orgId,
            name: 'Fall 2026',
            status: 'active',
        timezone: 'America/Los_Angeles',
            created_at: new Date().toISOString(),
          });
        }

        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { orgId: dynamicOrgId, roleName: role === 'parent' ? 'parent' : role, uId: userId }
    );
    return;
  }

  // Insert the isolated tenant for real DB
  await supabase.from('organizations').insert({
    id: dynamicOrgId,
    name: `E2E-Isolation-${dynamicOrgId}`,
  });

  await page.evaluate((orgId: string) => {
    localStorage.setItem('squadlogic_active_org', orgId);
  }, dynamicOrgId);
}

Given(
  /I am logged into (?:the )?SquadLogic(?: dashboard)? as (?:an? )?"?([^"]*)"?/,
  async ({ page }, role: string) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('[DEBUG]')) {
        console.log(`[BROWSER LOG] [${msg.type()}] ${msg.text()}`);
      }
    });

    const roleMap: Record<string, string> = {
      admin: process.env.TEST_ADMIN_EMAIL || 'admin@squadlogic.app',
      coach: process.env.TEST_COACH_EMAIL || 'coach@squadlogic.app',
      parent: process.env.TEST_PARENT_EMAIL || 'parent@squadlogic.app',
      player: process.env.TEST_PLAYER_EMAIL || 'player@squadlogic.app',
    };

    // Robust role parsing to handle names like "Coach Alice"
    const rawRole = role.toLowerCase();
    let cleanRole = 'admin';
    if (rawRole.includes('coach')) cleanRole = 'coach';
    else if (rawRole.includes('parent')) cleanRole = 'parent';
    else if (rawRole.includes('player')) cleanRole = 'player';

    const email = roleMap[cleanRole] || roleMap.admin;
    const password = process.env.TEST_PASSWORD || 'test-password-123';

    console.log(`[AUTH DEBUG] Attempting Mock Login for ${email}`);
    console.log(
      `[DEBUG][auth_setup] rawRole="${role}", cleanRole="${cleanRole}", email="${email}"`
    );

    // CRITICAL FIX: Bypass UI login in mock mode and respect pre-seeded RBAC users
    if (isMockMode) {
      await page.goto('/');

      const isPreSeeded = await page.evaluate(
        ({ emailStr, roleName, defaultUid, rawRoleName }) => {
          sessionStorage.removeItem('__MOCK_SESSION__');

          const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
          const profiles = db.profiles || [];

          // Check if this specific user was pre-seeded (e.g., "Coach Alice")
          const seededUser = profiles.find(
            (p: Record<string, unknown>) => p.full_name === rawRoleName
          );

          if (seededUser) {
            // User is pre-seeded. Find their assigned organization.
            const members = db.organization_members || [];
            const membership = members.find(
              (m: Record<string, unknown>) => m.profile_id === seededUser.id
            );
            const orgId = membership ? (membership.organization_id as string) : null;

            if (orgId) {
              localStorage.setItem('squadlogic_active_org', orgId);
            }

            const session = {
              user: {
                id: seededUser.id,
                email: seededUser.email || emailStr,
                user_metadata: { full_name: seededUser.full_name },
                app_metadata: { role: membership ? membership.role : roleName },
              },
              access_token: 'mock-token',
            };
            sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify(session));
            return true; // Flag that we handled a seeded user
          }

          // Fallback for generic users
          localStorage.removeItem('squadlogic_active_org');
          const session = {
            user: {
              id: defaultUid,
              email: emailStr,
              user_metadata: { full_name: `Mock ${roleName}` },
              app_metadata: { role: roleName },
            },
            access_token: 'mock-token',
          };
          sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify(session));
          return false;
        },
        {
          emailStr: email,
          roleName: cleanRole,
          defaultUid: `mock-${cleanRole}-id`,
          rawRoleName: role,
        }
      );

      // Only setup a generic isolated tenant if the user was NOT pre-seeded by a Background step
      if (!isPreSeeded) {
        await setupIsolatedTenant(page, cleanRole);
      } else {
        console.log(
          `[DEBUG][auth_setup] Recognized pre-seeded user "${role}", preserving existing tenant context.`
        );
      }

      await page.reload();
      await expect(
        page
          .getByRole('heading', {
            name: /Welcome to SquadLogic|Welcome back|My Dashboard|League Management|Dashboard|Season Setup Workflow|Team Portal|League Standings|Settings/i,
          })
          .first()
      ).toBeVisible({ timeout: 15000 });
      return;
    }

    // Real DB Login Flow
    await page.goto('/login');
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
    await page.reload();

    await expect(page.getByRole('heading', { name: /Sign in|Create an account/i })).toBeVisible({
      timeout: 15000,
    });
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(
      page
        .getByRole('heading', { name: /League Management|Dashboard|Season Setup Workflow/i })
        .first()
    ).toBeVisible({ timeout: 30000 });

    await setupIsolatedTenant(page, cleanRole);
  }
);

Given('I am logged into SquadLogic', async ({ page }) => {
  // Fallback to admin
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@squadlogic.app');
  await page.getByLabel('Password').fill('test-password-123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(
    page
      .getByRole('heading', { name: /League Management|Dashboard|Season Setup Workflow/i })
      .first()
  ).toBeVisible({ timeout: 20000 });

  await setupIsolatedTenant(page, 'admin');
});

After(async ({ page }) => {
  if (!supabaseUrl || !supabaseKey || process.env.VITE_USE_MOCK_SUPABASE === 'true') return;

  try {
    const activeOrgId = await page.evaluate(() => localStorage.getItem('squadlogic_active_org'));

    if (activeOrgId) {
      console.log(`[Teardown] Purging isolated tenant: ${activeOrgId}`);
      await supabase.from('organizations').delete().eq('id', activeOrgId);
    }
  } catch (error) {
    console.error('[Teardown] Failed to purge isolated tenant:', error);
  }
});
