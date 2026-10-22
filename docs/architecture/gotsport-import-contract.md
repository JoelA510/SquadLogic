## [← Back to Documentation Index](../README.md)

# GotSport Import Contract

SquadLogic stores **only** the registration data needed for teaming and
scheduling. A client-side canonicalizer
(`frontend/src/utils/gotsportCanonicalizer.js`) runs on every player/coach CSV
**before upload**, so columns SquadLogic does not need never leave the browser.
GotSport remains the system of record for waivers, medical/emergency details,
insurance, payments, financial aid, and full guardian demographics.

## Player import — kept fields

| GotSport header                                              | Canonical field             | Used for                                  |
| ------------------------------------------------------------ | --------------------------- | ----------------------------------------- |
| `Registration ID`                                            | `external_registration_id`  | Dedupe, re-import, buddy/roster matching  |
| `First Name`, `Last Name`                                    | `first_name`, `last_name`   | Roster identity                           |
| `DOB`                                                        | `date_of_birth`             | Age band + play-up eligibility            |
| `Birth Year`                                                 | `birth_year`                | Fallback/age cross-check                  |
| `Gender`                                                     | `gender`                    | Division gender                           |
| `Program`                                                    | `division_name`             | Division identity (gender+age unique)     |
| `Age Group`                                                  | `age_group_label`           | Age band (min/max) on division auto-create|
| `Complete`/`Submitted`/`Waitlist`/`Payment Status`          | `registration_status`, `placement_eligible` | Eligibility gating (workflow internals not stored) |
| `Guardian 1/2 First/Last/Email/Mobile`                      | `guardian_contacts[]`       | Contact + coach-lead linkage              |
| buddy-request question                                       | `buddy_request_name`        | Buddy pairing (resolved to player)        |
| "years played" question                                     | `experience_years`, derived `skill_tier` | Team balancing            |
| "Can you coach for this player's team?"                      | `willing_to_coach`          | Coach lead                                |
| "Are you coaching so this player can play up a division?"   | `play_up_requested`         | Play-up signal                            |

## Coach import — kept fields

| GotSport header                                  | Canonical field            | Used for                          |
| ------------------------------------------------ | -------------------------- | --------------------------------- |
| `First Name` + `Last Name`                       | `full_name` (composite)    | Coach identity                    |
| `Contact Email` / `Email/UserID`                 | `email`                    | Identity + dedupe                 |
| `Phone`                                          | `phone`                    | Contact                           |
| `Registration ID`                                | `source_registration_id`   | Audit traceability                |
| `Age Group`                                      | `requested_division`       | Division matching                 |
| "years coached" question                         | `coaching_years`           | Assignment/scheduling priority    |
| child #1/#2 name/gender/birth date               | `coach_team_requests` rows → `player_id` | Keep coach with their child; multi-team |
| `Playing Up` (×2, disambiguated)                 | `child_1_playing_up`, `child_2_playing_up` | Play-up constraint    |
| `Preferred Co-Coach` (×2, disambiguated)         | `child_1_preferred_co_coach`, `child_2_preferred_co_coach` | Co-coach pairing |

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

Enroller, role, payment plan, club name; all medical/allergy/emergency-contact/
physician/insurance fields; guardian addresses/city/state/postal/country/alt
contacts; all waiver/consent/acknowledgement text; uniform size; referee/
volunteer willingness; "how did you hear"; financial-aid flag and every discount
quantity/price/amount column; the adult coach's own DOB/Birth Year/Gender.

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
roster so the generator anchors a team per coaching family — a separately
imported coach export now drives team generation.

## Operational note — pilot DB migration divergence

The connected pilot project's migration history diverges from this repo and is
missing the import-finalize pipeline (`finalize_import_job`,
`staging_import_rows`, import helper functions). The additive schema and the
`upsert_division_for_import` RPC were applied directly and verified. Folding
division auto-create and the new canonical fields **into** the finalize RPCs
(and resolving coach→child / co-coach into `coach_team_requests` during coach
finalize) should be applied once the import pipeline is deployed to that project.
