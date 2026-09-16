[← Back to Documentation Index](README.md)

---

# SquadLogic Architecture Map

A reconnaissance map of the repository as it exists at the time of writing. It is written so that a
fresh session can find things without re-reading the tree. Every claim cites a file and line range.
Statements that are inference rather than something read directly are prefixed **Inferred:**.

Nothing in the codebase was modified to produce this document.

**Reading order if you are new:** §1.1 (where the model actually lives) → §2.1 (the game solver) →
§6 (Known gaps).

---

## 0. Repository shape

```text
SquadLogic/
├── frontend/src/           Vite + React 19 SPA (pages, hooks, contexts, components)
├── packages/core/src/      @squadlogic/core — pure JS domain logic, 10 852 lines
├── supabase/
│   ├── migrations/         108 SQL migrations (see §4.1 for which ones are load-bearing)
│   └── functions/          7 Deno Edge Functions, 3 814 lines
├── tests/                  137 Vitest files + 22 Playwright-BDD features
├── fixtures/season-2026/   Real anonymized season regression corpus (NOT yet wired to any test)
└── docs/
```

Core module sizes (`wc -l packages/core/src/*.js`), largest first, because size tracks where the
logic actually is:

| Module                  | Lines | Role                                                      |
| ----------------------- | ----: | --------------------------------------------------------- |
| `teamGeneration.js`     |  1442 | Roster allocation (buddies, coach anchoring, snapshots)   |
| `gameScheduling.js`     |   778 | Round-robin + greedy slot allocation                      |
| `practiceScheduling.js` |   752 | Weekday practice slot assignment                          |
| `autoScheduler.js`      |   610 | Hill-climbing optimizer (practices only)                  |
| `practiceMetrics.js`    |   601 | Practice evaluation / fairness                            |
| `teamSnapshot.js`       |   532 | Incremental-teaming snapshot normalization                |
| `gameMetrics.js`        |   444 | Game schedule evaluation / conflict detection             |
| `rosterSizing.js`       |   353 | Format → roster-size derivation                           |
| `evaluationPipeline.js` |   269 | Aggregates practice + game evaluations into a status      |
| `gameValidation.js`     |   157 | Drag-time move validation — **not wired to the UI**, §3.4 |

---

## 1. The domain model as it exists today

### 1.1 The model is defined in five places, none of which is authoritative

This is the single most important structural fact about the repo. The same entities are described
independently by:

1. **JSDoc typedefs** — `packages/core/src/types.js` (169 lines). Advisory only:
   `tsconfig.json` runs `checkJs` with `strict: false`, and the typedefs are not imported at
   runtime (the file ends with a bare `export {}` at `packages/core/src/types.js:169`).
2. **Zod schemas** — `packages/core/src/schemas/index.js` (75 lines). These _are_ enforced at
   runtime, but only at four engine entry points (§3.1).
3. **SQL DDL** — `supabase/migrations/20260331000000_definitive_schema.sql` (the consolidated
   baseline, 35 tables) plus ~70 later migrations that add columns and RPCs.
4. **A second Zod copy for Deno** — `supabase/functions/_shared/schemas/scoring.ts:7-69`.
5. **A third inline Zod copy** — `supabase/functions/auto-scheduler/index.ts:32-94`.

These four schema copies have already diverged. Compare the slot definition:

```js
// packages/core/src/schemas/index.js:28-40
export const SlotSchema = z
  .object({
    id: z.any().refine((val) => !!val, { message: 'each slot requires an id' }),
    capacity: z.number().min(0, { message: 'slot capacity must define a non-negative capacity' }),
    organization_id: z.string().uuid().optional(),
    start: z.coerce.date(),
    end: z.coerce.date(),
  })
  .refine((data) => data.end > data.start, {
    message: 'slot must end after it starts',
    path: ['end'],
  })
  .passthrough();
```

```ts
// supabase/functions/_shared/schemas/scoring.ts:16-25 — same concept, different types
export const SlotSchema = z
  .object({
    id: z.string(),
    capacity: z.number().min(0),
    start: z.string().or(z.date()),
    end: z.string().or(z.date()),
    day: z.string().nullable().optional(),
    organization_id: z.string().uuid().optional(),
  })
  .passthrough();
```

The core version coerces to `Date` and enforces `end > start`; the Deno version does neither and
adds a `day` field the core version does not know about. **Inferred:** the Deno copies exist
because Edge Functions cannot import from the npm workspace, and were hand-ported rather than
generated — `supabase/functions/_shared/engines/scoring-engine.ts:26-29` says as much
("Migrated from packages/core/src/practiceMetrics.js and gameMetrics.js").

Every schema in `packages/core/src/schemas/index.js` is `.passthrough()`, so unknown fields survive
validation silently. That is what makes the engines tolerant of the snake_case/camelCase dual
shapes described below, and also what makes schema drift invisible.

### 1.2 Entities in the engine (JSDoc typedefs)

`packages/core/src/types.js` defines twelve typedefs. The ones that matter for scheduling, quoted
verbatim:

```js
// packages/core/src/types.js:24-38
/**
 * @typedef {Object} Team
 * @property {string} id - UUID or generated ID
 * @property {string} name - Team name
 * @property {string} division - Division identifier
 * @property {string} [age_group] - Age group classification
 * @property {string} [organization_id] - UUID
 * @property {string} [coachId] - UUID of the assigned head coach (engine terminology)
 * @property {boolean} [coachNeeded] - True when the team has no head coach yet (placeholder slot)
 * @property {string} [head_coach_id] - UUID of the assigned head coach (DB terminology)
 * @property {string[]} [assistantCoachIds] - Array of assistant coach IDs
 * @property {number} [skillTotal] - Total skill rating of all players
 * @property {Player[]} [players] - List of players on the team
 * @property {string} [created_at] - ISO timestamp
 */
```

```js
// packages/core/src/types.js:59-76
/**
 * @typedef {Object} PracticeSlot
 * @property {string} id
 * @property {string} [day]
 * @property {string} start - ISO string or Date
 * @property {string} end - ISO string or Date
 * @property {number} capacity
 */

/**
 * @typedef {Object} GameSlot
 * @property {string} id
 * @property {string} start
 * @property {string} end
 * @property {number} capacity
 * @property {string} [fieldId]
 * @property {number} [priority]
 */
```

Note what `GameSlot` does _not_ have: a venue, a date, a format, a size, a permit reference, or a
parent field. `fieldId` is an opaque string; `priority` is an integer used only as a sort key.

```js
// packages/core/src/types.js:40-57
/**
 * @typedef {Object} Player
 * @property {string} id - UUID
 * @property {string} [first_name] - First name (DB)
 * @property {string} [last_name] - Last name (DB)
 * @property {string} [firstName] - First name (Engine)
 * @property {string} [lastName] - Last name (Engine)
 * @property {string} division - Division identifier
 * @property {number} [skillRating] - Numeric skill level (Engine)
 * @property {number} [skillLevel] - Numeric skill level (Engine/Tests)
 * @property {string} [skill_tier] - DB skill tier (novice, etc)
 * @property {string} [buddyId] - Requested buddy (Engine)
 * @property {string} [buddy_id] - Requested buddy (DB)
 * @property {string} [coachId] - Voluntary coach link (Engine)
 * @property {string} [coach_id] - Voluntary coach link (DB)
 * @property {string} [assistantCoachId] - Voluntary assistant link
 * @property {Record<string, any>} [custom_attributes] - Dynamic attributes
 */
```

The doubled `first_name`/`firstName`, `buddyId`/`buddy_id`, `coachId`/`coach_id` pairs are the
engine/DB boundary leaking into the type. Canonicalization helpers exist for two of them
(`getCanonicalBuddyId` at `packages/core/src/buddyLinking.js:41`, `playerCoachRef` at
`packages/core/src/coachContinuity.js:49`) but there is no single normalization layer.

There is also an `Event` typedef (`packages/core/src/types.js:102-114`) with
`type: ('game'|'practice'|'meeting'|'other')` — no table or engine code uses it; it appears to be
vestigial.

### 1.3 What the engines actually enforce (Zod)

```js
// packages/core/src/schemas/index.js:6-23
export const TeamSchema = z
  .object({
    id: z.any().refine((val) => !!val, { message: 'each team requires an id' }),
    division: z.any().refine((val) => !!val, { message: 'team division is required' }),
    organization_id: z.string().uuid().optional(),
  })
  .passthrough();

export const PlayerSchema = z
  .object({
    id: z.any().refine((val) => !!val, { message: 'each player requires an id' }),
    division: z.any().refine((val) => !!val, { message: 'each player requires a division' }),
    organization_id: z.string().uuid().optional(),
  })
  .passthrough();
```

```js
// packages/core/src/schemas/index.js:45-59
export const AssignmentSchema = z
  .object({
    weekIndex: z.number().positive({ message: 'assignment.weekIndex must be a positive number' }),
    division: z.any().refine((val) => !!val, { message: 'assignment.division is required' }),
    slotId: z.any().refine((val) => !!val, { message: 'assignment.slotId is required' }),
    homeTeamId: z.any().refine((val) => !!val, { message: 'homeTeamId is required' }),
    awayTeamId: z.any().refine((val) => !!val, { message: 'awayTeamId is required' }),
    start: z.coerce.date(),
    end: z.coerce.date(),
  })
  .refine((data) => data.end > data.start, {
    message: 'assignment end time must be after the start time',
    path: ['end'],
  })
  .passthrough();
```

