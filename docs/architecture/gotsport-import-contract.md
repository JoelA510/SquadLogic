## [← Back to Documentation Index](../README.md)

# GotSport Import Contract

SquadLogic stores **only** the registration data it uses for teaming and
scheduling. A player or coach import keeps a column only when it is on that
import type's **allowlist**; everything else in the export is dropped before
it is staged, and the finalizers drop it again. GotSport remains the system of
record for guardians and their contact details, addresses, waivers, medical
and emergency details, insurance, payments and financial aid (owner decisions
2026-10-22, `docs/product.md` "Constraints"; plan
`docs/changes/2026-10-22-admin-focus.md`, R0).

## Why an allowlist

The export's columns are whatever the league's registration platform was set
up with, and SquadLogic does not control them. Until R0 the import dropped a
denylist of sensitive columns and stored every other unmapped column in
`custom_attributes`, so the coach export's guardian addresses, phones and
emails, the child's name and birth date and the coach's own birth date were
stored on every coach. A denylist cannot keep up with an export nobody here
controls; an allowlist can.

The evaluations import (below) is filtered the same way, against its own short list and with no
declared fields.

A column is kept when its **canonical key** (the header after the import's
header normalization: lower-cased and trimmed, then the alias map in
`import-validation`) is:

1. a key the finalizer for that import type reads, less every guardian,
   parent, contact, email, phone and payment key for players and the phone key
   for coaches (the coach's email is the import's key and an admin's contact; no coach signs in);
2. for players, a team-placement column: `team name`, `team age`,
   `team gender` (kept for Phase B, which keeps teams formed outside
   SquadLogic); or
3. a field the organization declared for that entity in Settings (fluid
   schemas, `organization_schemas`), matched by its field identity (lower case,
   whitespace as `_`: a `Jersey Size` column matches a declared `jersey_size`).

It is applied at every entry: in the browser before upload
(`frontend/src/utils/importAllowlist.js`; the import reads the organization's
declared fields when it starts and fails with a message if it cannot), in `import-validation` before it
stages a row or returns `validated_data` (`supabase/functions/_shared/import-allowlist.ts`,
after the sensitive-column filter, which stays), in the mock client, and in SQL:
`finalize_import_job` and `finalize_coach_import_job` read only allowlisted keys
and build `custom_attributes` from the declared fields
(`import_declared_attributes`, migration `20261022010000`), because the staging
tables can be written without the Edge Function. `tests/importAllowlistParity.test.js`
holds the two code copies equal and holds each list equal to the keys the latest
SQL readers of the staged payload read, so a finalizer that starts reading a new
key fails until the key is allowlisted on purpose.

**A declared field whose header is also a global alias.** The alias map turns
some headers into system keys (`Skill` becomes `skill_tier`). A column is kept
when its own identity is a declared field too, and then both readings are
made: the system field reads the canonical key as it always did (a player's
`skill_tier`), and the declared field gets a copy under its identity
(`skill`), which the finalizers store in `custom_attributes`. The copy never
replaces a non-blank value already under that key, so it cannot displace
another column's reading; the canonical key stays only when the import type
keeps it (`skill_tier` stays for players and goes for coaches). With nothing
declared, the header is judged by its canonical key alone, as before.

**A declared date** is stored as `YYYY-MM-DD` and must be a real calendar
date written exactly so: the custom-attributes trigger refuses
`2025-02-03junk` and `2025-02-30`, and the import drops such a value rather
than storing it.

## Player import — kept fields

| Canonical key(s)                                                                                                                                           | Stored as                                                  | Used for                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| `external_registration_id`, `gotsport_id`, `registration_id`, `player_id`                                                                                  | `external_registration_id`                                 | Dedupe, re-import, buddy matching         |
| `first_name`, `last_name`, `preferred_name`, `nickname`                                                                                                    | `first_name`, `last_name`, `preferred_name`                | Roster identity                           |
| `date_of_birth`, `dob`                                                                                                                                     | nothing: read at import for `natural_age`, never staged    | Age band + play-up (R5)                   |
| `age group`, `age_group`, `age`, `gender`, `grade`                                                                                                         | the derived division, `gender`, `grade`                    | Division                                  |
| `division_id`, `division_name`, `division`, `group`, `program`                                                                                             | `division_id`                                              | Division                                  |
| `skill_tier`, `skill_level`, `years_played` (and the GotSport question)                                                                                    | `skill_tier`, `years_played`                               | Team balancing                            |
| `waitlist`, `waitlisted`                                                                                                                                   | `status`                                                   | Waitlist                                  |
| `play_up`, `play up` (and the GotSport question)                                                                                                           | `play_up_requested`                                        | Play-up request                           |
| `willing_to_coach`, `coach_volunteer` (and "Can you coach for this player's team?")                                                                        | `willing_to_coach`, `custom_attributes.coaching_answer`    | Coach interest                            |
| `buddy_request`, `buddy_id`, `buddy_external_registration_id`, `buddy_registration_id`, `friend_request`, `mutual_buddy_code`, `buddy_code`, `friend_code` | `buddy_request`, `player_buddies`                          | Buddy pairing                             |
| `team name`, `team age`, `team gender`                                                                                                                     | `custom_attributes.team_name` / `team_age` / `team_gender` | Phase B (teams formed outside SquadLogic) |
| a declared player field                                                                                                                                    | `custom_attributes.<declared name>`, typed as declared     | The organization's own use                |

A player stores no birth date (R5, `20261026010000`). `import-validation` reads
the file's birth date only to compute the player's **natural age** with the
season's cutoff and its divisions' birth-date windows (the season
`finalize_import_job` adds the import to: the job's own, the active one unless
a draft was named), falling back to the age group
the export states (one or two digits, 1-25) when no birth date gives one; it
stages `natural_age` and strips every birth key from both staged payloads, and
returns the rows, birth dates included, to the browser, which keeps them for
teaming during the import session. The finalizer stores `players.natural_age`
from the staged value, else from the age group, else none (teaming places and
flags the player); it promotes a row without a birth date, and a re-import
rewrites the natural age as it rewrites the division. A `natural_age` column in
the file is never read, a birth year alone is not read (it is dropped like any
unlisted column), and every key named like a birth date or year is stripped
before staging, a declared field's included, so none reaches
`custom_attributes`. The import still requires a Date of Birth column.

A player stores no contact details or guardian contacts: R4 (`20261025010000`)
dropped `players.contact_info` and `players.guardian_contacts`, which the import
had stopped writing in R0. `players.paid` and the paperwork
flags `waiver_received` and `medical_form_received` were dropped in R1
(`20261022020000`): payments and paperwork are tracked on the league's
registration platform, and the waitlist status stays the teaming gate. The
sensitive-column filter's "Payment Status" exception (it was the `paid` flag's
source) went with it, so every payment column is stripped before upload.

