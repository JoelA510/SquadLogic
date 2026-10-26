import { z } from 'zod';

/**
 * What the four program writers of migration 20261101020000 take (Phase E2), checked in the browser
 * before the call so a mistake is said in words and not as a database code. The database re-checks
 * every one of them: these only fail early.
 */

const Id = (what) => z.string().min(1, `${what} is required`);

/** A program's name: 1 to 80 characters once trimmed, as the table's CHECK holds it. */
export const ProgramNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'Give the program a name.')
      .max(80, 'A program name can be at most 80 characters.')
  );

export const CreateProgramSchema = z
  .object({ seasonId: Id('a season'), name: ProgramNameSchema })
  .strict();

export const RenameProgramSchema = z
  .object({ seasonId: Id('a season'), programId: Id('a program'), name: ProgramNameSchema })
  .strict();

export const DeleteProgramSchema = z.object({ programId: Id('a program') }).strict();

export const MergeProgramsSchema = z
  .object({ sourceId: Id('a program to merge'), targetId: Id('a program to merge into') })
  .strict()
  .refine((value) => value.sourceId !== value.targetId, {
    message: 'A program cannot be merged into itself.',
    path: ['targetId'],
  });

/** `programId: null` removes the division from its program (it goes to "No program"). */
export const SetDivisionProgramSchema = z
  .object({ divisionId: Id('a division'), programId: Id('a program').nullable() })
  .strict();