A scheduled game is therefore, in full: `(weekIndex, division, slotId, homeTeamId, awayTeamId,
start, end)` plus a passthrough `fieldId`. `homeTeamId`/`awayTeamId` are both required and truthy —
there is no representation for a fixture with an unknown participant.

### 1.4 The database model (SQL DDL)

All DDL below is from `supabase/migrations/20260331000000_definitive_schema.sql` unless noted.
Every table has `organization_id uuid NOT NULL REFERENCES public.organizations(id)` and
`ENABLE ROW LEVEL SECURITY`.

**Facilities** — a two-level hierarchy (`locations` → `fields`) plus an unused third level
(`field_subunits`):

```sql
-- 20260331000000_definitive_schema.sql:308-317
CREATE TABLE IF NOT EXISTS public.locations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name                text NOT NULL,
    address             text,
    lighting_available  boolean DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    UNIQUE (organization_id, name)
);

-- 20260331000000_definitive_schema.sql:325-339
CREATE TABLE IF NOT EXISTS public.fields (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    location_id         uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    name                text NOT NULL,
    surface_type        text,
    size                text,
    supports_halves     boolean DEFAULT false,
    max_age             text,
    priority_rating     integer DEFAULT 1,
    active              boolean DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    UNIQUE (location_id, name)
);

-- 20260331000000_definitive_schema.sql:347-355
CREATE TABLE IF NOT EXISTS public.field_subunits (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    field_id            uuid NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
    label               text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    UNIQUE (field_id, label)
);
```

`field_subunits` carries a label and nothing else — no size, no lining, no overlap. It is
referenced by `practice_slots.field_subunit_id` (`:502`) and by the field-import target-table
whitelist, but **never by `game_slots`, `game_assignments`, or any engine code**.

**Slots and games** — three tables that partly duplicate each other:

```sql
-- 20260331000000_definitive_schema.sql:548-562
CREATE TABLE IF NOT EXISTS public.game_slots (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    field_id            uuid NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
    division_id         uuid REFERENCES public.divisions(id) ON DELETE SET NULL,
    start                timestamptz,
    "end"               timestamptz,
    slot_date           date,
    start_time          time,
    end_time            time,
    week_index          smallint,
    capacity            smallint DEFAULT 1,
    created_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at          timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- 20260331000000_definitive_schema.sql:583-600
CREATE TABLE IF NOT EXISTS public.games (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    season_id           uuid REFERENCES public.season_settings(id) ON DELETE SET NULL,
    game_slot_id        uuid UNIQUE REFERENCES public.game_slots(id) ON DELETE CASCADE,
    home_team_id        uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    away_team_id        uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    venue_id            uuid,
    start_time          timestamptz,
    week_index          smallint,
    score_home          smallint,
    score_away          smallint,
    has_conflict        boolean DEFAULT false,
    conflict_reason     text,
    created_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    CONSTRAINT games_team_difference CHECK (home_team_id <> away_team_id)
);
```

`game_assignments` was created in the baseline as a stub with only `id`, `organization_id`, and
timestamps (`:570-575`), and back-filled six weeks later:

```sql
-- 20260503030000_repair_game_persistence_rpc.sql:5-16
ALTER TABLE public.game_assignments
    ADD COLUMN IF NOT EXISTS run_id uuid,
    ADD COLUMN IF NOT EXISTS game_slot_id uuid,
    ADD COLUMN IF NOT EXISTS slot_id uuid,
    ADD COLUMN IF NOT EXISTS field_id uuid,
    ADD COLUMN IF NOT EXISTS home_team_id uuid,
    ADD COLUMN IF NOT EXISTS away_team_id uuid,
    ADD COLUMN IF NOT EXISTS division text,
    ADD COLUMN IF NOT EXISTS week_index smallint,
    ADD COLUMN IF NOT EXISTS start timestamptz,
    ADD COLUMN IF NOT EXISTS "end" timestamptz,
    ADD COLUMN IF NOT EXISTS assignment_source public.source_enum DEFAULT 'auto'::public.source_enum;
```

That migration's header comment states the reason plainly: "the Edge Function already calls
persist_game_schedule, but no current migration defined that RPC and game_assignments lacked
scheduler columns" (`20260503030000_repair_game_persistence_rpc.sql:1-3`).

`game_assignments` is what the scheduler writes (§2.5). `games` is the older table, still carrying
`score_home`/`score_away` and used by the scores path (`admin_update_game_score` RPC,
`20260504010000_update_game_score_rpc.sql`). **Inferred:** `games` is legacy and
`game_assignments` superseded it, but neither was retired — `games.game_slot_id UNIQUE` and
`game_slots.capacity smallint DEFAULT 1` directly contradict each other (a capacity-2 slot cannot
hold two `games` rows).

**People and teams:**

```sql
-- 20260331000000_definitive_schema.sql:459-472
CREATE TABLE IF NOT EXISTS public.teams (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    division_id         uuid NOT NULL REFERENCES public.divisions(id) ON DELETE CASCADE,
    name                text NOT NULL,
    coach_id            uuid REFERENCES public.coaches(id) ON DELETE SET NULL,
    assistant_coach_ids uuid[] DEFAULT '{}'::uuid[],
    practice_slot_id    uuid,
    calendar_token      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at          timestamptz NOT NULL DEFAULT timezone('utc', now()),
    UNIQUE (division_id, name)
);
```

One head coach (`coach_id`), assistants as a bare `uuid[]`. No table models "person X is committed
at time T" independent of a team.

```sql
-- 20260331000000_definitive_schema.sql:411-436 (abridged to the scheduling-relevant columns)
CREATE TABLE IF NOT EXISTS public.coaches (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    profile_id          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    player_id           uuid REFERENCES public.players(id) ON DELETE SET NULL,
    full_name           text NOT NULL,
    email               text NOT NULL CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    preferred_practice_days day_of_week[],
    preferred_practice_window tsrange,
    can_coach_multiple_teams boolean DEFAULT false,
    status              text DEFAULT 'active' CHECK (status IN ('active', 'pending-confirmation', 'inactive')),
    ...
    UNIQUE (email),
    UNIQUE (user_id)
);
```

Coach identity is keyed on a **globally unique email**. `coach_team_requests`
(`20260530000000_age_cutoff_division_bands_canonical_fields.sql:64-84`) links a coach to up to N
children via a `slot` integer, mirroring the corpus's `Coach Slot` column:

```sql
CREATE TABLE IF NOT EXISTS public.coach_team_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  coach_id                uuid NOT NULL REFERENCES public.coaches(id) ON DELETE CASCADE,
  player_id               uuid REFERENCES public.players(id) ON DELETE SET NULL,
  slot                    integer NOT NULL DEFAULT 1,
  child_name              text,
  child_gender            text,
  child_birth_date        date,
  playing_up              boolean NOT NULL DEFAULT false,
  preferred_co_coach_name text,
  preferred_co_coach_id   uuid REFERENCES public.coaches(id) ON DELETE SET NULL,
  ...
  UNIQUE (coach_id, slot)
);
```

**Divisions** carry the format string and the age band:

```sql
-- 20260331000000_definitive_schema.sql:282-296
CREATE TABLE IF NOT EXISTS public.divisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    season_settings_id  uuid NOT NULL REFERENCES public.season_settings(id) ON DELETE CASCADE,
    name                text NOT NULL,
    gender_policy       gender_policy_enum DEFAULT 'coed',
    max_roster_size     integer,
    play_format         text,
    format              text,
    season_start        date,
    season_end          date,
    ...
    UNIQUE (season_settings_id, name)
);
```

Later migrations add `min_age`, `max_age`, `birthdate_start`, `birthdate_end`
(`20260530000000_...:27-31`) and `min_roster_size`, `target_team_size`, `team_count_override`,
`min_teams`, `max_teams` (`20260502001000_division_roster_constraints.sql:3-8`).

`play_format` is consumed in exactly one place — roster sizing:

```js
// packages/core/src/rosterSizing.js:9-30
export function parsePlayableCount(playFormat) {
  ...
  const match = trimmed.match(/(\d+)\s*v\s*(\d+)/i);
  ...
  return playable;
}
```

It never reaches the scheduler. There is no per-format duration anywhere in the repo.

**Field availability** (`20260522120000_field_availability_phase1.sql`) is the closest thing to a
permit model:

