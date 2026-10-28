import { z } from 'zod';

/**
 * What the four season writers of migration 20261109010000 take (Phase E3b), checked in the browser
 * before the call so a mistake is said in words and not as a database code. The database re-checks
 * every one of them: these only fail early.
 */

const Id = (what) => z.string().min(1, `${what} is required`);

/** A season's name: 1 to 80 characters once trimmed. */
export const SeasonNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'Give the season a name.')
      .max(80, 'A season name can be at most 80 characters.')
  );

/** The year the season starts. */
export const SeasonYearSchema = z.coerce
  .number({ message: 'Enter the year the season starts.' })
  .int('Enter the year the season starts.')
  .min(2000, 'The season year must be between 2000 and 2100.')
  .max(2100, 'The season year must be between 2000 and 2100.');

/** A calendar date as `<input type="date">` gives it, or nothing. */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.')
  .nullable();

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

const datesInOrder = (value) => !value.start || !value.end || value.end >= value.start;

export const CreateSeasonFromSchema = z
  .object({
    sourceId: Id('a season to start from'),
    name: SeasonNameSchema,
    year: SeasonYearSchema,
    start: z.preprocess(emptyToNull, IsoDate),
    end: z.preprocess(emptyToNull, IsoDate),
  })
  .strict()
  .refine(datesInOrder, { message: 'The season cannot end before it starts.', path: ['end'] });

export const CUTOFF_MODES = Object.freeze({
  SCHOOL_YEAR: 'school_year_aug_jul',
  CALENDAR_YEAR: 'birth_year',
  CUSTOM: 'custom',
});

const LONGEST_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The age cutoff of a draft: a preset, or a custom day of the year. */
export const CutoffSchema = z
  .object({
    mode: z.enum([CUTOFF_MODES.SCHOOL_YEAR, CUTOFF_MODES.CALENDAR_YEAR, CUTOFF_MODES.CUSTOM]),
    month: z.coerce.number().int().min(1).max(12).nullable().optional(),
    day: z.coerce.number().int().min(1).max(31).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== CUTOFF_MODES.CUSTOM) return;
    if (!value.month || !value.day) {
      ctx.addIssue({ code: 'custom', message: 'Pick the month and day of the cutoff.' });
    } else if (value.day > LONGEST_MONTH[value.month - 1]) {
      ctx.addIssue({ code: 'custom', message: 'That month does not have that many days.' });
    }
  });

/** The patch `admin_update_draft_season` takes: only the keys named are changed. */
export const SeasonPatchSchema = z
  .object({
    name: SeasonNameSchema.optional(),
    season_start: IsoDate.optional(),
    season_end: IsoDate.optional(),
    season_year: SeasonYearSchema.optional(),
    age_cutoff_mode: z
      .enum([CUTOFF_MODES.SCHOOL_YEAR, CUTOFF_MODES.CALENDAR_YEAR, CUTOFF_MODES.CUSTOM])
      .optional(),
    age_cutoff_month: z.number().int().min(1).max(12).nullable().optional(),
    age_cutoff_day: z.number().int().min(1).max(31).nullable().optional(),
  })
  .strict();

export const UpdateSeasonSchema = z
  .object({ seasonId: Id('a season'), patch: SeasonPatchSchema })
  .strict();

/** Both ends or neither (clearing the window); the end not before the start. */
export const DivisionWindowSchema = z
  .object({
    divisionId: Id('a division'),
    start: z.preprocess(emptyToNull, IsoDate),
    end: z.preprocess(emptyToNull, IsoDate),
  })
  .strict()
  .refine((value) => (value.start === null) === (value.end === null), {
    message: 'Give both dates of the window, or neither to clear it.',
    path: ['end'],
  })
  .refine(datesInOrder, { message: 'The window cannot end before it starts.', path: ['end'] });

export const ActivateSeasonSchema = z.object({ seasonId: Id('a season') }).strict();