## Coach import — kept fields

| Canonical key(s)                                              | Stored as                                | Used for                     |
| ------------------------------------------------------------- | ---------------------------------------- | ---------------------------- |
| `full_name`                                                   | `full_name`                              | Coach identity               |
| `email`                                                       | `email`, `contact_info.email`            | Dedupe key, admin contact    |
| `status`, `coach_status`                                      | `status`                                 | Active / inactive            |
| `can_coach_multiple_teams`, `multiple_teams`, `multi_team`    | `can_coach_multiple_teams`               | Multi-team assignment        |
| `certifications`, `certification`                             | `certifications`                         | Certifications               |
| `child_registration_id` (`Child Registration ID`, `Child ID`) | `coach_team_requests` rows, not a column | The coach's children (below) |
| a declared coach field                                        | `custom_attributes.<declared name>`      | The organization's own use   |

No phone is stored (`coaches.phone` is not written and a re-import removes
`phone` from `contact_info`). First and last name are kept only to compose the
full name (`import-rows`, below); the finalizer reads no requested division,
years coached or child name, gender or birth date, so those are dropped; the one
child column it reads is the registration id, below. A later feature that needs
another adds it to the finalizer and the allowlist together.

### A coach's children (`child_registration_id`)

An optional column names the coach's children by **player registration id**,
one or more, separated by `;` or `,` (`GS-1001; GS-1003`). Import the players
first: the finalizer matches each id to a player of the **same organization and
season** by `players.external_registration_id`, and writes one `coach_team_requests` row
per match (`coach_id`, `player_id`, `slot` in the order the file lists them; a
repeated id counts once). Rules:

- A file **with** the column replaces that coach's links with exactly the
  matches (a re-import corrects them); a file **without** it leaves the coach's
  links alone. Nothing else writes `coach_team_requests`.
- An id that matches no player here (not imported yet, mistyped, or another
  season's or organization's) writes nothing and is **never fatal**: the result lists it
  (`unmatched_child_ids`, at most 200, with their count in
  `unmatched_child_id_count`), the job completes with warnings, and the import
  screen names the first ten and says to import players first.
- `linked_children` counts the links written. Rolling the import back puts back
  the links an update replaced (those whose player is still there); a coach the
  import inserted takes its links with it.
- The key is on the allowlist in all three places (the browser's
  `importAllowlist.js`, `import-validation`'s `_shared/import-allowlist.ts` and
  `import_allowed_keys('coaches')`), with the aliases `child registration id`
  and `child id` (`Player ID` is **not** aliased: a player file uses it as a
  registration-id column).