```sql
-- 20260522120000_field_availability_phase1.sql:27-55
CREATE TABLE IF NOT EXISTS public.field_availability_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  season_settings_id uuid REFERENCES public.season_settings(id) ON DELETE SET NULL,
  season_label text NOT NULL,
  field_id uuid REFERENCES public.fields(id) ON DELETE SET NULL,
  location text NOT NULL,
  field_name text NOT NULL,
  surface_type text,
  record_status text NOT NULL DEFAULT 'active' CHECK (record_status IN ('active','inactive','potential','conditional','excluded')),
  approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('approved','pending','not_approved','not_applicable')),
  available_from date NOT NULL,
  available_until date NOT NULL,
  availability_rule text,
  teams_per_hour integer CHECK (teams_per_hour IS NULL OR teams_per_hour > 0),
  aggregate_teams_per_hour integer CHECK (aggregate_teams_per_hour IS NULL OR aggregate_teams_per_hour > 0),
  capacity_basis text CHECK (capacity_basis IS NULL OR capacity_basis IN ('per_field','aggregate','mixed','unknown')),
  lighted boolean,
  ...
  CONSTRAINT field_availability_profiles_date_check CHECK (available_until >= available_from)
);

-- :72-81
CREATE TABLE IF NOT EXISTS public.field_blackout_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.field_availability_profiles(id) ON DELETE CASCADE,
  blackout_from date NOT NULL,
  blackout_until date NOT NULL,
  reason text,
  ...
);
```

The `field_id` line above is quoted from `20260522120000` and is **no longer the live action**:
`20260909000000_rollback_field_import_booking_guard.sql` (LIVE-3) changes it to `ON DELETE CASCADE`,
matching `field_blackouts.field_id`, so deleting a field destroys its availability profile and the
four tables keyed on that profile rather than leaving the profile describing ground that no longer
exists. The column stays nullable only for rows predating that migration and `20260908000000`; no
current write path produces a field-less profile.

Availability is **date-range granular, not time-of-day granular**, and there is no per-date
override row (a blackout is a date range, not "this venue opens at 5 PM on 08/22"). Sibling tables:
`field_availability_profile_formats` (`:61-70`, a format code per profile), `field_equipment_requirements`
(`:83-91`), `field_availability_scenarios` / `_scenario_members` (`:93-112`, mutually-exclusive
what-if sets). **Nothing in `packages/core/src/` or the Edge Functions reads any of these tables** —
verified by grep for the table names across `packages/`, `frontend/src/`, and
`supabase/functions/`; the only consumers are the field-import RPCs and
`frontend/src/pages/FieldManagementPage.jsx` / `BlackoutsPage.jsx`.

**Run and audit bookkeeping:**

```sql
-- 20260331000000_definitive_schema.sql:784-799
CREATE TABLE IF NOT EXISTS public.scheduler_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    season_id           uuid REFERENCES public.season_settings(id) ON DELETE SET NULL,
    season_settings_id  uuid REFERENCES public.season_settings(id) ON DELETE CASCADE,
    run_type            text NOT NULL CHECK (run_type IN ('team', 'practice', 'game')),
    status              text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'completed_with_warnings', 'needs_manual_review', 'failed')),
    parameters          jsonb DEFAULT '{}'::jsonb,
    metrics             jsonb DEFAULT '{}'::jsonb,
    results             jsonb DEFAULT '{}'::jsonb,
    created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    started_at          timestamptz,
    completed_at        timestamptz,
    ...
);
```

Plus `evaluation_runs` (`:815-831`), `evaluation_findings` (`:839-851`), `evaluation_metrics`
(`:853-864`), `evaluation_run_events` (`:866-879`), and `audit_log` (`:881-901`, whose `action`
column became an FK to an `audit_actions` lookup in `20260613000006_audit_actions_lookup.sql`).

### 1.5 Relationships, in one picture

```text
organizations ─┬─ profiles ── organization_members
               ├─ season_settings ─── divisions ─┬─ teams ─┬─ team_players ── players
               │                                 │         └─ coaches (coach_id, assistant_coach_ids[])
               │                                 └─ game_slots.division_id (optional restriction)
               ├─ locations ── fields ─┬─ field_subunits          (unused by games)
               │                       ├─ practice_slots ── practice_assignments
               │                       ├─ game_slots ─┬─ game_assignments   (scheduler output)
               │                       │              └─ games              (legacy, 1:1 UNIQUE)
               │                       └─ field_availability_profiles ── field_blackout_windows
               │                                                     └─ *_scenario_members
               ├─ coaches ── coach_team_requests ── players
               ├─ players ── player_buddies
               ├─ scheduler_runs ── evaluation_runs ── evaluation_findings / _metrics / _events
               ├─ imports / import_jobs / staging_players / staging_import_rows
               ├─ export_jobs ── email_log
               └─ audit_log ── audit_actions
```

The engine's join key to all of this is `Team.division`, a **free-text label**, not
`divisions.id`. `frontend/src/pages/GameSchedulingPage.jsx:60-73` shows the coercion:

```js
function normalizeTeam(team) {
  const id = team?.id ?? team?.teamId;
  if (!id) return null;
  const divisionId = team.divisionId ?? team.division_id ?? null;
  const division =
    team.division ?? team.divisionName ?? team.divisions?.name ?? divisionId ?? 'Unassigned';
  ...
}
```

