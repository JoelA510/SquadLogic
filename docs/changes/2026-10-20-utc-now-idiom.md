# `timezone('utc', now())` stores a time shifted by the caller's session timezone

Status: **plan, for owner approval** (AGENTS.md rule 14: persistence). Requested by the owner
2026-10-20. Source: B2 (DS-5) found it while building the registration throttle; lesson 37 in
`docs/LESSONS_LEARNED.md` and the remediation plan's "Discovered during execution" record it.

## What is wrong

`timezone('utc', now())` returns a `timestamp` **without** a time zone: the current UTC wall clock.
Every place this repo uses it, the value lands in a `timestamptz` column or variable. PostgreSQL
converts it back by reading that wall clock in the **session's** `TimeZone`. With the session at
UTC (the server default, and what Edge Functions and the dashboard use), the round trip is
harmless. A PostgREST caller can set the session zone per request with `Prefer: timezone=...`
(lesson 37). In that case every such timestamp is stored shifted by the zone's offset: up to 14
hours into the past, or 12 into the future.

**Evidence, executed on local PostgreSQL 16 (2026-10-20).** In a session at
`Pacific/Kiritimati` (UTC+14):

| Case | Stored offset |
| --- | --- |
| A column default `timezone('utc', now())` | 14 hours early |
| A plpgsql function that writes `timezone('utc', now())` | 14 hours early |
| The same function declared `SET timezone = 'UTC'` | correct (0) |

**Scope, executed (read-only, production catalogue, 2026-10-20):**

- **Column defaults:** 82, every one on a `timestamptz` column (`created_at` / `updated_at` on
  most tables, plus `applied_at`, `started_at`, `recorded_at`, `added_at`).