- A coach is one row per organization, season and email (a unique index on
  `(organization_id, season_settings_id, lower(email))`, stored lower-case and
  trimmed): the same address in another season or organization is another
  coach, never a conflict.

### Players and coaches belong to one season (`20261108010000`)

Every player and coach row has a `season_settings_id`, and an import adds to
the season its job was made for (the active one, or a draft: since
`20261111010000` a draft season takes a player or coach import, so next
season's registrations can be loaded while this one runs; a completed season
never does, and a field import stays with the active season). **The import matches existing rows in that season only**: a
registration id, or a coach email, that another season holds is a new row in
this one, and nothing is read from or written to the other season's row. Nothing
carries over from one season to the next, so years of experience and skill
level come from the new season's own registration and evaluations. A division
named by id from another season matches nothing (the row's division is left
empty and counted as unmatched); buddy requests and a coach's child ids reach
players of the job's season only. An organization with no season has nothing to
import into (22023, `season_missing`). An import into a draft leaves the active
season's rows untouched, to the last column.

A season's **age rule** (the cutoff, the season year and its divisions'
birth-date windows and the age bands of those that bear one) is fixed while a player import into it is waiting to be
applied (22023, `import_pending`) and once it has players (`season_has_players`):
the import stages each row's natural age under the rule in force, so the rule
does not move between the staging and the apply. Finish or cancel the pending
import first.

The validation reads that rule once, with the season's `age_rule_revision` (a number that goes up on
every change that moves an age, and never goes back), and stamps the player file's job with the
revision; it counts every age from what that one read returned. `finalize_import_job` refuses, under the
season lock, a job whose stamp is no longer the season's revision (22023, `age_rule_changed`): a change
between the validation's read and its first staged row has nothing pending to refuse, and a change
that was reversed still shows. Validate the file again.

A **completed** season is read-only for a signed-in caller, players and coaches
included (22023, `season_completed`): no patch, delete or insert by an admin,
through an RPC or a direct write; its teams, rosters, coach history, practices,
TIME TBD exceptions and list, and games likewise. Jobs with no signed-in user (the retention job,
the demo purge) and the cascade of a deleted organization still reach its rows.

> **Duplicate headers:** the coach export repeats `Playing Up` and
> `Preferred Co-Coach` once per coached player. A PapaParse `transformHeader`
> disambiguates them positionally (`__2`) so values never collide.
>
> **Two email columns, one `email`:** a blank one never replaces the other, and
> where both are filled the later column (`Contact Email`) is kept. The full
> name is composed from `First Name` and `Last Name` when the file has no
> full-name column. Both rules live in `_shared/import-rows.ts`
> (`import-validation`) and its browser twin `frontend/src/utils/importRows.js`.

## Practice preference import — kept fields (`20261112010000`)

An admin imports a file of coaches' practice preferences (import type `practice_preferences`; the file
is the league's own spreadsheet, not a GotSport export). **One row is one rule for one team**
(`docs/changes/2026-10-26-coach-preference-rules.md`, "Revised 2026-10-27"); the rules are described in
`docs/architecture/practice-scheduling.md`. The import is admin-only end to end: `create_import_job`,
`mark_import_job_ready_to_apply`, `cancel_ready_import_job` and `finalize_practice_preference_import_job`
all refuse a signed-in user who is not an admin of the organization (42501), and a coach has no sign-in.

| Canonical key(s)                                               | Stored as                           | Reads                                                                                    |
| -------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `email` (`Coach Email`)                                        | looked up, never stored on the rule | The coach, by email within the job's season (required)                                   |
| `team_name`, `team name`, `team`                               | `team_id`                           | The team, by name within the season; blank = see below                                   |
| `request_level` (`Request Level`, `Strength`, …)               | `requested_level`, `must_decision`  | `prefer` (blank or "prefer", "nice", "soft") or `must` ("must", "required", "mandatory") |
| `weekdays`, `days`, `day`                                      | `weekdays`                          | One or more days, `Tue, Thu` or `Tuesday / Thursday`: any of these                       |
| `start_times`, `start_time`, `start`                           | `start_minutes`                     | One or more times, `5:00 PM`, `5pm`, `17:00`: any of these                               |
| `venues`, `location`                                           | `venue_ids`                         | One or more of the organization's locations by name                                      |
| `effective_from`, `valid_from` / `effective_to`, `valid_until` | `effective_from` / `effective_to`   | A date window, `YYYY-MM-DD` or `M/D/YYYY`                                                |
| `coach_priority` (`Priority`)                                  | `coach_priority`                    | `high`, `medium` or `low`; shown to the admin, never judged                              |