**Inferred:** this label-based join is the same class of coupling that produced incident #4 in
`fixtures/season-2026/README.md` (a team-name format change silently zeroing a validator's join).

### 1.6 Can the current model represent the season-2026 corpus?

The corpus (`fixtures/season-2026/README.md`) requires eight capabilities. Assessed against the
model above:

| Corpus capability                                  | Representable today?                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venue → parent/child sub-fields                    | **Partly.** `locations → fields → field_subunits` is the right shape, but `field_subunits` is label-only (`:347-355`) and `game_slots.field_id` points at `fields`, never at a subunit. A "Pitch 1A" would have to be modeled as a sibling `fields` row, losing the parent link.                                                                      |
| Spatial overlap between fields                     | **No.** No adjacency/overlap table, column, or engine concept exists. `gameMetrics.detectConflicts` keys field collisions on the raw `fieldId` string (`packages/core/src/gameMetrics.js:147-156, 402-427`), so Pitch 1A vs Pitch 2 never collide.                                                                                                    |
| Per-format durations, play time vs field occupancy | **No.** Duration is whatever `slot.end - slot.start` happens to be. `divisions.play_format` is parsed only for roster size (`packages/core/src/rosterSizing.js:9-30`). No halves, halftime, occupancy, block, or turnover field exists anywhere.                                                                                                      |
| Per-venue-per-date permit windows                  | **No.** `field_availability_profiles.available_from/until` + `field_blackout_windows` are date ranges only — no clock times, no per-date exception rows, and no engine reads them.                                                                                                                                                                    |
| Constraint records with hardness levels            | **No.** Constraints are hard-coded control flow. `hasCoachConflict` (`packages/core/src/gameScheduling.js:665-678`) is an unconditional filter; `computeConsistencyScore` (`:650-663`) is a soft preference. Neither is a record, and hardness is not a value.                                                                                        |
| Waivers                                            | **No.** Nothing resembling an exception record with a lifecycle. The nearest analogue is `evaluation_run_events.event_type = 'manual_override'` (`:866-879`), which is an event log, not a standing rule.                                                                                                                                             |
| Person-centric coach timelines                     | **No.** Coach conflict is computed pairwise from the two teams in a matchup, via `team.coachId` only (`packages/core/src/gameValidation.js:63-84`; `packages/core/src/gameMetrics.js:132-144`). Assistants (`teams.assistant_coach_ids`) are never consulted. There is no cross-domain (games + practices + scrimmages + external) personal timeline. |
| Placeholder / TBD fixtures                         | **No.** `AssignmentSchema` requires truthy `homeTeamId` and `awayTeamId` (`packages/core/src/schemas/index.js:50-51`); `games.home_team_id`/`away_team_id` are `NOT NULL` FKs to `teams` (`:588-589`). Unplaceable matchups exist only as a transient in-memory `unscheduled[]` array (§2.1) that is never persisted.                                 |

Two further corpus shapes with no home in the model: **external opponents** ("Visiting Club A -
U14G North" in `fixtures/season-2026/external_fixtures_published.csv`) cannot be an `away_team_id`,
and **non-game field occupancy** (the scrimmage and field-reservation rows in
`combined_schedule.csv`) has no event type — `games` has no kind/type column.

---

## 2. The scheduling / solver path

### 2.1 Games: entry point and algorithm

There is no server-side game solver. Game scheduling runs **entirely in the browser**.

Entry point: `frontend/src/pages/GameSchedulingPage.jsx:399-474` (`handleAutoGenerate`):

```js
const roundRobinByDivision = buildRoundRobinByDivision(schedulerTeams);
const start = performance.now();
const result = scheduleGames({
  teams: schedulerTeams,
  slots: gameSlots,
  roundRobinByDivision,
});
const evaluation = evaluateGameSchedule({ ... });
```

`buildRoundRobinByDivision` (`:108-126`) buckets teams by their division label and calls
`generateRoundRobinWeeks` per bucket.

**Stage 1 — round robin.** `packages/core/src/gameScheduling.js:15-83`. Circle method with a `BYE`
sentinel for odd counts. It emits exactly `n - 1` weeks:

```js
// packages/core/src/gameScheduling.js:36-39
const totalTeams = rotation.length;
const weeks = totalTeams - 1;
const half = totalTeams / 2;
```

Home/away is not a decision — it is alphabetical:

```js
// packages/core/src/gameScheduling.js:57-58
const ordered = [home, away].sort((a, b) => a.localeCompare(b));
matchups.push({ homeTeamId: ordered[0], awayTeamId: ordered[1] });
```

**Stage 2 — greedy slot allocation.** `scheduleGames` at
`packages/core/src/gameScheduling.js:101-199`. Single pass, no backtracking, no repair, no
optimizer. It walks divisions → weeks → matchups in insertion order and calls `scheduleMatchup`
(`:309-456`) for each.

Slots are indexed by `indexSlots` (`:220-289`), which imposes the model's central temporal
assumption:

```js
// packages/core/src/gameScheduling.js:232-238
if (
  typeof slot.weekIndex !== 'number' ||
  !Number.isInteger(slot.weekIndex) ||
  slot.weekIndex <= 0
) {
  throw new TypeError(`slot ${slot.id} must include a positive integer weekIndex`);
}
```

Slots are partitioned into `divisionSlots` (slots with a `division`) and `sharedSlots` (without),
keyed `${division ?? '*'}::${weekIndex}` (`:257-261`).

`scheduleMatchup` rejects a matchup outright — pushing to `unscheduled[]` with a reason — in five
cases (`:334-401`): `unknown-team`, `division-mismatch`, `duplicate-matchup` (either team already
has a game that `weekIndex`), `coach-coaches-both-teams`, and then whatever
`selectSlotForMatchup` could not place (`coach-scheduling-conflict` or `no-slot-available`).

The one-game-per-team-per-week guard and the shared-coach rejection are both worth quoting, since
both bite on real data:

```js
// packages/core/src/gameScheduling.js:357-377
const teamWeekKeyHome = `${homeTeamId}::${weekIndex}`;
const teamWeekKeyAway = `${awayTeamId}::${weekIndex}`;
if (teamWeekAssignments.has(teamWeekKeyHome) || teamWeekAssignments.has(teamWeekKeyAway)) {
  unscheduled.push({
    weekIndex,
    division,
    matchup: { homeTeamId, awayTeamId },
    reason: 'duplicate-matchup',
  });
  return;
}

if (homeTeam.coachId && homeTeam.coachId === awayTeam.coachId) {
  unscheduled.push({
    weekIndex,
    division,
    matchup: { homeTeamId, awayTeamId },
    reason: 'coach-coaches-both-teams',
  });
  return;
}
```

**Stage 3 — slot selection.** `selectSlotForMatchup` (`:458-648`). Division-restricted slots are
tried first and, if any qualifies, shared slots are never considered (`:545-547`). Within each
pool, candidates that fail capacity or `hasCoachConflict` are skipped, and the rest are ranked by a
hand-rolled lexicographic comparison chain.

### 2.2 The objective function — there isn't one, for games

`scheduleGames` optimizes nothing. Slot choice is a **lexicographic tie-break ladder** evaluated
greedily, with different ladders for the two pools:

- Division-restricted pool (`:515-542`): `priority` desc → `consistencyScore` desc → `start` asc →
  `fieldId` asc → `slotId` asc.
- Shared pool (`:590-644`): `priority` desc → per-division slot `usage` asc → per-division
  `fieldUsage` asc → `consistencyScore` desc → `start`/`fieldId`/`slotId` asc.

`priority` is `slot.priority ?? 1` (`:252`), fed from `fields.priority_rating` by the page
(`frontend/src/pages/GameSchedulingPage.jsx:104`). The only genuinely soft preference is
consistency of kickoff time for a team across weeks:

```js
// packages/core/src/gameScheduling.js:650-663
function computeConsistencyScore({ teamStartPreferences, teamIds, slotRecord }) {
  const startKey = getStartTimeKey(slotRecord.start);
  let score = 0;
  for (const teamId of teamIds) {
    if (!teamId) continue;
    const record = teamStartPreferences.get(teamId);
    if (record?.preferredKey === startKey) score += 1;
  }
  return score;
}
```

```js
// packages/core/src/gameScheduling.js:774-778
function getStartTimeKey(date) {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
```

Note the UTC bucketing: a club in a DST-observing zone gets its consistency key shifted by an hour
across the DST boundary mid-season.

The only hard constraint applied during selection is coach overlap:

```js
// packages/core/src/gameScheduling.js:665-678
function hasCoachConflict({ coachAssignments, coaches, start, end }) {
  for (const coachId of coaches) {
    if (!coachId) continue;
    const assignments = coachAssignments.get(coachId) ?? [];
    for (const assignment of assignments) {
      if (start < assignment.end && end > assignment.start) return true;
    }
  }
  return false;
}
```

`coachAssignments` is built up during this run only (`recordCoachAssignment`, `:680-688`). It
starts empty every time and knows nothing about practices, scrimmages, or any commitment not
produced by this same call.

### 2.3 Practices: the one place a real optimizer exists

`packages/core/src/practiceScheduling.js:77` (`schedulePractices`) is a greedy scorer with an
explicit, tunable weight vector — the closest thing in the repo to a declared objective:

```js
// packages/core/src/practiceScheduling.js:34-41
const DEFAULT_SCORING_WEIGHTS = {
  coachPreferredSlot: 10,
  coachPreferredDay: 5,
  divisionPreferredDay: 3,
  divisionSaturationPenalty: 4,
  divisionDaySaturationPenalty: 2,
};
```

It also has repair machinery games lack: `attemptResolveUnassignedTeams` (`:560`) and
`tryResolveTeamWithSwap` (`:611`).

On top of it sits a **hill-climbing optimizer**, `packages/core/src/autoScheduler.js:425-609`
(`optimizePracticeSchedule`): seeded mulberry32 PRNG (`:29-37`), wall-clock budget, iteration cap,
stall-triggered random restarts:

```js
// packages/core/src/autoScheduler.js:75-83
const DEFAULT_CONFIG = {
  timeBudgetMs: 25000,
  maxIterations: 2000,
  stallLimit: 80,
  maxRestarts: 5,
  seed: 42,
  progressInterval: 50,
  onProgress: null,
};
```

Mutations are `swap`, `relocate`, `chain-swap` (`mutate`, `:245-404`), each re-checked against
`checkHardConstraints` (`:155-180` — capacity, coach unavailability list, coach time overlap).
Locked assignments are excluded from the mutable set:

```js
// packages/core/src/autoScheduler.js:194-201
for (const a of result.assignments) {
  assignmentMap.set(a.teamId, a.slotId);
  if (a.source === 'locked') {
    lockedTeams.add(a.teamId);
  } else {
    autoTeams.push(a.teamId);
  }
}
```

The scalar objective:

```js
// packages/core/src/autoScheduler.js:102-137
export function computeFitness(evaluation) {
  const { summary, coachConflicts, fairnessConcerns, slotUtilization } = evaluation;
  const coverage = summary.totalTeams > 0 ? summary.assignedTeams / summary.totalTeams : 1;
  const conflictPenalty = Math.min(1, (coachConflicts?.length ?? 0) * 0.25);
  const fairnessIssues = fairnessConcerns?.length ?? 0;
  const fairnessScore = Math.max(0, 1 - fairnessIssues * 0.15);
  // ... utilBalance = 1 - stdDev(utilization rates) ...
  const followUpScore = Math.max(0, 1 - (summary.manualFollowUpRate ?? 0));
  return (
    coverage * 0.3 +
    (1 - conflictPenalty) * 0.25 +
    fairnessScore * 0.25 +
    utilBalance * 0.1 +
    followUpScore * 0.1
  );
}
```

A **second, different** optimizer exists server-side in
`supabase/functions/auto-scheduler/index.ts` (798 lines) with its own PRNG (`:100-108`), its own
`checkHardConstraints` (`:120-135`), and a fitness function that does not match the core one:

```ts
// supabase/functions/auto-scheduler/index.ts:155-165
const coverage = summary.assignedTeams / totalTeams;
const conflictPenalty = Math.min(1, (coachConflicts?.length ?? 0) * 0.15);
const coveragePenalty = 1 - coverage;
const fairnessScore = 1 - (conflictPenalty * 0.15 + coveragePenalty * 0.5);
```

Different coefficients, different terms, no fairness-concern or utilization component. Both are
reachable — `frontend/src/hooks/useAutoScheduler.js` drives the Edge Function path;
`packages/core/src/autoScheduler.js` is exercised by `tests/autoScheduler.test.js`.

### 2.4 How a schedule reaches the database

```text
GameSchedulingPage.handleAutoGenerate
  → generateRoundRobinWeeks + scheduleGames + evaluateGameSchedule   (browser, pure)
  → setReviewAssignments(...)                                        (staged in React state)
  → [optional] drag-and-drop edits (handleDragEnd, :643-681)         (staged, unvalidated)
  → persistGameScheduleReview(...)                                   frontend/src/utils/gamePersistenceClient.js:14
  → POST GAME_PERSISTENCE_URL with { snapshot, overrides, runMetadata }
  → supabase/functions/game-persistence/index.ts                     JWT + rate limit + Zod + org check
  → supabaseClient.rpc('persist_game_schedule', { run_data, assignments })   (:162)
  → scheduler_runs row + game_assignments rows                       20260503030000_repair_game_persistence_rpc.sql:129+
  → recordAudit(...)                                                 (:370)
```

The snapshot is packaged by `packages/core/src/gamePersistenceSnapshot.js` and the server-side
orchestration mirrors it in `packages/core/src/gamePersistenceApi.js:23-57` and
`gamePersistenceHandler.js`:

```js
// packages/core/src/gamePersistenceHandler.js:40-55
export async function persistGameSnapshotTransactional(params) {
  const { snapshot, runMetadata = {} } = params;
  const { runId: snapshotRunId } = normalizeSnapshot(snapshot);
  const effectiveRunMetadata = { ...runMetadata, runId: runMetadata.runId ?? snapshotRunId };

  return persistSnapshotTransactional({
    ...params,
    runMetadata: effectiveRunMetadata,
    runType: 'game',
    rpcName: 'persist_game_schedule',
    transformPayload: ({ snapshot, runData }) => ({
      run_data: runData,
      assignments: snapshot.payload.assignmentRows ?? snapshot.payload.gameRows ?? [],
    }),
  });
}
```

The generic engine underneath is `packages/core/src/persistenceHandler.js`:
`authorizePersistenceRequest` (`:36-59`), `validateSnapshot` (`:68-79`),
`handlePersistenceRequest` (`:93-129`, which **blocks** persistence while any override is
`pending`), and `persistSnapshotTransactional` (`:153-202`, which builds the `scheduler_runs`
payload and calls the RPC). The same three-function shape is reused for practices
(`persist_practice_schedule`) and teams (`persist_team_schedule`) —
`supabase/functions/practice-persistence/index.ts:145`,
`supabase/functions/team-persistence/index.ts:118`.

Read-back is via `frontend/src/hooks/useSchedulerRun.js:15-50`, which fetches the latest
`scheduler_runs` row of a given `run_type` with `status = 'completed'`, scoped to the active org and
season, and hands it to a mapper (`packages/core/src/utils/gameSummaryMapper.js` and siblings).

There is a direct-table writer too — `packages/core/src/gameSupabase.js:81-114`
(`persistGameAssignments`, `insert` or `upsert` into `game_assignments`) — which contradicts
`CLAUDE.md`'s "RPC Enforcement" rule. **Inferred:** it predates the RPC layer;
`tests/gameSupabase.test.js` covers it, but no frontend code calls it.

---

## 3. The validation path

Validation happens in five distinct layers that do not share a definition of "valid".

### 3.1 Zod, at engine entry

- `scheduleGames` → `indexTeams` runs `TeamSchema.parse(team)` (`packages/core/src/gameScheduling.js:208`)
  and `indexSlots` runs `SlotSchema.parse(slot)` (`:230`).
- `evaluateGameSchedule` runs `TeamSchema.parse` (`packages/core/src/gameMetrics.js:41`) and
  `AssignmentSchema.parse` per assignment (`:69`).
- `generateTeams` runs `PlayerSchema.parse` per player (`packages/core/src/teamGeneration.js:154`).
- `schedulePractices` / `evaluatePracticeSchedule` import the same `SlotSchema` / `TeamSchema`
  (`packages/core/src/practiceScheduling.js:1`, `practiceMetrics.js:1`).

Everything else — `TypeError` guards on array-ness, positive `weekIndex`, duplicate slot ids
(`gameScheduling.js:240-242`) — is hand-written.

### 3.2 Post-hoc evaluation: `evaluateGameSchedule`

`packages/core/src/gameMetrics.js:16-227`. This is the real correctness check for games. It
produces `{ summary, warnings }` and detects three classes of collision through one generic helper:

```js
// packages/core/src/gameMetrics.js:185-205
detectConflicts({
  assignmentsMap: teamAssignments,
  warnings,
  idKey: 'teamId',
  warningType: 'team-double-booked',
  messageFn: (id) => `Team ${id} has overlapping games`,
});
detectConflicts({
  assignmentsMap: coachAssignments,
  warnings,
  idKey: 'coachId',
  warningType: 'coach-conflict',
  messageFn: (id) => `Coach ${id} has overlapping games across teams`,
});
detectConflicts({
  assignmentsMap: fieldAssignments,
  warnings,
  idKey: 'fieldId',
  warningType: 'field-overlap',
  messageFn: (id) => `Field ${id} has overlapping games`,
});
```

```js
// packages/core/src/gameMetrics.js:402-427
function detectConflicts({ assignmentsMap, warnings, idKey, warningType, messageFn }) {
  for (const [id, assignments] of assignmentsMap.entries()) {
    if (idKey === 'fieldId' && id === 'unassigned') continue;
    assignments.sort((a, b) => a.start - b.start || a.slotId.localeCompare(b.slotId));
    for (let i = 1; i < assignments.length; i += 1) {
      const prev = assignments[i - 1];
      const curr = assignments[i];
      if (curr.start < prev.end) {
        warnings.push({ type: warningType, message: messageFn(id), details: { ... } });
        break;           // <- only the FIRST conflict per id is reported
      }
    }
  }
}
```

Two behaviours to know: it `break`s after the first conflict per id (so a coach with four
overlapping games reports one warning), and field collision is keyed on the literal `fieldId`
string, so two physically overlapping fields never collide.

It additionally emits `shared-slot-imbalance` warnings when a shared field's per-division game
counts spread by more than 1 (`:291-320`) and an `unscheduled-matchups` warning summarizing the
`unscheduled[]` reasons (`:207-224`).

### 3.3 Aggregation: `runScheduleEvaluations`

`packages/core/src/evaluationPipeline.js:71-259` merges the practice and game evaluations into a
flat `issues[]` with a severity, then derives a tri-state status:

```js
// packages/core/src/evaluationPipeline.js:234-247
const errorTypes = new Set([
  'team-double-booked',
  'coach-conflict',
  'field-overlap',
  'unscheduled-matchups',
]);
for (const warning of gameResult.warnings) {
  issues.push({
    category: 'games',
    severity: errorTypes.has(warning.type) ? 'error' : 'warning',
    message: warning.message,
    details: warning.details,
  });
}
```

```js
// packages/core/src/evaluationPipeline.js:261-269
function determineStatus(issues) {
  if (issues.some((issue) => issue.severity === 'error')) return 'action-required';
  if (issues.length > 0) return 'attention-needed';
  return 'ok';
}
```

### 3.4 Drag-time validation — written, tested, and not connected

`packages/core/src/gameValidation.js` exports `checkSlotAvailability` (`:26-42`),
`checkCoachConflict` (`:58-100`), and `validateGameMove` (`:117-157`), documented as "the primary
entry point for dragOver validation in the GameScheduleGrid" (`:102-105`).

Grepping the whole tree for `gameValidation` returns only the module itself,
`tests/gameValidation.test.js`, and three documentation files. The actual drop handler applies the
move with no validation at all:

```js
// frontend/src/pages/GameSchedulingPage.jsx:658-681 (abridged)
const updatedAssignment = {
  ...currentAssignment,
  fieldId: targetFieldId,
  slotId: targetSlotId,
  gameSlotId: targetSlotId,
  start: targetSlot?.start ?? currentAssignment.start,
  end: targetSlot?.end ?? currentAssignment.end,
  weekIndex: targetSlot?.weekIndex ?? currentAssignment.weekIndex,
  assignmentSource: 'manual',
};
const staged = sourceAssignments.map((assignment) =>
  String(assignment.id) === String(active.id) ? updatedAssignment : assignment
);
setReviewAssignments(staged);
```

Conflict highlighting in the grid comes from the _previous_ run's warnings, not from the staged
edit:

```js
// frontend/src/pages/GameSchedulingPage.jsx:354-361
const conflictSet = useMemo(() => {
  const ids = new Set();
  (game?.warnings ?? []).forEach((warning) => {
    (warning.details?.conflicts ?? []).forEach((assignment) => {
      if (assignment?.id) ids.add(assignment.id);
    });
  });
  return ids;
}, [game?.warnings]);
```

**Inferred:** an illegal manual move is caught only after persistence, when a later
`evaluateGameSchedule` run is displayed — or not at all, if the page is not regenerated.

### 3.5 Roster (non-schedule) validation

`frontend/src/hooks/useConflicts.js:13-134` detects buddy separation, invalid buddy requests,
gender mismatch, and unsanctioned play-up/play-down against team age bounds. It is roster
validation, not schedule validation, and reads buddies through the canonical helper
(`:36`, `getCanonicalBuddyId`).

### 3.6 Server-side validation

- **Edge Function boundary** — JWT extraction, org-membership verification, rate limiting, and a
  Zod payload schema: `supabase/functions/game-persistence/index.ts:38-68`, `:213`
  (`checkRateLimit`), shared helpers in `supabase/functions/_shared/auth.ts` and `rateLimit.ts`.
- **RPC** — `persist_game_schedule`
  (`20260503030000_repair_game_persistence_rpc.sql:129-137`, `SECURITY DEFINER SET search_path =
public`) declares a battery of validation counters before writing:
  `v_missing_home_count`, `v_missing_away_count`, `v_missing_slot_count`, `v_missing_week_count`,
  `v_invalid_time_count`, `v_invalid_source_count`, `v_same_team_count`, plus cross-tenant
  reference checks (`v_cross_home_ref`, `v_cross_slot_ref`, …) at `:151-168`.
- **Schema constraints** — `game_assignments_slot_alias_match` (`:99-106`),
  `game_assignments_matchup_slot_week_unique`, and `games_team_difference` (`:600`).
- **Import** — `supabase/functions/import-validation/index.ts` (708 lines): row cap `MAX_ROWS =
5000`, `MAX_STRING_LENGTH = 500`, `MAX_PAYLOAD_BYTES = 10 MB` (`:27-29`), HTML/control-char
  stripping (`:32-42`), and a per-type required-field map (`:46-58`).

---

## 4. Persistence and I/O

### 4.1 Storage

PostgreSQL via Supabase; 108 migrations in `supabase/migrations/`. Two are the ones to read first:

- `20251208000000_consolidated_schema.sql` — the original consolidation (superseded).
- `20260331000000_definitive_schema.sql` — the current baseline, 35 tables, all with RLS.

Everything after `20260331` is incremental: RLS hardening, RPC additions, import pipeline, field
availability, coach leads, CRUD RPCs. Migrations with a schema effect are paired with revert and
smoke scripts under `docs/sql/` (per `CLAUDE.md`'s Definition of Done); that pairing exists for
seven of them (`docs/sql/*_revert.sql` / `*_smoke.sql`).

All writes of scheduler state go through `SECURITY DEFINER` RPCs (`persist_team_schedule`,
`persist_practice_schedule`, `persist_game_schedule`) invoked from Edge Functions. Reads go direct
from the browser through RLS-gated `supabase.from(...)` calls
(`frontend/src/hooks/useGameSlots.js:21`, `useSchedulerRun.js:45-50`, etc.).

The client is swapped at import time: `frontend/src/lib/supabaseClient.js` returns either the real
`@supabase/supabase-js` client or `frontend/src/lib/mockSupabaseClient.js` (a sessionStorage-backed
in-memory fake) when `VITE_USE_MOCK_SUPABASE=true` or credentials are absent. All E2E tests run
against the mock.

### 4.2 Import

Flow: browser CSV → PapaParse → sensitive-column filter → header matching → Edge validation →
staging tables → idempotent finalize RPC.

- `frontend/src/utils/gotsportCanonicalizer.js` strips sensitive columns **client-side before
  upload** ("medical, insurance, financial / payment, identity documents, waivers / signatures",
  `:1-15`) and dedupes repeated GotSport headers via
  `makeDedupeHeaderTransformer` (`:34-47`) — GotSport repeats "Playing Up" and "Preferred
  Co-Coach" once per coached child.
- `frontend/src/utils/importHeaders.js:19-24` declares the canonical required columns:

  ```js
  export const REQUIRED_HEADERS = {
    players: ['first_name', 'last_name', 'date_of_birth'],
    coaches: ['full_name', 'email'],
    fields: ['location', 'name', 'type', 'start', 'end'],
    field_availability: ['season_label', 'location', 'name', 'available_from', 'available_until'],
  };
  ```

  A near-duplicate of the same map lives server-side at
  `supabase/functions/import-validation/index.ts:46-58` (with `field_name` instead of `name` for
  field availability).

- Staging: `staging_players` (`20260331000000_definitive_schema.sql:721-731`),
  `staging_import_rows` and `import_application_records`
  (`20260503060000_coach_import_apply_rollback.sql:35, :62`) — the latter enabling per-import
  rollback.
- Finalize: `20260502000000_import_finalize_pipeline.sql`,
  `20260726000300_finalize_import_reimport_coalesce.sql` (41 KB — re-import COALESCEs rather than
  overwrites), `20260611000200_import_gotsport_expanded_mapping.sql`,
  `20260603190000_import_division_from_age_group.sql`.
- Import types are constrained to four: `CHECK (import_type IN ('players', 'coaches', 'fields',
'field_availability'))` (`20260522120000_field_availability_phase1.sql:3-5`). **There is no
  import path for a schedule.**

### 4.3 Export

Two mechanisms, both CSV, both client-generated:

`packages/core/src/outputGeneration.js` (`generateScheduleExports`) flattens practices and
games into one row-per-team-per-event table. Since 8.2 the coach columns are `Coaches` and
`Coach Emails` — every coach on the team, `; `-separated and positionally aligned, in the club's
declared order, produced once by `people/coachList.js` for this export and the reserve /
TIME TBD publication alike. There is no `Coach Name` / `Assistant Coaches` split: that shape
asserted a head-coach role the model does not carry (see `packages/core/src/people/coachList.js`).

```js
// packages/core/src/outputGeneration.js
const HEADERS = {
  TEAM_ID: 'Team ID',
  TEAM_NAME: 'Team Name',
  DIVISION: 'Division',
  COACHES: 'Coaches',
  COACH_EMAILS: 'Coach Emails',
  EVENT_TYPE: 'Event Type',
  OPPONENT: 'Opponent',
  ROLE: 'Role',
  START: 'Start',
  END: 'End',
  FIELD: 'Field',
  SLOT: 'Slot',
  NOTES: 'Notes',
};
```

Games produce two rows (Home and Away, `:124-140`); RFC-ish CSV escaping is in `formatCsv`
(`:255-269`) and `escapeCsvValue` (`:271-285`). Timestamps are `toISOString()` unless a timezone is
supplied, in which case `date.toLocaleString('en-US', { timeZone })` (`:229-238`) — an en-US
locale string, not a stable machine format.

`frontend/src/components/OutputGenerationPanel.jsx:242-280` calls it, uploads to Supabase Storage,
and offers a client-side `Blob` download (`:307-315`). `export_jobs`
(`20260331000000_definitive_schema.sql:746-767`) records job type (`'master' | 'team'`), status,
`storage_path`, and `schema_version`.

### 4.4 External sync

The only outbound integration is the ICS calendar feed:
`supabase/functions/calendar-feed/index.ts` (220 lines). Public, unauthenticated, keyed on
`teams.calendar_token` (added by `20251218000000_calendar_sync.sql`), with a service-role client to
bypass RLS (`:44`), expiry enforcement (`:59-67`, from
`20260324000002_calendar_token_expiry.sql`), and ICS header-injection sanitization (`:5-10`).
Timezone defaults to `'America/New_York'` when the org has no `season_settings.timezone`
(`:74`).

There is no inbound sync of any kind: no league-fixture import, no calendar subscription, no
webhook.

---

## 5. Test coverage

### 5.1 How to run it

```bash
npm run test              # Vitest unit + integration (jsdom); vitest.config.js
npm run test:watch
npm run test:coverage     # v8 coverage with thresholds
npm run test:e2e          # bddgen && playwright test
npm run test:e2e:ui
npm run typecheck         # tsc --noEmit
npm run lint
npm run frontend:build
npm run check:bundle      # scripts/check-bundle-size.js
npm run check:advisors    # scripts/advisor-lint.js
npm run test:db           # supabase test db (pgTAP; requires a local Supabase stack)
```

CI (`.github/workflows/ci.yml`) runs typecheck → lint → test → build → check:bundle →
check:advisors → E2E with `--workers=1`.

### 5.2 What the suite actually contains

Measured by running `npx vitest run` in this working tree:

```text
Test Files  136 passed | 1 skipped (137)
     Tests  848 passed | 34 skipped | 6 todo (888)
  Duration  48.51s
```

Coverage is scoped and thresholded in `vitest.config.js:27-38`:

```js
coverage: {
  provider: 'v8',
  include: ['packages/core/src/**', 'frontend/src/hooks/**'],
  exclude: ['**/node_modules/**', 'tests/**'],
  thresholds: { statements: 60, branches: 50, functions: 55, lines: 60 },
},
```

Note the include list: **`frontend/src/components/**`and`frontend/src/pages/**` are outside the
coverage scope entirely**, and `supabase/functions/**` is too.

### 5.3 What is well covered

Every core scheduling module has a dedicated test file: `tests/gameScheduling.test.js`,
`gameMetrics.test.js`, `gameValidation.test.js`, `autoScheduler.test.js`,
`practiceScheduling.test.js`, `practiceSchedulingTimezone.test.js`, `practiceSlotExpansion.test.js`,
`practiceMetrics.test.js`, `evaluationPipeline.test.js`, `outputGeneration.test.js`,
`teamGeneration.test.js` (+ `.characterization`, `Incremental`, `Seed` variants),
`coachContinuity.test.js`, `coachLinking.test.js`, `buddyLinking.test.js`, `playUp.test.js`,
`rosterSizing.test.js`, `ageGroups.test.js`, `teamSnapshot.test.js`, `teamDelta.test.js`.

The persistence layer is covered end-to-end in mock form: `persistRoundTrip.test.js`,
`gamePersistenceApi/Client/Handler.test.js` and the practice/team equivalents,
`verifyRpcUsage.test.js`, `mockCrudRpcs.test.js`, `mockFacilityRpcs.test.js`.

The Deno scoring engine has its own test (`tests/unit/scoring-engine.test.ts`, plus
`supabase/functions/_shared/tests/scoring-engine_test.ts`).

E2E: 22 Gherkin features under `tests/e2e/features/` and 18 step files, covering onboarding,
RBAC/multi-tenancy, the auto scheduler, facility management, ingestion hardening, calendar sync,
network resilience, and visual/accessibility passes.

Shared factories (`tests/factories/`: organization, player, run, scheduling, season, team, user,
audit) and helpers (`tests/helpers/`: `createChainMock`, `mockSupabaseShape`,
`renderWithProviders`, `seedMockDb`) exist and are barrel-exported.

### 5.4 What is not covered

- **The `fixtures/season-2026/` corpus is not referenced by any test, script, or workflow.**
  Grepping `tests/`, `scripts/`, and `.github/` for `season-2026` returns nothing. Its
  known-good invariants (567 rec games, 132 teams, round-robin completeness, sunset margins,
  overlap-pair exclusivity, 120-minute 11v11 kickoff spacing, publication parity) are currently
  asserted by nobody.
- **No regression test asserts schedule stability across reruns.** There is no fixture that runs
  the solver twice and diffs the output. Incident #1 in the corpus README (366 of 679 games moving
  silently) has no guard.
- **Field-overlap, permit-window, sunset, and duration correctness are untestable** — the concepts
  do not exist to assert on (§1.6).
- **`frontend/src/pages/**`and`frontend/src/components/**` are outside coverage thresholds**, so
  the drag-and-drop path (the one place a human directly edits a schedule) has no coverage floor.
  Component tests do exist (`GameScheduleGrid.test.jsx`, `GameCard.test.jsx`,
  `TimeSlotDropZone.test.jsx`, `FieldColumn.test.jsx`) but nothing asserts that a drop is validated,
  because it isn't (§3.4).
- **RLS policies are only spot-checked.** `20260423065246_enable_pgtap.sql` enables pgTAP and
  `npm run test:db` exists, but pgTAP tests require a local Supabase stack and are not in CI.
- **The two divergent optimizers are tested separately and never compared.**
  `tests/autoScheduler.test.js` covers the core one; the Edge Function one is covered only through
  `tests/unit/scoring-engine.test.ts`, which tests the shared evaluator, not the optimizer's
  fitness formula.

---

## 6. Known gaps

Things that look built for one season or one club, or that would resist reuse. Ordered roughly by
how much they would block the season-2026 loader.

### 6.1 The temporal model is week-indexed, not date-indexed

`indexSlots` hard-requires a positive integer `weekIndex` on every slot
(`packages/core/src/gameScheduling.js:232-238`), slots are bucketed `${division}::${weekIndex}`
(`:257`), and one game per team per `weekIndex` is enforced (`:357-367`). `game_slots` does carry
`slot_date`, `start_time`, `end_time` alongside `week_index`
(`20260331000000_definitive_schema.sql:548-562`), but the engine ignores the date columns.

A season is therefore "N interchangeable weeks", not "13 specific dates each with its own venue
set, permit windows, and sunset". The corpus has 9 rec Saturdays plus 4 other scheduled dates,
including one (09/19) where a venue has no permit at all — expressible today only by not creating
slots, which loses the reason.

### 6.2 Round-robin is a single cycle; the corpus needs a repeated one

`generateRoundRobinWeeks` emits exactly `n - 1` weeks (`packages/core/src/gameScheduling.js:36-39`).
The corpus invariant is "every rec team plays exactly 9 games; round-robin complete within every
division; opponent counts differ by at most 1" — for a 6-team division that is 9 games over a
5-game cycle, i.e. a repeated round robin with balanced repeats. There is no parameter for
"number of games per team", no double round robin, and no repeat-balancing.

Related: home/away is decided alphabetically (`:57-58`), so the corpus invariant "hosting 4 or 5"
cannot be produced or checked. And `docs/architecture/game-scheduling.md:16` promises
double-header support, which the `duplicate-matchup` guard (`:357-367`) actively prevents.

### 6.3 Fields are independent strings; physical geometry does not exist

`fieldId` is opaque throughout. Field collision detection compares literal strings
(`packages/core/src/gameMetrics.js:147-156, 402-427`). `field_subunits` exists but carries only a
label (`20260331000000_definitive_schema.sql:347-355`) and is never joined to `game_slots`.

The corpus's central facility fact — Alder Park's Pitch 1 splits into 1A/1B, Pitch 4 into 4A/4B,
and 1↔2 / 3↔4 physically overlap so they cannot host concurrent games
(`fixtures/season-2026/facility_geometry.json`, `overlap_pairs` + `overlap_note`) — has no
representation. This is incident #3 in the corpus README, and the code is in exactly the state the
incident describes ("modeled fields as independent strings").

`fields.size text` (`:331`) and `fields.supports_halves boolean` (`:332`) are the vestigial hooks; no
engine reads either.

### 6.4 No duration model, and no distinction between play time and occupancy

Duration is `slot.end - slot.start`, chosen when the slot row was created. There is no per-format
timing table, no halves/halftime, no warm-up, no turnover floor, and no "schedule the worst case of
a range". Grepping the entire repo for `halftime`, `warmup`, `turnover`, and `occupancy` returns
zero hits outside the fixture CSVs.

This is incident #7 in the corpus README verbatim: if "90 minutes" silently meant play time rather
than footprint, nothing would fire. It is also what makes incident #8 (earliest kickoff with a full
30-minute warm-up bounded by a game on the _overlapping_ field) unanswerable today.

### 6.5 Coach conflict is team-pairwise and single-run, not person-centric

`hasCoachConflict` consults a `coachAssignments` map built fresh inside the current
`scheduleGames` call (`packages/core/src/gameScheduling.js:665-688`). `checkCoachConflict` in the
(unwired) drag validator reads `homeTeam.coachId` and `awayTeam.coachId` only
(`packages/core/src/gameValidation.js:63-84`). `gameMetrics` does the same
(`packages/core/src/gameMetrics.js:132-144`).

Consequences:

- **Assistants are invisible.** `teams.assistant_coach_ids uuid[]` exists
  (`20260331000000_definitive_schema.sql:465`) and is never read by any scheduler or evaluator.
- **Nothing outside this run exists.** Practices, scrimmages, external fixtures, and field
  reservations never enter a coach's timeline. This is incident #5 (a coach left with a 6.5-hour
  gap because scrimmages were appended after solving) — structurally reproducible today.