- **Function bodies:** about 64 uses in 42 public functions. The writers include:
  - `trigger_set_timestamp` (every table's `updated_at`);
  - `persist_practice_schedule`, `persist_game_schedule` and `persist_team_schedule` (run
    times, `updated_at`, `withdrawn_at`);
  - `set_team_coaches` (`ended_at` on coach history);
  - `sync_player_team_id`, `update_game_score`, `upsert_team_event_rsvp`;
  - the import pipeline;
  - the retire and unretire RPCs.
- **One comparison, in an argument default:** `fail_stale_import_jobs(p_stale_before timestamptz
  DEFAULT timezone('utc', now()) - interval '5 minutes')` (`20260503100000`). A caller at UTC-12
  would move the cutoff 12 hours later and fail their own organization's running imports.
  `ImportContext.jsx:455` calls it without the argument. **Pinning the function does not fix
  this.** PostgreSQL inserts an omitted argument's default into the caller's query, where it is
  evaluated in the caller's session, before the function's `SET timezone` takes effect.
- **No use is the deliberate "UTC calendar date" form** (`timezone('utc', now())::date`), which
  would be correct and must not be changed. Searched: none in the live functions.
- **Already correct:** `audit_log.created_at` and `telemetry_log.created_at` default to `now()`,
  so the audit trail's timestamps are not affected. The registration throttle was fixed in #609.
- **Migrations** contain about 250 textual uses. That count includes superseded function bodies;
  the catalogue counts above are what is live.

**Consequence today.** The harm is bounded: no throttle or permission depends on these timestamps
any more (#609). Still, a caller can back-date or forward-date:

- `created_at` and `updated_at` on rows they write, which corrupts "latest first" ordering and any
  "since" view;
- the end of a coach assignment (`team_coach_assignments.ended_at`), which the effective-dating
  as-of reads depend on.

No real users exist yet, so no stored data needs correcting.

## Options

1. **Pin the zone, change no bodies.** For each of the 42 functions,
   `ALTER FUNCTION ... SET timezone = 'UTC'`. For each of the 82 columns,
   `ALTER COLUMN ... SET DEFAULT now()`. One function also needs its argument default rewritten:
   `fail_stale_import_jobs`' `p_stale_before` becomes `DEFAULT now() - interval '5 minutes'`,
   a `CREATE OR REPLACE` that keeps the signature and changes only that default. The body is
   copied from its latest definition and checked by the harness's md5 comparison.
   - Mechanical, and no function body is rewritten, so no copy of a function can drift from its
     latest definition. That has bitten this repo before; see #598.
   - Metadata-only: no table rewrite, no lock beyond a brief catalogue lock.
   - The idiom stays in the bodies but is harmless. A function with a `SET` clause cannot be
     inlined, which does not matter for plpgsql and trigger functions.
2. **Rewrite every body to `now()`**, with 42 `CREATE OR REPLACE` statements copied from their
   latest migrations, plus the 82 defaults. This is the cleanest end state. It is also the
   largest and riskiest diff: each body must be the exact latest definition, and an
   overlooked later redefinition would silently revert behaviour.
3. **Do nothing and document it.** Rejected: the shift is caller-controlled and lands in
   effective-dated history.

**Recommendation: option 1**, plus a guard so the idiom does not come back:

- **CI guard:** a Vitest test (`tests/utcNowIdiom.test.js`) fails on any migration *after* this
  one that contains the idiom without `::date`. It matches on a normalized pattern, not one
  literal: case-insensitive, with optional whitespace and casts. That covers `timezone('utc',
  now())`, `timezone('UTC'::text, now())` and `now() AT TIME ZONE 'utc'`. A catalogue check in the
  migration harness fails if any public function with the idiom in its body lacks `timezone=UTC`
  in its `proconfig`, or any column default (`pg_get_expr`) or function argument default
  (`pg_get_function_arguments`) contains it. The catalogue deparses the literal as
  `timezone('utc'::text, now())`, so a literal-text check there would examine nothing; the
  pattern is what makes it work.
- **Later:** when a function is next rewritten for its own reasons, replace the idiom with `now()`
  in that same change. There is no flag day for the bodies.

## Design (option 1)

- **One migration**, generated from the catalogue at build time and checked in as plain SQL: 42
  `ALTER FUNCTION public.<name>(<args>) SET timezone = 'UTC';` lines and 82
  `ALTER TABLE public.<t> ALTER COLUMN <c> SET DEFAULT now();` lines, each listed explicitly. A
  `DO` block would hide what changed.
- **Revert** (`docs/sql/<version>_revert.sql`): `ALTER FUNCTION ... RESET timezone` and the old
  defaults.
- **Smoke** (`docs/sql/<version>_smoke.sql`): under `SET LOCAL timezone = 'Pacific/Kiritimati'`,
  insert one row through a default and call one pinned writer. Both timestamps must be within one
  minute of `now()`.
- **pgTAP** (`supabase/tests/utc_now_idiom.sql`): the same as the smoke, for the writers that
  matter:
  - `trigger_set_timestamp`;
  - `set_team_coaches`' `ended_at`;
  - a `persist_practice_schedule` save;
  - `fail_stale_import_jobs`' cutoff, called **without** the argument under `+14` and `-12`, so
    the default itself is what is tested;
  - one default.

  Plus the catalogue assertion that no function body with the idiom lacks the pin.
- **Plants**, shown failing before merge:
  - a function left unpinned fails the catalogue assertion;
  - a column default restored to the idiom fails it;
  - an argument default restored to the idiom fails it;
  - a new migration using each of the three spellings fails the Vitest guard;
  - the pgTAP fails on today's schema.

## Risks

- **`SET timezone = 'UTC'` changes more than the idiom inside a pinned function.** It also changes
  `current_date`, `::date` casts, and how a timestamp string with no offset is parsed. Examples:
  `set_team_coaches` refuses `p_effective_on > current_date` (`20260923000000:235`), and
  `persist_team_schedule` parses `run_data->>'started_at'`. After pinning, those use UTC, not the
  caller's zone. For a client that always sends offsets this is the intended behaviour, but the
  plan inventories every `current_date`, `now()::date`, `::date` and text-to-timestamptz parse in
  the 42 functions and decides each one. A calendar-date check meant for the organization's local
  day (such as "not in the future" for an assignment date) uses the season timezone, as item 1 of
  the research recommendations does, rather than UTC. Each one gets a test at a UTC day boundary.

- **`SET timezone` also changes how timestamps print as text inside the function.** For example,
  `to_jsonb(row)` in audit metadata renders `+00:00` instead of the session's offset. Those
  values are the same instants, and the session default is already UTC, so nothing changes for
  today's callers.
- **A function added later with the idiom and no pin.** The catalogue check catches that.
- **Function signatures must be exact.** They are generated from `pg_proc` and checked by the
  harness's catalogue snapshot.

Size: one migration (about 125 lines), its revert and smoke files, one pgTAP file, one Vitest
guard, and the harness catalogue check. No application code changes.
