import { useOrganization } from '../contexts/OrganizationContext.jsx';

/**
 * True while the season shown is completed (Phase E3b): its people, teams and schedules are
 * history, and the database refuses a signed-in caller's write to them
 * (`season_schedule_readonly_when_completed`, 22023 `season_completed`). The scheduling pages turn
 * their generate, apply and save actions off with it rather than let the database say no.
 *
 * @returns {boolean}
 */
export function useSeasonReadOnly() {
  const { currentSeasonSetting } = useOrganization();
  return currentSeasonSetting?.status === 'completed';
}