- **A shared coach kills the fixture.** If one person coaches both teams in a matchup,
  `scheduleGames` drops the game entirely with reason `coach-coaches-both-teams`
  (`:369-377`) rather than flagging it. The corpus has 3 rec games where exactly this happened and
  a co-coach covered; the current engine would refuse to schedule all three.

### 6.6 Coach identity is email-keyed with no resolution or review queue

`linkCoachesToPlayers` keys on `coach?.id ?? coach?.coach_id ?? coach?.email`
(`packages/core/src/coachLinking.js:63`), and `coaches.email` is `UNIQUE` globally
(`20260331000000_definitive_schema.sql:435`). There is no name normalization, no fuzzy match, no
merge, and no human review queue for ambiguous identities.

`coachContinuity.js` is the closest thing — it has a genuine "ambiguity becomes a manual-review
entry, never a guess" policy (`packages/core/src/coachContinuity.js:1-17`) and emits
`manualReview[]` entries with codes like `ambiguous-coach-replacement` (`:152-161`). But it
operates on _already-resolved_ coach ids across snapshot generations; it cannot notice that "Nate
Deverell" and "Nathaniel Deverell" are one person. That is incident #6, reproducible with
`coach_roster_v1.csv` vs `coach_roster.csv`, and the coach import path has no answer for it.