The browser (`importAllowlist.js`, `telemetryUtils.js` aliases), `import-validation`
(`_shared/import-allowlist.ts`, `HEADER_ALIASES`) and `import_allowed_keys('practice_preferences')` keep exactly these
18 keys and no others; a preference entity is not in Settings, so a file declares no extra field, and
`tests/importAllowlistParity.test.js` holds the three equal. `frontend/src/utils/practicePreferenceRows.js` is the
JavaScript twin of the SQL parsing, so the preview and the mock client read a row as the database does
(`tests/practicePreferenceRows.test.js` runs the same inputs as `supabase/tests/practice_preference_import.sql`).

- **A row must name a condition**: at least one of days, start times or venues (a row naming none is
  invalid and listed; the model's "keep what the team has" is something an admin sets on a rule, not a
  column of the file). An unreadable day, time, venue, date, level or priority makes the row invalid
  and it is listed with its row number; the rest of the file still applies.
- **The coach is found by email within the job's season and the team by name within the same season.**
  An unknown coach, an unknown team, a team the coach does not coach, and a coach with no team in the
  season are **listed, never created**: the result carries `unknown_coach_rows`, `unknown_team_rows`,
  `coach_not_on_team_rows`, `no_team_rows` and `invalid_rows` with their row numbers, and the job
  completes with warnings. A coach's email appears in the finalizer's result (so the screen can name the
  coach to the admin who has the file) and **nowhere that is stored**: the job's `warning_summary` and
  the audit rows carry counts and row numbers only.
- **A blank team for a coach of several teams is one rule per team** the coach coaches today, so the
  admin does not repeat a row. A named team makes one rule for that team.
- **`must` is a request.** An imported `must` is stored in force as `prefer`, with `requested_level`
  `must` and `must_decision` `pending`; it becomes a must only when an admin accepts it
  (`admin_decide_must_preference`, or `admin_accept_all_musts(import_job_id, expected_count)`, which
  refuses when the pending count is not the one the confirmation showed). The solver judges a pending
  must as a prefer until then.
- **A re-import replaces the imported rules of the teams the file names** (`status = replaced`, kept as
  history) and leaves **admin-written rules** and the imported rules of teams the file does not name
  alone. Two rows that make the same rule (the same coach, team, level, sets and window) count once
  (`duplicate_rule_rows`). Two files naming one team run one after the other: the finalizer takes a
  transaction-scoped advisory lock per named team, in id order, before it replaces, so neither file
  replaces rules the other is about to insert.
- **The active season or a draft takes a preference file; a completed season never does** (22023,
  `season_completed`), the rule `20261111010000` set for player and coach files, in `create_import_job` and
  again in the finalizer, because a season can complete between a job's creation and its apply. A draft season
  is where next season's rules are prepared; the finalizer reads the job's own season. A completed season's
  rules are also read-only on the table (`coach_practice_preferences_readonly_when_completed`, the trigger
  E3b put on the schedule tables), so no write that is not one of these RPCs can change them either.
- **Staged rows are deleted 30 days after they were staged, once their job has finished**, by the same
  retention job as coach rows (`cleanup-staging-import-rows`), because they hold coaches' emails. The deferred
  apply (`mark_import_job_ready_to_apply`, `cancel_ready_import_job`) takes the type too.
- **The screen previews the file before it uploads anything** (Phase D C2, the Practice preferences page's
  Import tab; it does not go through the shared import panel). The browser parses the CSV, applies the
  allowlist (`filterImportRows`) so the columns the import does not read are named as ignored and never
  leave it, normalizes each row as `import-validation` does (`normalizeImportRow`, the Edge function's
  `sanitizeString`, its email check), and computes the finalizer's counts from the season's coaches, teams,
  rosters and rules in force (`utils/practicePreferenceImportPreview.js`, over `practicePreferenceRows.js`).
  `tests/preferenceImport.test.jsx` runs a file that reaches every outcome through that preview and the mock
  finalizer and requires each count equal. The import itself is the three calls above in order
  (`utils/practicePreferenceImportRun.js`: `create_import_job`, `import-validation` in chunks of 1,000,
  `finalize_practice_preference_import_job`); a failure marks the job failed. A file with no email column, or
  with none of days, start times or venues, is refused before any call, and a file that can apply nothing
  offers no import. **A file the CSV parser could not split cleanly is refused whole**: a row with more or fewer
  cells than the header, or an unterminated quote, would be read as its first cells or shifted, and a rule with a
  dropped condition could replace a complete one; the rows are named by number and the parser's words.
  Every cell goes through one cleaner (`sanitizeImportText` in `utils/importRows.js`, twin of
  `_shared/import-rows.ts`, which `import-validation`'s `sanitizeString` calls): tags out, control characters out,
  trimmed, capped at 500; a lone `<` or `>` stays.

## Evaluations import — kept fields

A club often rates its players after registration, so a season's experience and skill level can
arrive in a file of their own (`20261113010000`; plan `docs/changes/2026-10-27-season-enrollment.md`,
C2). The file names a player by registration id and sets any of three values; it **only updates**
the players of the season it is imported into and creates nobody.

| Canonical key(s)                                                          | Stored as                          | Rule                                                                         |
| ------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `external_registration_id`, `gotsport_id`, `registration_id`, `player_id` | matches `external_registration_id` | Text, leading zeros kept; the first filled key, in the player import's order |
| `years_played`                                                            | `players.years_played`             | A whole number, 0 to 30                                                      |
| `skill_tier`, `skill_level`                                               | `players.skill_tier`               | `novice`, `developing` or `advanced`, in any case                            |
| `rating` (`Rating`, `Skill Rating`, `Player Rating`)                      | `players.rating`                   | A whole number, 1 to 5                                                       |

Nothing else of the file is kept, at any entry (the browser, `import-validation`,
`import_allowed_keys('evaluations')` and the finalizer, held equal by
`tests/importAllowlistParity.test.js`), and the import declares no fields of the organization's.
The rules for the values live in `_shared/import-evaluations.ts` and its browser twin
`utils/importEvaluations.js` (held equal by `tests/importEvaluationsParity.test.js`), and again in
the finalizer, because the staging table can be written without the Edge Function.

- **Matching.** A row names a player of the **job's season** (the active season or a draft; a
  completed one is refused, 22023 `season_completed`, before anything is read or written) by
  registration id, compared as text. The same id in another season, or another organization, is
  another player and is never read or written. A row that names no player is **unmatched**: counted,
  listed (at most 200, with its row number) and never created.
