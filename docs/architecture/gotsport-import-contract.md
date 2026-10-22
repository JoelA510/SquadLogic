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
   for coaches (the coach's email is how they sign in);
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
| `date_of_birth`, `dob`, `birth_year`                                                                                                                       | `date_of_birth`, `birth_year`                              | Age band + play-up (until a later PR, R5) |
| `age group`, `age_group`, `age`, `gender`, `grade`                                                                                                         | the derived division, `gender`, `grade`                    | Division                                  |
| `division_id`, `division_name`, `division`, `group`, `program`                                                                                             | `division_id`                                              | Division                                  |
| `skill_tier`, `skill_level`, `years_played` (and the GotSport question)                                                                                    | `skill_tier`, `years_played`                               | Team balancing                            |
| `waitlist`, `waitlisted`                                                                                                                                   | `status`                                                   | Waitlist                                  |
| `play_up`, `play up` (and the GotSport question)                                                                                                           | `custom_attributes.play_up`                                | Play-up signal                            |
| `willing_to_coach`, `coach_volunteer` (and "Can you coach for this player's team?")                                                                        | `willing_to_coach`, `custom_attributes.coaching_answer`    | Coach interest                            |
| `buddy_request`, `buddy_id`, `buddy_external_registration_id`, `buddy_registration_id`, `friend_request`, `mutual_buddy_code`, `buddy_code`, `friend_code` | `buddy_request`, `player_buddies`                          | Buddy pairing                             |
| `team name`, `team age`, `team gender`                                                                                                                     | `custom_attributes.team_name` / `team_age` / `team_gender` | Phase B (teams formed outside SquadLogic) |
| a declared player field                                                                                                                                    | `custom_attributes.<declared name>`, typed as declared     | The organization's own use                |

A player import no longer writes `contact_info` (new rows get `{}`),
`guardian_contacts` (new rows get `[]`) or `paid` (new rows get `false`); an
existing player's values are left as they are until those columns are dropped
(R1, R4).

## Coach import — kept fields

| Canonical key(s)                                           | Stored as                           | Used for                   |
| ---------------------------------------------------------- | ----------------------------------- | -------------------------- |
| `full_name`                                                | `full_name`                         | Coach identity             |
| `email`                                                    | `email`, `contact_info.email`       | Sign-in, dedupe            |
| `status`, `coach_status`                                   | `status`                            | Active / inactive          |
| `can_coach_multiple_teams`, `multiple_teams`, `multi_team` | `can_coach_multiple_teams`          | Multi-team assignment      |
| `certifications`, `certification`                          | `certifications`                    | Certifications             |
| a declared coach field                                     | `custom_attributes.<declared name>` | The organization's own use |

No phone is stored (`coaches.phone` is not written and a re-import removes
`phone` from `contact_info`). First and last name are kept only to compose the
full name (`import-rows`, below); the finalizer reads no registration id,
requested division, years coached or child columns, so those are dropped; a
later feature that needs one adds it to the finalizer and the allowlist
together.

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
phone (a coach's sign-in email excepted); payment status, payment plan and every
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
  import's own keys, `contact_info` emptied and `guardian_contacts` emptied;
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

`season_settings.age_cutoff_mode` selects how a birthdate maps to a U-band:

- **`school_year_aug_jul`** (default) — Aug 1 cutoff; the U(N) cohort is born
  Aug 1 (S−N−1) … Jul 31 (S−N).
- **`birth_year`** — calendar cutoff; the U(N) cohort is born in calendar year
  S−N.

Derivation lives in `packages/core/src/ageGroups.js`. Per-division birthdate
windows (`divisions.birthdate_start/end`) are authoritative when set; otherwise
the band is computed from the division's `min_age`/`max_age` (which support the
pilot's single-year and multi-year bands, e.g. U11–U12).

## Play-up / play-down

`packages/core/src/playUp.js` enforces the pilot rule:

- **Play up** (into an older band) is allowed **only when sanctioned**: the
  player's parent coaches that division (coach-child), or they are buddied with a
  player who legitimately belongs to it.
- **Play down** is never allowed.

Unsanctioned play-ups and play-downs are flagged (and, in multi-division runs,
remapped to the player's natural division). `useConflicts` surfaces the same:
sanctioned play-ups are not conflicts; play-downs and unsanctioned play-ups are.

## Division auto-create

`upsert_division_for_import(...)` idempotently materializes a division (keyed by
`season_settings_id` + name) with its gender policy, age band, and birthdate
window — so the pilot's 21 programs become divisions instead of leaving players
unassigned when no division name matches.

## Coaches feed teaming

`coach_team_requests` links each coach to their child player(s). The teaming
pipeline (`packages/core/src/teamingPipeline.js`) projects those links onto the
roster so the generator anchors a team per coaching family. The coach import
does not create those links: its finalizer reads no child columns, and the
allowlist drops them.

## Operational note — pilot DB migration divergence

The connected pilot project's migration history diverges from this repo and is
missing the import-finalize pipeline (`finalize_import_job`,
`staging_import_rows`, import helper functions). The additive schema and the
`upsert_division_for_import` RPC were applied directly and verified. Folding
division auto-create and the new canonical fields **into** the finalize RPCs
(and resolving coach→child / co-coach into `coach_team_requests` during coach
finalize) should be applied once the import pipeline is deployed to that project.
