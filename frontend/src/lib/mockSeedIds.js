/**
 * The mock seed's organization and season ids, defined once for the mock
 * client (`mockSupabaseClient.js`) and the tests that run against its seed
 * (Vitest and the mock E2E steps).
 *
 * **They are UUIDs because production ids are.** They were `org-1` and
 * `season-1`, and core's `SlotSchema` (`organization_id`) and the
 * auto-scheduler's request schema (`organizationId`, `seasonSettingsId`)
 * refuse anything that is not a UUID, so in mock mode every game slot was
 * refused and Generate Schedule never succeeded. Each is a valid version-4
 * UUID under zod 4's strict check (version nibble `4`, variant `8`), which is
 * the stricter of the two zods that read them.
 *
 * Readable on sight: `5eed` is the mock seed; `5ea5` marks the season.
 */
export const MOCK_ORG_ID = '5eed0000-0000-4000-8000-000000000001';
export const MOCK_SEASON_ID = '5eed5ea5-0000-4000-8000-000000000001';