### 6.7 No constraint records, no hardness, no waivers

Constraints are control flow. There is no table, type, or serialized form for "this rule, of this
hardness, applies to this scope". The hard/soft split is implicit: `hasCoachConflict` is an
unconditional `continue` (`gameScheduling.js:488-498`), `computeConsistencyScore` is a ranking term
(`:650-663`). Capacity is hard. Priority is a sort key. Nothing in between, and nothing
per-instance.

Consequently a waiver — "the 60-minute travel floor is waived for coach X because these two venues
are 5 minutes apart" (incident #9) — has no home except a code comment, which is precisely how it
was lost in the source season.

The nearest existing analogues, none of which fit: `evaluation_run_events.event_type =
'manual_override'` (an event log, `20260331000000_definitive_schema.sql:866-879`),
`game_assignments.assignment_source = 'manual'` (a per-row provenance flag), and
`persistence_handler`'s pending-override gate (`packages/core/src/persistenceHandler.js:117-126`,
which blocks persistence rather than recording a standing exception).

### 6.8 No unplaced-fixture state, and no external opponents

`AssignmentSchema` requires truthy `homeTeamId` and `awayTeamId`
(`packages/core/src/schemas/index.js:50-51`); `games.home_team_id` / `away_team_id` are `NOT NULL`
FKs to `teams` (`:588-589`). Unplaceable matchups live in the transient `unscheduled[]` array
returned by `scheduleGames` (`:181-198`) and are surfaced as a warning
(`packages/core/src/gameMetrics.js:207-224`) — but never persisted. `docs/architecture/game-scheduling.md:8`
confirms the intended `scheduling_exceptions` table "was not created".