- **A blank cell leaves the stored value alone**, and a zero is a value (`0` years is written).
  A value is written only when it differs from the stored one, so importing the same file again
  changes nothing and moves no `updated_at`. A file may carry any of the three columns, and needs at
  least one of them and an id (the screen sends a file without to the column mapper).
- **A row is judged whole.** A cell out of range, or no registration id, makes the row **invalid**:
  none of its cells is applied, and it is counted and listed with its field and a message that quotes
  no value (the staged row keeps the errors). A registration id repeated in the file uses its first
  row (lowest row number) and lists the rest as duplicates, as the player import does.
- **Check, then confirm.** The screen validates the file, stages it, and shows the server's
  counts from a **dry run** of the same finalizer (`finalize_evaluation_import_job(job, errors,
true)`: the same statement with its writes switched off, so the numbers shown are the numbers the
  apply produces) before the admin applies or cancels. There is no one-click import and no rollback:
  the values are ordinary player fields an admin can edit.
- **Audited.** The apply is one `import.completed` audit row with `import_type = 'evaluations'`, the
  season and the counts, and no registration ids; the lists live on the job
  (`warning_summary.evaluation_finalize`). A finished job answers a second call with that stored
  result. A finished job's staged rows are deleted after 30 days
  (`cleanup-staging-evaluation-rows`).
