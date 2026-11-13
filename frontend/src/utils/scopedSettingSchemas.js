import { z } from 'zod';
import { isValidScopedValue, SCOPED_SETTING_KEYS } from '@squadlogic/core/scopedSettings.js';

/**
 * What `admin_set_scoped_setting` (migration 20261124010000; plan `docs/changes/2026-11-13-settings-scope.md`) takes,
 * checked in the browser before the call so a mistake is said in words and not as a database code. The database
 * re-checks every one of them: these only fail early.
 *
 * `value: null` is "Inherit" (the level's row is deleted); any other value must be one the key's registry type takes
 * (core's `isValidScopedValue`, the setter's own check).
 */
export const SetScopedSettingSchema = z
  .object({
    key: z
      .string()
      .refine((key) => Object.hasOwn(SCOPED_SETTING_KEYS, key), 'This setting is not one we know.'),
    scope: z.enum(['organization', 'program', 'division']),
    scopeId: z.string().min(1, 'Say which organization, program or division the setting is for.'),
    value: z.unknown(),
  })
  .strict()
  .refine(
    (input) =>
      input.value === null ||
      // an unknown key is the key's own issue above; isValidScopedValue throws on one
      !Object.hasOwn(SCOPED_SETTING_KEYS, input.key) ||
      isValidScopedValue(input.key, input.value),
    {
      message: 'That is not a value this setting takes.',
      path: ['value'],
    }
  );