So the corpus's TIME TBD / LOCATION TBD fixture (incident #10), its weekly "teams TBD" reserved
league slots, its scrimmages, and its "Visiting Club A - U14G North" external opponents are all
unrepresentable. `games` also has no event-kind column, so a field reservation that is not a game
cannot occupy a slot.

### 6.9 No freeze scope, no minimal-diff objective, no publication parity

Practices have locks — `lockedAssignments` flow into `schedulePractices` and the optimizer excludes
`source === 'locked'` teams from mutation (`packages/core/src/autoScheduler.js:194-201`,
`checkHardConstraints` at `:155-180`). Teams have a rich preservation model
(`generationMode` ∈ draft/review/published/locked, `teamCountPolicy` ∈
auto/preserve-existing/preserve-or-expand/preserve-with-overflow —
`packages/core/src/teamGeneration.js:32-41`).

**Games have neither.** `handleAutoGenerate` calls `scheduleGames` from scratch with no notion of a
previously published schedule (`frontend/src/pages/GameSchedulingPage.jsx:399-474`) and clears any
staged review (`setReviewAssignments(null)` at `:407`). There is no freeze scope, no per-game lock
honored by the solver, no diff against a published baseline, and no term in any ranking function
that rewards leaving a game where it was.

This is incident #1 — the 366-game reshuffle — and nothing in the current architecture prevents it
recurring. It is also incident #2: even for practices, where locks _do_ exist, the corpus records
that repair passes leaked through the freeze, and there is no per-stage freeze test in
`tests/autoScheduler.test.js` or `tests/practiceScheduling.test.js`.