- **What reads the values.** Teaming reads `years_played`, `skill_tier` and `rating` from the player
  record (the Teams page's durable select). `years_played` and `rating` act when the Years Played and
  Player Rating options are on. `skill_tier` acts only when the **Skill Tier** option is on (Settings,
  Features, or "Choose your tools" at set-up; off unless turned on): then a stored tier the generator can
  read replaces the registration file's tier for that player and reaches the generator as its skill rating
  (novice 1, developing 3, advanced 5), a blank leaves the file's, and a numeric `rating` still wins over it.
  With the option off the tier is stored and nothing reads it: not teaming (the registration file's tier
  included), not a screen. With it on, the tier shows on the player page and as a column in the Players grid
  and the team roster, read-only. A re-run in review, published or locked mode moves no player already on a
  team. The import accepts the Skill Tier column whatever the option, so a file can be loaded before the
  option is turned on.

## Schedule import — kept fields (`20261121010000`)

A club that already has a game schedule can bring it in as a file (plan `docs/changes/2026-11-03-schedule-expansion.md`,
4.5 to 4.7; PR 5 is the database, PR 6 the Edge validation and the Import panel's Games tab). The `games` type keeps **21
snake_case keys** per staged row and nothing else (`GAME_IMPORT_KEYS` in `frontend/src/utils/importAllowlist.js`, its Edge
twin, and `import_allowed_keys('games')`; `tests/importAllowlistParity.test.js` holds the three equal to the keys the apply
reads). A format, a note, a coach, an email or a phone in the file is never read, so it is never staged.

**The file's columns are an allowlist too** (PR 6): `import-validation` keeps `Game ID`, `Date`, `Start Time`, `End Time`,
`Length`, `Venue`, `Field`, `Division`, `Home Team`, `Away Team` and `Week`, matched by the header's normalised name, and
drops every other column before a value is read from it. The staged `raw_payload` is those columns as typed, under the
template's names, and nothing else. The season's clock places the times (the job's season; the host zone is never read).

**A time or a week that cannot be read does not lose the game** (owner, 2026-11-10). A malformed time makes the row a dated
TIME TBD game (`bad-time`); a Week that cannot be stored is derived from the date (`bad-week`). Both are warnings said at
the upload and in the preview, and since `20261122010000` they are staged flags too (the apply's list took them), so
the saved result and the Games page's banner carry them.

| Staged key(s)                                                            | Becomes                                           | Rule                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `row_key`                                                                | the row's name in the result's lists and warnings | Made by the parse (`row-<n>`); never stored                                                 |
| `game_id`                                                                | `game_assignments.external_ref`                   | Text of at most 40 characters, exact after trimming, unique per season, never a number      |
| `status`, `tbd_reason`                                                   | a game, or a TIME TBD game                        | `ok` (placed) or `tbd` (no time or no field: reason `imported-without-time`, never dropped) |
| `date`, `start_time`, `end_time`, `start`, `end`, `week_index`           | the slot and the game's instants                  | Put on the season's clock by the parse; the SQL never recomputes an instant                 |
| `flags`                                                                  | warnings of the preview                           | The parse's flags (`time-ambiguous`, `week-differs`, ...), listed, never a refusal          |
| `division`, `venue`, `field`, `home_team`, `away_team` and their `*_key` | the admin's decisions, by key                     | A label as typed, and beside it the decision key core computes; the SQL matches by equality |

A row with a time and no field is a TIME TBD game, like a row with no time: it is staged with `status` `tbd` and **no instants and no wall times** (the parse assigns them before it knows the field is blank; the SQL's shape check refuses a `tbd` row that holds one). A row with no Game ID is matched on (home, away, slot, week); a row with one is matched on (season, Game ID) and never on its tuple.

**A swap is a warning.** A game moved onto the place another game of the same file moves away from (two games of one pair in
one week that swap times, a chain of moves) is written, with the warning `games-swapped` in the preview and the result; a
place held by a game the file does not move still refuses the row (`duplicate-row`), and a held (Published) game is never
moved.

**A TIME TBD game keeps a date and its Game ID, and no time** (`schedule_tbd.game_date`, `schedule_tbd.external_ref`; the
staged row carries the date and no instants). A row is found by (season, Game ID) first, and changed in place; the
`week_index` is the file's week, and a week that is not the date's is the warning `week-differs`, never renumbered. A game
the file now places leaves the TIME TBD list; a placed game the file now gives no time is converted with the warning
`game-made-time-tbd` unless it is held.

What is stored on the way: `game_assignments.external_ref` (the Game ID), `game_assignments.import_job_id` (the job that
last wrote the row), `schedule_tbd.external_ref` and `schedule_tbd.game_date` (a TIME TBD game's Game ID and date) and `teams.is_external` (an outside club: one row per division and club label, a side of a game and
nothing else: no players, no coach, no practice, in no team run). No birthdate, name of a person or contact is in the file's
allowlist, and none is stored.

## Practice schedule import — kept fields (`20261123010000`)

A club that already has a practice schedule can bring it in as one flat CSV, one row per timed cell (plan
`docs/changes/2026-11-03-schedule-expansion.md` 4.11; PR 9 is the parse, PR 10 the database, PR 11 the Edge validation and
the Import panel's Practices tab). The `practice_schedule` type keeps **19 snake_case keys** per staged row and nothing else
(`PRACTICE_SCHEDULE_IMPORT_KEYS` in `frontend/src/utils/importAllowlist.js`, its Edge twin, and
`import_allowed_keys('practice_schedule')`; `tests/importAllowlistParity.test.js` holds the three equal to the keys the apply
reads). Core's `toStagedPracticeRow` (`packages/core/src/practiceImport/staging.js`) is where a parsed row becomes them. A
coach, an email, a phone or a note in the file is never read, so it is never staged.

| Staged key(s)                                                        | Becomes                                   | Rule                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `row_key`                                                            | the row's name in the result's lists      | Made by the parse (`row-<n>`); never stored                                                     |
| `status`                                                             | a practice, an open slot, or nothing      | `placement`, `open` (a slot and no practice) or `hold` (no slot; listed)                        |
| `day`, `start_time`, `end_time`                                      | the slot's weekday and wall times         | `mon` to `sun`, `HH:mm`; no instant, no clock                                                   |
| `valid_from`, `valid_until`                                          | the slot's dates and the practice's range | The row's, else the confirm step's, else the season's (the parse settles them); `[from, until]` |
| `capacity`                                                           | the capacity of a slot the import makes   | 1 to 32767; a slot that exists keeps its own                                                    |
| `flags`                                                              | a flag of the result                      | Only `division-not-reserved` (the parse's); the database judges the rest                        |
| `division`, `location`, `field`, `subunit`, `team` and their `*_key` | the admin's decisions, by key             | A label as typed, and beside it the decision key core computes; the SQL matches by equality     |

What is stored: `practice_assignments` rows (`source = 'manual'`, `assigned_via = 'manual'`, no run), `practice_slots`, and,
only where the admin chose to create them, `divisions` (no age band), `locations` and `fields` (no coordinates, unknown
lighting), `field_subunits` and team shells (a name and a division, no players, no coach). `Division` here names a team's
division and **reserves nothing** (in the fields CSV it does). No name of a person or contact is in the file's allowlist,
and none is stored.

## Dropped on import (never stored)

Everything not listed above, including: guardian and parent names, emails,
alternate emails, phones and addresses; the player's or coach's own email and
phone (a coach's email excepted); payment status, payment plan and every
amount, discount and financial-aid column; the coach's child's name, gender and
birth date, playing-up and preferred co-coach answers on the coach export; the
adult coach's own birth date, birth year and gender; enroller, role and club
name; all medical, allergy, emergency-contact, physician and insurance fields
(the sensitive-column filter drops these first); all waiver, consent and
acknowledgement text; uniform size, referee or volunteer willingness and "how
did you hear", unless the organization declared the field.

## What was stored before, and the purge

Migration `20261022010000` purged what earlier imports stored, and none of it
can be restored:

- every coach's `custom_attributes` reduced to its declared fields,
  `coaches.phone` cleared and `phone` removed from `contact_info`, and the same
  in the coach snapshots `import_application_records` keeps for rollback;
- every player's `custom_attributes` reduced to its declared fields and the
  import's own keys, `contact_info` emptied and `guardian_contacts` emptied (both
  columns dropped since, by `20261025010000`);
- the staged player and coach rows of every completed or failed import deleted.
  Field and field-availability rows stay (a refused field row waits on its job
  for replay), and so do the rows of an import still waiting to be applied,
  reduced to the allowlist (their `raw_payload`, which nothing reads, keeps only
  columns whose lower-cased header is itself an allowlisted key or a declared
  field);
- personal values in `audit_log.metadata` replaced with `[redacted]`: every
  key whose name contains `email` (a boolean such as `has_email` aside), and a
  player event's names, birth date, contact and guardian values; and a
  value an "Invalid date format" or "Invalid email format" row error quoted
  removed from `import_jobs.error_summary`. `import-validation` no longer
  quotes the value.

Retention: a daily job deletes a finished import's staged coach rows 30 days
after they were staged, and `cleanup-staging-players` now does the same for
staged players. Neither touches the rows of an import still waiting to be
applied (the player job used to delete them whatever the import's state).

The SQL copy of the key lists is `import_allowed_keys(type)`; the parity test
holds it equal to the two code copies.

## Age cutoff (configurable per season)

`season_settings.age_cutoff_mode` selects how a birthdate maps to a U-band (at
import, into the stored natural age; and in the browser during the import
session, from the file's rows). The **season year** is the year the season
starts, `S` below:

- **`school_year_aug_jul`** (default) — Aug 1 cutoff; the U(N) cohort is born
  Aug 1 (S−N−1) … Jul 31 (S−N).
- **`birth_year`** — calendar cutoff; the U(N) cohort is born in calendar year
  S−N.
- **`custom`** (`20261111010000`) — a cutoff month and day the club picks
  (`age_cutoff_month`, `age_cutoff_day`), applied every season year: a player born
  on or after the cutoff day is in the cohort one U-number younger, as with Aug 1.
  A cutoff of Jan 1 is the calendar year, Feb 29 counts as Mar 1 in a year
  without one, and a custom season with no usable day is read as the school year.

Derivation lives in `packages/core/src/ageGroups.js` (`importNaturalAge`; its
Edge twin is `supabase/functions/_shared/natural-age.ts`, held equal by
`tests/naturalAgeParity.test.js`). **A division's own birth-date window**
(`divisions.birthdate_start/end`, both ends) is authoritative where a birth date
is at hand: the import counts a birth date inside a division's window as that
division's age, brought into its band (`min_age`/`max_age`, else the U-numbers in
its name), so a U4 that also takes older 2-year-olds counts them as 4; a date two
windows hold takes the lower age, and a window with no readable band is ignored.
The same rule (`birthDateAge`) counts the birth dates the Teams page keeps for
the import session: play-up (`resolveNaturalAge`, `applyPlayUpEligibility`) and
the program grouping (`computeAgeGroup`, `useTeamAnalysis`). Otherwise the band is
computed from the division's `min_age`/`max_age` (which support the pilot's
single-year and multi-year bands, e.g. U11–U12).

The cutoff, the season year and a division's window are set on the Seasons page
(Settings, Season & Calendar) by `admin_update_draft_season` and
`admin_set_division_birthdate_window`: the year and the cutoff on a draft only,
and **none of the three changes once the season has players**, since their stored
ages were counted with the old rule (triggers on `season_settings` and
`divisions`, so every writer meets them). A rollover shifts each division's window
by the difference in season years.

## Play-up / play-down

`packages/core/src/playUp.js` places every player in their own age division by
default and approves or refuses nothing (owner, 2026-10-27,
`docs/changes/2026-10-27-play-up-by-request.md`): clubs' rules differ (play up only
with a parent coaching the team, and so on), so the app lists the facts and the admin
decides.

- **The request.** The play-up column (`play_up`, `play up`, or the GotSport question)
  is stored as `players.play_up_requested`: yes, true, y, t, 1 or x is a request,
  anything else is none, a blank cell included (a request withdrawn in the file); a
  row without the column at all leaves a re-imported player's request alone. An admin sets or clears it on the player record (an audited patch).
- **Play up** (registered in an older division than the natural age): with a request
  the player plays in the older division they registered for; without one, in their
  own age division. Either way the **Play-up** section of the Teams page lists them,
  with the facts an admin needs: natural age, the division registered and the one
  played in, whether a parent coaches (a `coach_team_requests` link of an active or
  pending-confirmation coach) and whether a buddy is in the division.
- **Play down** (registered in a younger division): the player plays in their own age
  division and is listed. With the organization setting **Play-down** on (Settings,
  Features; `play_down` in `organizations.feature_flags`, off unless an admin turns it on)
  they play in the division they registered for instead, whatever the gap, and are listed
  all the same: no import column asks for a play-down, so the registration is the request
  (owner, 2026-11-03, `docs/changes/2026-11-03-play-down-default-and-flags.md`). The page
  hands the placement a boolean (`allowPlayDown`). A play-up is unaffected: it stays by
  request.
- **A roster that exists is not reshuffled by a rule that changed.** A player already on a
  reviewed, published or locked roster keeps that seat when the setting is turned on or
  off, or a play-up request is cleared or set; a re-run would otherwise read them as having
  left the division and remove them from the roster. The page reads the seats of the saved
  rosters (`heldSeatsFromSnapshot`) and the placement keeps a player on the roster's division
  when that is a seat the rule itself could give them (the division registered for, or their
  own age division), listing them with what a new roster would do. A roster in any other
  division (the registration changed, a move by hand) is not held.
- **Only a player no division can hold** is not placed: none in the import covers
  their natural age with the same gender (or a co-ed division). A girl registered in
  U12 Girls never moves to U10 Boys. Listed under "Not placed" with the reason.
- **The waitlist exception.** A waitlisted player comes off the waitlist only when a
  coach asked for them: the buddy, under the league's buddy rule, of a coach's linked
  child. They are placed on the coach's team with that child and listed; saving the
  teams makes them active through the audited bulk status write. Each child gets one
  such buddy, and the choice reads no row order (the child's own request first, then
  the lowest player id).

A division with no registered player is not a program of the import, so a player
whose own age division is one is listed as not placed.

## Division auto-create

`upsert_division_for_import(...)` idempotently materializes a division (keyed by
`season_settings_id` + name) with its gender policy, age band, and birthdate
window — so the pilot's 21 programs become divisions instead of leaving players
unassigned when no division name matches.

## Coaches feed teaming

`coach_team_requests` links each coach to their child player(s). The teaming
pipeline (`packages/core/src/teamingPipeline.js`) projects those links onto the
roster so the generator anchors a team per coaching family. **Only these links
anchor a team** (owner decision 8a, 2026-10-27): a coach an import row names
(`coach_id`, `coach_email`) anchors nothing. The coach import writes the links
from its `child_registration_id` column (above), whatever the coach's status; the Teams page
reads them only for a coach who is `active` or `pending-confirmation` (the statuses
`admin_assign_team_coach` accepts), so an `inactive` or `interested` coach's child is placed like
any other player until the coach is active again. Rolling the import back restores the links an
update replaced, except for a coach deleted since, which has nothing left to link.

## Operational note — pilot DB migration divergence

The connected pilot project's migration history diverges from this repo and is
missing the import-finalize pipeline (`finalize_import_job`,
`staging_import_rows`, import helper functions). The additive schema and the
`upsert_division_for_import` RPC were applied directly and verified. Folding
division auto-create and the new canonical fields **into** the finalize RPCs
should be applied once the import pipeline is deployed to that project. (The
coach→child links are written by the coach finalizer since 20261104010000; a
co-coach is not resolved.)
