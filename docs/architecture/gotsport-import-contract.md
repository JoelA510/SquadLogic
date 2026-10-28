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
`20261109010000` a draft season takes a player or coach import, so next
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
birth-date windows) is fixed while a player import into it is waiting to be
applied (22023, `import_pending`) and once it has players (`season_has_players`):
the import stages each row's natural age under the rule in force, so the rule
does not move between the staging and the apply. Finish or cancel the pending
import first.

The validation stamps a player file's job with a fingerprint of that rule **before it reads the
rule**, and `finalize_import_job` refuses, under the season lock, a job whose stamp is no longer the
season's rule (22023, `age_rule_changed`): a change between the validation's read and its first
staged row has nothing pending to refuse, and this is what catches it. Validate the file again.

A **completed** season is read-only for a signed-in caller, players and coaches
included (22023, `season_completed`): no patch, delete or insert by an admin,
through an RPC or a direct write; its teams, rosters, coach history, practices,
TIME TBD exceptions and games likewise. Jobs with no signed-in user (the retention job,
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
- **`custom`** (`20261109010000`) — a cutoff month and day the club picks
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
  division and is listed.
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