### 6.10 Two solvers, two fitness functions, four schema copies

Already detailed in §1.1 and §2.3. Concretely:

- `packages/core/src/autoScheduler.js:102-137` vs
  `supabase/functions/auto-scheduler/index.ts:155-165` — different coefficients, different terms,
  both live.
- `packages/core/src/schemas/index.js` vs `supabase/functions/_shared/schemas/scoring.ts` vs the
  inline copy at `supabase/functions/auto-scheduler/index.ts:32-94` — already divergent on `Date`
  coercion, `end > start`, and the `day` field.
- `packages/core/src/gameMetrics.js` vs
  `supabase/functions/_shared/engines/scoring-engine.ts` — a hand-port, per its own header comment
  (`:26-29`).

Any new constraint has to be implemented at least twice, and nothing detects when the two drift.

### 6.11 Clock and locale assumptions

- `getStartTimeKey` buckets kickoff times by **UTC** hour/minute
  (`packages/core/src/gameScheduling.js:774-778`), so the consistency preference silently shifts
  across a DST boundary.
- `schedulePractices` exempts weekend slots by comparing English day names:
  `['Friday', 'Saturday', 'Sunday'].includes(slot.day)`
  (`packages/core/src/practiceScheduling.js:105`).
- `practice_slots.day_of_week` is `CHECK (day_of_week IN ('mon', 'tue', 'wed', 'thu'))`
  (`20260331000000_definitive_schema.sql:501`) — a Friday or weekend practice is rejected by the
  database.
- `calendar-feed` defaults to `'America/New_York'` when the org has no timezone
  (`supabase/functions/calendar-feed/index.ts:74`); `OrganizationCreation.jsx:170` and
  `SeasonModule.jsx:181` offer a US-only timezone list.
- CSV export renders timestamps with `toLocaleString('en-US', { timeZone })`
  (`packages/core/src/outputGeneration.js:229-238`).

### 6.12 Sunset and lighting are captured but never used

`locations.lighting_available boolean` (`:313`) and `field_availability_profiles.lighted boolean`
(`20260522120000_field_availability_phase1.sql:44`) exist. `season_settings.daylight_adjustments
jsonb` exists (`:270`) and feeds only `practiceSlotExpansion.js` — practices, not games. There is
no sunset dataset, no per-date sunset lookup, and no rule anywhere resembling "an unlit game must
end 15 minutes before sunset".

### 6.13 Field availability is modeled but orphaned

Six tables were built for it (`20260522120000_field_availability_phase1.sql:27-112`), plus
scenario selection (`20260603000000_field_availability_scenario_selection_rpc.sql`), hardening
migrations, an import path, and UI pages. **No scheduler or evaluator reads any of them.** A field
whose permit window ends at 6 PM will happily receive an 8 PM game if a `game_slots` row exists.

The one documented fixture for this feature is season-specific and club-specific:
`docs/fixtures/fall-2026-field-availability.md`, which names actual venues ("Five Canyons
Upper/Lower", "Bret Harte", "San Lorenzo", "Creekside", "Proctor", "Canyon") and hard-codes Fall
2026 dates. **Inferred:** that fixture came from one club's real availability spreadsheet and was
transcribed rather than generalized.

**Not to be unified with `packages/core/src/scenario/`.** Prompt 6.1 added a module that models
**schedule branches** — "what would the season look like without venue X" — as an id, a baseline, a
list of record-set overrides and a rationale, with the schedule and the diff re-derived on demand.
The SQL table above models something else: **field-availability profiles**, which fields a club may
use in a given configuration, keyed to the import path and the UI pages above. The two share an
English word and nothing else. `scenario/` is in memory only, creates no migration, reads
`field_availability_scenarios` nowhere, and a structural test in
[`tests/scenarioBranching.test.js`](../tests/scenarioBranching.test.js) asserts the name appears in
that package only as prose explaining this paragraph. Nothing in the SQL table reads `scenario/`
either — it is still orphaned, exactly as described above. See [`SCENARIOS.md`](SCENARIOS.md) §9.

### 6.14 Smaller reuse hazards

- **Division identity is a free-text label.** The engine joins on `Team.division` (a name), not
  `divisions.id`; `normalizeTeam` falls back through four candidate fields to
  `'Unassigned'` (`frontend/src/pages/GameSchedulingPage.jsx:60-73`). A team-naming change breaks
  the join silently — incident #4.
- **No meta-assertions.** Nothing in the evaluator asserts "I actually compared N pairs". A
  validator whose join matches zero rows reports a perfect score, exactly as in incident #4.
  `detectConflicts` also `break`s after the first conflict per id
  (`packages/core/src/gameMetrics.js:423`), so counts are lower bounds, not counts.
- **`gameValidation.js` is dead code** (§3.4) while three docs describe it as live.
- **`games` and `game_assignments` are competing tables**, with `games.game_slot_id UNIQUE`
  contradicting `game_slots.capacity` (§1.4).
- **`packages/core/src/gameSupabase.js` writes tables directly**, against `CLAUDE.md`'s RPC-only
  rule.
- **The `Event` typedef is vestigial** (`packages/core/src/types.js:102-114`) — no table, no code.
- **Import types are a closed set of four** with no schedule importer
  (`20260522120000_field_availability_phase1.sql:3-5`), so "re-import the published schedule as
  ground truth" — the only recovery that worked in incident #1 — has no path today.
- **`supabase/seed.sql`** seeds a single demo org with a hard-coded venue ("Riverfront Park",
  `:125-126`); harmless, but it is the only worked example of the facility model in the repo.

---

## 7. Quick file index

| Concern                  | Start here                                                            |
| ------------------------ | --------------------------------------------------------------------- |
| Engine types             | `packages/core/src/types.js`                                          |
| Runtime schemas          | `packages/core/src/schemas/index.js`                                  |
| Game solver              | `packages/core/src/gameScheduling.js:101-199`                         |
| Game evaluation          | `packages/core/src/gameMetrics.js:16-227`                             |
| Practice solver          | `packages/core/src/practiceScheduling.js:77`                          |
| Practice optimizer       | `packages/core/src/autoScheduler.js:425-609`                          |
| Objective (practices)    | `packages/core/src/autoScheduler.js:102-137`                          |
| Readiness aggregation    | `packages/core/src/evaluationPipeline.js:71-269`                      |
| Team generation          | `packages/core/src/teamGeneration.js:108`                             |
| Persistence engine       | `packages/core/src/persistenceHandler.js:153-202`                     |
| CSV export               | `packages/core/src/outputGeneration.js:29-165`                        |
| Game UI + drag/drop      | `frontend/src/pages/GameSchedulingPage.jsx`, `components/scheduling/` |
| DB baseline              | `supabase/migrations/20260331000000_definitive_schema.sql`            |
| Game persistence RPC     | `supabase/migrations/20260503030000_repair_game_persistence_rpc.sql`  |
| Field availability       | `supabase/migrations/20260522120000_field_availability_phase1.sql`    |
| Schedule scenarios       | `packages/core/src/scenario/index.js`                                 |
| Edge Functions           | `supabase/functions/*/index.ts`, shared code in `_shared/`            |
| Regression corpus        | `fixtures/season-2026/README.md`                                      |
| Prior architecture notes | `docs/architecture/`, `docs/LESSONS_LEARNED.md`                       |
