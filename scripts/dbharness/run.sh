#!/usr/bin/env bash
#
# Local migration harness: apply the whole migration set to a throwaway
# PostgreSQL cluster, run the smokes, and check each revert.
#
# **Why this exists.** Two review rounds found six HIGH defects in SQL by eye,
# and the fixes to two of them introduced two more. Nothing in CI executes a
# migration, so none of it was catchable. This closes exactly that gap.
#
# **What it verifies**
#   1. the full migration set applies cleanly from scratch, in order;
#   2. the smoke scripts run and their assertions hold;
#   3. each revert applies after its forward migration.
#
# **What it does NOT verify**: RLS behaviour under a real authenticated
# session (that is the pgTAP suite), the corpus, or anything in the app.
#
# No network, no spend: PostgreSQL is already in the image and the cluster
# listens on a unix socket only.
set -uo pipefail

PGUSER_LOCAL=pgrunner
PGBIN=/usr/lib/postgresql/16/bin
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=squadlogic_harness

as_pg() { runuser -u "$PGUSER_LOCAL" -- bash -lc "export PATH=$PGBIN:\$PATH; $1"; }

start_cluster() {
  # Stop any cluster left running by a previous run BEFORE removing its data
  # directory -- deleting pgdata under a live postmaster leaves a process with
  # no files and the next connect fails with a socket that never appears.
  as_pg 'pg_ctl -D ~/pgdata -m immediate -w stop' >/dev/null 2>&1 || true
  as_pg 'pkill -u pgrunner postgres' >/dev/null 2>&1 || true
  sleep 1
  as_pg 'rm -rf ~/pgdata ~/sock ~/pg.log; mkdir -p ~/sock' >/dev/null 2>&1
  as_pg 'initdb -D ~/pgdata -U postgres --auth=trust' >/dev/null 2>&1 || return 1
  as_pg 'pg_ctl -D ~/pgdata -o "-k $HOME/sock -c listen_addresses=" -l ~/pg.log -w start' >/dev/null 2>&1
}

# psql that FAILS THE RUN on any error. Without ON_ERROR_STOP a migration can
# half-apply and the harness reports success -- which would make it exactly the
# kind of check this whole phase exists to stop.
psql_file() {
  local f="$1"
  local staged="/home/$PGUSER_LOCAL/.harness.sql"
  # **The staging copy's status was thrown away, and the staging path is
  # reused.** Every file is copied over the same `~/.harness.sql`, so a `cp`
  # that failed left the PREVIOUS file in place and psql cheerfully re-ran it
  # and exited 0 -- a smoke could print PASS having executed the migration
  # before it. Identical in shape to the `fresh_db` prelude bug fixed last
  # round, on every call site rather than one. The source must exist, the copy
  # must succeed, and the staged file is removed first so a failed copy leaves
  # nothing to run rather than something stale.
  if [ ! -r "$f" ]; then echo "psql_file: cannot read $f" >&2; return 1; fi
  rm -f "$staged"
  if ! cp "$f" "$staged"; then echo "psql_file: failed to stage $f" >&2; return 1; fi
  if ! chmod 644 "$staged"; then echo "psql_file: failed to chmod $staged" >&2; return 1; fi
  as_pg "psql -v ON_ERROR_STOP=1 -h ~/sock -U postgres -d $DB -q -f ~/.harness.sql"
}
psql_cmd() { as_pg "psql -v ON_ERROR_STOP=1 -h ~/sock -U postgres -d $DB -tAc \"$1\""; }

# **Every dump of psql's own output is INDENTED, and that is load-bearing.**
#
# `prove.sh` decides which check a plant reached by reading this transcript, and
# it matches only the shapes THIS script's `echo`s produce: a verdict line
# beginning `PASS `/`FAIL ` in column 0, and a health claim that is
# `  | (checked) ...` entire. Raw psql output printed at column 0 defeats both,
# because the message is something a plant WRITES: a multi-line `RAISE` emits
# its continuation lines verbatim and unprefixed, so a mutation raising
# `E'...\nFAIL scenario table\n  | (checked) ...'` put both shapes into the
# transcript itself. Measured before it was closed -- one such plant scored
# `CAUGHT (at substring "FAIL scenario table")` with the scenario table PASSING,
# and its twin scored a claim "stayed green" that the run never printed.
#
# Indenting removes the whole class rather than one instance: no amount of
# plant-authored text can reach column 0, or reduce `      | ` to `  | `, once
# every byte of it is pushed four columns right.
#
# The NOTICE passthrough solved this at the start by prefixing `  | `. Eleven
# `tail` dumps had not adopted it -- the correction on one arm of a pair, in the
# round after the one about pairs. One function now, so a twelfth cannot forget,
# and the argument lives in one place instead of eleven.
dump() { # lines file
  tail -n "$1" "$2" | sed 's/^/    /'
}

fresh_db() {
  if ! as_pg "psql -h ~/sock -U postgres -q -c 'DROP DATABASE IF EXISTS $DB' -c 'CREATE DATABASE $DB'" >/tmp/harness_freshdb 2>&1; then
    echo "FAIL creating a fresh database"; dump 10 /tmp/harness_freshdb; return 1
  fi
  # **The prelude's exit status was thrown away.** `psql_file ... >/dev/null`
  # discarded both the output and, because nothing tested `$?`, the failure --
  # so a prelude that died part-way left a half-built stand-in and the run
  # carried on against it. Found by trying to prove the baseline gate could
  # fail: a deliberately broken prelude produced BASELINE GREEN and fifteen
  # meaningless CAUGHTs. The gate was right; what it stood on was not.
  if ! psql_file "$REPO/scripts/dbharness/prelude.sql" >/tmp/harness_prelude 2>&1; then
    echo "FAIL applying the prelude"; dump 20 /tmp/harness_prelude; return 1
  fi
}

# `apply_all [stop-after-id]` -- the whole migration set, or the set truncated
# after the migration whose basename begins with that id.
#
# **It was three copies of this loop and only ONE of them counted.** The revert
# stage and the emergency-rollback stage each built a database with their own
# open-coded copy, neither of which carried the meta-assertion below -- so a
# glob that matched nothing, or a migration directory that had moved, built an
# EMPTY database and every revert and rollback check below then passed against
# it. The correction applied to one arm of a pair and not its twin is the defect
# this whole series keeps finding, so there is now one arm: a caller that wants
# a truncated build passes the id it wants to stop at, and gets the same count
# gate the full build has always had.
apply_all() {
  local stop="${1:-}" applied=0 reached=0
  for m in "$REPO"/supabase/migrations/*.sql; do
    if ! psql_file "$m" >/tmp/harness_err 2>&1; then
      echo "FAIL applying $(basename "$m")"
      dump 20 /tmp/harness_err
      return 1
    fi
    applied=$((applied + 1))
    if [ -n "$stop" ] && [[ "$(basename "$m")" == ${stop}* ]]; then reached=1; break; fi
  done
  echo "applied $applied migrations${stop:+ up to $stop}"
  # Meta-assertion: a loop that applied nothing would print "applied 0" and
  # every check below would pass against an empty database.
  if [ "$applied" -lt 100 ]; then echo "FAIL: only $applied migrations applied"; return 1; fi
  # Its twin, for the truncated form: a loop that ran off the end without ever
  # meeting its stop id built the database to HEAD, and the revert then checked
  # against it is a revert checked against a state nobody asked for. A renamed
  # or removed migration is exactly how that happens, and it would have been
  # invisible -- the build succeeds, every check runs, and the stage says PASS.
  if [ -n "$stop" ] && [ "$reached" -ne 1 ]; then
    echo "FAIL: the migration set contains no ${stop}*, so the build never stopped at it"
    return 1
  fi
}

# pg_cron is not in this image and one migration requires it. A STUB extension
# is installed so CREATE EXTENSION succeeds and the scheduling statements
# apply. It schedules nothing -- the harness proves the migration APPLIES, not
# that a job fires. Installed here rather than by hand so the run reproduces.
install_stub_ext() {
  local dir
  dir="$($PGBIN/pg_config --sharedir)/extension"
  cp "$REPO/scripts/dbharness/stubext/pg_cron.control" "$dir/" 2>/dev/null || return 1
  cp "$REPO/scripts/dbharness/stubext/pg_cron--1.0.sql" "$dir/" 2>/dev/null || return 1
  cp "$REPO/scripts/dbharness/stubext/pgtap.control" "$dir/" 2>/dev/null || return 1
  cp "$REPO/scripts/dbharness/stubext/pgtap--1.0.sql" "$dir/" 2>/dev/null || return 1
}

echo "=== installing stub extensions ==="
install_stub_ext || { echo "FAIL: could not install pg_cron stub"; exit 1; }
echo "=== starting cluster ==="
start_cluster || { echo "FAIL: could not start cluster"; exit 1; }
echo "=== applying migration set ==="
fresh_db || { echo "HARNESS FAILED"; exit 1; }
apply_all || { echo "HARNESS FAILED"; exit 1; }
echo "=== smokes for this PR's migrations ==="
#
# **Scoped to the migrations this PR adds** (`NEW_MIGRATIONS`),
# and that is a deliberate limit
# worth stating. Several pre-existing smokes are BEHAVIOURAL: they seed an org,
# assume an authenticated admin session, and exercise an RPC. They fail here for
# want of fixtures and a real JWT, not because anything is wrong with them --
# running them would need a seeding layer this harness does not have and the
# pgTAP suite already does. Claiming to verify them would be the hollow kind of
# green this whole phase exists to stop.
STATUS=0
NEW_MIGRATIONS=(20260906000000 20260906000100 20260907000000 20260908000000 20260909000000 20260910000000 20260911000000)

for id in "${NEW_MIGRATIONS[@]}"; do
  smoke="$REPO/docs/sql/${id}_smoke.sql"
  if psql_file "$smoke" >/tmp/harness_smoke 2>&1; then
    echo "PASS smoke ${id}"
    # **Print what it exercised, not just that it exited 0.** Each smoke has two
    # halves: assertions that RAISE, and reporting SELECTs that are evidence
    # rather than gates. Swallowing the output on PASS threw the evidence half
    # away and left "PASS" meaning only "raised nothing" -- which is exactly
    # what a hollow smoke also prints. The NOTICEs say how many rows each
    # invariant was exercised on, and a run that exercised zero is visible here
    # instead of being indistinguishable from a run that exercised hundreds.
    grep -E '^(psql:[^ ]+ )?(NOTICE|WARNING):' /tmp/harness_smoke |
      sed -E 's/^psql:[^ ]+ //; s/^/  | /' || true
  else
    echo "FAIL smoke ${id}"; dump 15 /tmp/harness_smoke; STATUS=1
  fi
done

echo "=== shared scenario table, against Postgres ==="
#
# `tests/fixtures/fieldLifecycleScenarios.json` states what the lifecycle and
# blackout RPCs must do; `tests/fieldLifecycleScenarios.test.js` runs it against
# the mock and this runs the same table against a real database. Round 2's
# fixes to admin_retire_field and admin_unretire_field landed in the SQL and
# never reached the mock, and no check existed that would notice -- behaviour
# cannot be shared across PL/pgSQL and JavaScript, but the EXPECTED OUTCOME can.
# **A failed generation must not fall through to a green run.** The `|| { ...
# STATUS=1; }` set the status and then carried on, so psql ran the truncated,
# empty file that the failed redirect had left behind, found nothing to object
# to, and the harness printed "PASS scenario table" over a script that had
# executed nothing. The generator itself refuses to emit for an empty table --
# that guard was fine and this path went round it.
rm -f /tmp/harness_scenarios.sql
if ! python3 "$REPO/scripts/dbharness/scenarios.py" > /tmp/harness_scenarios.sql 2>/tmp/harness_scen_gen; then
  echo "FAIL generating the scenario script"; dump 10 /tmp/harness_scen_gen; STATUS=1
elif [ ! -s /tmp/harness_scenarios.sql ]; then
  echo "FAIL the scenario generator produced an empty script"; STATUS=1
elif psql_file /tmp/harness_scenarios.sql >/tmp/harness_scen_out 2>&1; then
  echo "PASS scenario table"
  # The NOTICE carries `v_ran` of the table size, so a run that executed
  # nothing is visible here rather than hiding behind the word PASS.
  if ! grep -qE 'NOTICE:.*scenarios executed against Postgres' /tmp/harness_scen_out; then
    echo "FAIL scenario table ran without reporting how many scenarios it executed"; STATUS=1
  fi
  grep -E '^(psql:[^ ]+ )?NOTICE:' /tmp/harness_scen_out | sed -E 's/^psql:[^ ]+ //; s/^/  | /' || true
else
  echo "FAIL scenario table"; dump 15 /tmp/harness_scen_out; STATUS=1
fi

echo "=== reverts (each applied on a database built up to its own migration) ==="
#
# A revert is only meaningful directly after its forward migration. Applying
# every revert to a fully-migrated database, as the first draft did, fails on
# ordering that says nothing about the revert -- 20260610's revert cannot drop a
# column a later migration built a view on. So each revert is checked on a fresh
# database migrated up to and including its own forward migration.
for id in "${NEW_MIGRATIONS[@]}"; do
  if ! fresh_db; then echo "FAIL building a fresh database for ${id}"; STATUS=1; continue; fi
  if ! apply_all "$id"; then echo "FAIL building up to ${id}"; STATUS=1; continue; fi

  # **Give the revert something to lose.** 20260906000000's revert now names
  # every future-dated retirement before it drops the column that records them,
  # because dropping it silently leaves a field that reads as permanently open.
  # On a freshly migrated database that loop iterates zero times and prints
  # "nothing to record" -- a pass that proves only that the code parses. So the
  # harness plants a field that IS about to lose its retirement, and then
  # requires the warning to appear. A check that matches zero rows is a loud
  # failure here, not a quiet pass.
  # **The same reasoning for 20260907000000's revert.** It counts the
  # practice_assignments that are about to lose the foreign key protecting
  # their field_id, and on a freshly migrated database there are none -- so the
  # report would print "exposes no existing row" and prove only that the code
  # parses. A row that IS about to be exposed is planted, and the warning is
  # then required. practice_assignments.team_id is NOT NULL and references
  # teams, so the plant needs the season/division/team chain behind it.
  #
  # **Both seeds threw `psql_cmd`'s status away, and a seed that never landed
  # reads exactly like a revert that ignored it.** A column renamed by a later
  # migration, a constraint added, the chain reordered -- any of those left the
  # table empty, and the check below then printed "the revert did not count it"
  # for a revert that had nothing to count. `prove.sh` scores that FAIL as a
  # CAUGHT, so the harness would have been MANUFACTURING evidence for a check
  # that never ran, which is worse than having no check at all. A failed seed
  # now fails the stage in its own words and skips the checks it would have
  # made meaningless.
  if [ "$id" = "20260907000000" ]; then
    if ! psql_cmd "INSERT INTO public.organizations (id, name, slug)
              VALUES ('33333333-3333-3333-3333-333333333333','Expose Org','expose-org');
              INSERT INTO public.locations (id, organization_id, name)
              VALUES ('44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333','Expose Park');
              INSERT INTO public.fields (id, organization_id, location_id, name, active)
              VALUES ('55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','Expose Pitch', true);
              INSERT INTO public.season_settings (id, organization_id, name)
              VALUES ('66666666-6666-6666-6666-666666666666','33333333-3333-3333-3333-333333333333','Expose Season');
              INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
              VALUES ('77777777-7777-7777-7777-777777777777','33333333-3333-3333-3333-333333333333','66666666-6666-6666-6666-666666666666','Expose Division');
              INSERT INTO public.teams (id, organization_id, division_id, name)
              VALUES ('88888888-8888-8888-8888-888888888888','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777','Expose Team');
              INSERT INTO public.practice_assignments (organization_id, team_id, field_id)
              VALUES ('33333333-3333-3333-3333-333333333333','88888888-8888-8888-8888-888888888888','55555555-5555-5555-5555-555555555555');" \
         >/tmp/harness_seed 2>&1; then
      echo "FAIL seeding ${id}: the practice_assignment the revert check requires was never inserted"
      dump 10 /tmp/harness_seed; STATUS=1; continue
    fi
  fi

  # **The same reasoning for 20260908000000's revert.** It counts the profiles
  # that already have no field before restoring a body that will make more of
  # them, and on a freshly migrated database there are none -- so it would
  # report zero and prove only that the code parses. A profile that IS in that
  # state, carrying a blackout window, is planted, and the count is then
  # required to be non-zero. `field_blackout_windows.profile_id` is NOT NULL,
  # so the window needs the profile; the profile needs a location name and a
  # field name as TEXT and no field row at all, which is exactly the state the
  # unguarded import produced.
  if [ "$id" = "20260908000000" ]; then
    if ! psql_cmd "INSERT INTO public.organizations (id, name, slug)
              VALUES ('99999999-9999-9999-9999-999999999999','Orphan Org','orphan-org');
              INSERT INTO public.field_availability_profiles
                (id, organization_id, season_label, field_id, location, field_name, available_from, available_until)
              VALUES ('9a999999-9999-9999-9999-999999999999','99999999-9999-9999-9999-999999999999','Fall 2026',NULL,'Orphan Park','Ghost Pitch','2026-08-01','2026-11-30');
              INSERT INTO public.field_blackout_windows
                (organization_id, profile_id, blackout_from, blackout_until, reason)
              VALUES ('99999999-9999-9999-9999-999999999999','9a999999-9999-9999-9999-999999999999','2026-09-01','2026-09-30','blackout_months');
              INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, total_rows)
              VALUES ('9b999999-9999-9999-9999-999999999999','99999999-9999-9999-9999-999999999999','field_availability','orphan/fa.csv','importing',1);
              INSERT INTO public.staging_import_rows
                (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
              VALUES ('99999999-9999-9999-9999-999999999999','9b999999-9999-9999-9999-999999999999','field_availability',1,'{}','{}',
                      jsonb_build_array(jsonb_build_object('reason','field_unresolved','location','Orphan Park','field_name','Ghost Pitch')));" \
         >/tmp/harness_seed 2>&1; then
      echo "FAIL seeding ${id}: the field-less profile the revert check requires was never inserted"
      dump 10 /tmp/harness_seed; STATUS=1; continue
    fi
  fi

  # **The same reasoning for 20260909000000's revert**, and it needs the
  # OPPOSITE seed to 20260908000000's. That revert counts profiles that have
  # ALREADY lost their field; this one counts profiles that are still
  # ATTACHED to one, because those are the rows a future delete will strand
  # once the foreign key goes back to SET NULL. On a freshly migrated database
  # both counts are zero and the warning reads as reassuring.
  #
  # The import job with a `field_rollback.blocked` list is the second seed,
  # for the fourth warning: `blocked` is a key 20260909000000 added to the
  # rollback result and the revert removes, and a count of zero would prove
  # only that the jsonb operator parses.
  #
  # The THIRD seed is a field-less profile, and it is there for the forward
  # migration rather than the revert: 20260909000000 counts the profiles it is
  # LEAVING behind, and on a database built from scratch that branch has never
  # executed -- the same unreached warning LIVE-2's round 1 found in
  # 20260908000000. The re-apply below runs it against real rows.
  #
  # **The cardinalities here are load-bearing and must stay unequal.** This
  # seed used to be one attached profile with one window and one field-less
  # profile with one window, and two mutation plants proved that symmetric.
  # Every count in the migration and its revert -- profiles with field_id
  # IS NULL, profiles with field_id IS NOT NULL, and the windows each set
  # carries -- returned 1 against that seed, so a check counting the WRONG set
  # printed the RIGHT number. `M5 the LEAVING report counts the wrong set` and
  # `R5 revert counts the wrong profiles` both flip exactly that predicate, and
  # both scored NOT CAUGHT: the assertions were reading a figure that could not
  # distinguish the sets it was there to tell apart.
  #
  # So: attached = 1 profile carrying 1 window; field-less = 2 profiles
  # carrying 3 windows. Four figures, no two equal, and each of the two plants
  # now changes one of them. Do not "tidy" the second field-less profile or its
  # two windows away, and do not give the attached profile a second window --
  # any of those restores a coincidence, not a simplification.
  if [ "$id" = "20260909000000" ]; then
    if ! psql_cmd "INSERT INTO public.organizations (id, name, slug)
              VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Attached Org','attached-org');
              INSERT INTO public.locations (id, organization_id, name)
              VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Attached Park');
              INSERT INTO public.fields (id, organization_id, location_id, name, active)
              VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Attached Pitch', true);
              INSERT INTO public.field_availability_profiles
                (id, organization_id, season_label, field_id, location, field_name, available_from, available_until)
              VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Fall 2026','cccccccc-cccc-cccc-cccc-cccccccccccc','Attached Park','Attached Pitch','2026-08-01','2026-11-30');
              INSERT INTO public.field_blackout_windows
                (organization_id, profile_id, blackout_from, blackout_until, reason)
              VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd','2026-09-01','2026-09-30','blackout_months');
              INSERT INTO public.field_availability_profiles
                (id, organization_id, season_label, field_id, location, field_name, available_from, available_until)
              VALUES ('daaaaaaa-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Fall 2026',NULL,'Attached Park','Vanished Pitch','2026-08-01','2026-11-30');
              INSERT INTO public.field_blackout_windows
                (organization_id, profile_id, blackout_from, blackout_until, reason)
              VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','daaaaaaa-dddd-dddd-dddd-dddddddddddd','2026-09-01','2026-09-30','blackout_months');
              INSERT INTO public.field_availability_profiles
                (id, organization_id, season_label, field_id, location, field_name, available_from, available_until)
              VALUES ('dbbbbbbb-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Fall 2026',NULL,'Attached Park','Second Vanished Pitch','2026-08-01','2026-11-30');
              INSERT INTO public.field_blackout_windows
                (organization_id, profile_id, blackout_from, blackout_until, reason)
              VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dbbbbbbb-dddd-dddd-dddd-dddddddddddd','2026-10-01','2026-10-15','blackout_months'),
                     ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dbbbbbbb-dddd-dddd-dddd-dddddddddddd','2026-11-01','2026-11-15','blackout_months');
              INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, total_rows, warning_summary)
              VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','fields','attached/fields.csv','completed_with_warnings',1,
                      jsonb_build_object('field_rollback', jsonb_build_object('blocked_records',1,'blocked',jsonb_build_object('total',1,'omitted',0,'by_kind',jsonb_build_object('fields',1),'sample',jsonb_build_array(jsonb_build_object('kind','fields','reason','bookings_exist'))))));" \
         >/tmp/harness_seed 2>&1; then
      echo "FAIL seeding ${id}: the attached profile and blocked-carrying job the revert check requires were never inserted"
      dump 10 /tmp/harness_seed; STATUS=1; continue
    fi
  fi

  # **The same reasoning for 20260910000000's revert**, which names three costs
  # and counts all three: the admin-authored windows that go back to losing
  # their id on an edit, the audit rows whose `admin_update_field_blackout`
  # vocabulary stops having a writer, and the frozen import windows that lose
  # their server-side "not yours to edit" answer. On a freshly migrated database
  # all three are zero and the revert reads as costless.
  #
  # **The three cardinalities are deliberately unequal -- 2, 1, 3.** 20260909's
  # seed records why: with every count at 1 a check reading the WRONG set prints
  # the RIGHT number, and two plants proved exactly that. Do not "tidy" the
  # second blackout or the second and third windows away.
  if [ "$id" = "20260910000000" ]; then
    if ! psql_cmd "INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES ('f0000000-0000-0000-0000-00000000000f','revert-edit@example.test', jsonb_build_object('password_length', 16));
              INSERT INTO public.organizations (id, name, slug)
              VALUES ('f1111111-1111-1111-1111-111111111111','Edit Org','edit-org');
              INSERT INTO public.locations (id, organization_id, name)
              VALUES ('f2222222-2222-2222-2222-222222222222','f1111111-1111-1111-1111-111111111111','Edit Park');
              INSERT INTO public.fields (id, organization_id, location_id, name)
              VALUES ('f3333333-3333-3333-3333-333333333333','f1111111-1111-1111-1111-111111111111','f2222222-2222-2222-2222-222222222222','Edit Pitch');
              INSERT INTO public.field_blackouts (id, organization_id, field_id, blackout_from, blackout_until, reason)
              VALUES ('f4444444-4444-4444-4444-444444444444','f1111111-1111-1111-1111-111111111111','f3333333-3333-3333-3333-333333333333','2026-09-01','2026-09-02','maintenance'),
                     ('f5555555-5555-5555-5555-555555555555','f1111111-1111-1111-1111-111111111111','f3333333-3333-3333-3333-333333333333','2026-10-01','2026-10-02','weather');
              INSERT INTO public.audit_log (user_id, organization_id, action, resource_type, resource_id, metadata)
              VALUES ('f0000000-0000-0000-0000-00000000000f','f1111111-1111-1111-1111-111111111111','settings.updated','field_blackout','f4444444-4444-4444-4444-444444444444',
                      jsonb_build_object('operation','admin_update_field_blackout','phase','update','before','{}'::jsonb,'after','{}'::jsonb));
              INSERT INTO public.field_availability_profiles
                (id, organization_id, season_label, field_id, location, field_name, available_from, available_until)
              VALUES ('f6666666-6666-6666-6666-666666666666','f1111111-1111-1111-1111-111111111111','Fall 2026','f3333333-3333-3333-3333-333333333333','Edit Park','Edit Pitch','2026-08-01','2026-11-30');
              INSERT INTO public.field_blackout_windows (organization_id, profile_id, blackout_from, blackout_until, reason)
              VALUES ('f1111111-1111-1111-1111-111111111111','f6666666-6666-6666-6666-666666666666','2026-09-01','2026-09-30','blackout_months'),
                     ('f1111111-1111-1111-1111-111111111111','f6666666-6666-6666-6666-666666666666','2026-10-01','2026-10-31','blackout_months'),
                     ('f1111111-1111-1111-1111-111111111111','f6666666-6666-6666-6666-666666666666','2026-11-01','2026-11-30','blackout_months');" \
         >/tmp/harness_seed 2>&1; then
      echo "FAIL seeding ${id}: the windows, the edit audit row and the import windows the revert check requires were never inserted"
      dump 10 /tmp/harness_seed; STATUS=1; continue
    fi
  fi

  # **The same reasoning for 20260911000000's revert**, which names five costs
  # and counts three of them: the venues losing a recorded closure, the
  # sub-surfaces losing theirs, and the fields each venue's date was closing by
  # containment. On a freshly migrated database all three are zero and the
  # revert reads as costless.
  #
  # **The three cardinalities are deliberately unequal -- 1, 2, 3.** 20260909's
  # seed records why: with every count at 1 a check reading the WRONG set
  # prints the RIGHT number. One venue retired, THREE fields at it, TWO of
  # those fields carrying a retired sub-surface. A second venue is left
  # unretired so the loop cannot pass by printing every row it sees.
  # Do not "tidy" the third field or the second sub-surface away.
  if [ "$id" = "20260911000000" ]; then
    if ! psql_cmd "INSERT INTO public.organizations (id, name, slug)
              VALUES ('c1111111-1111-1111-1111-11111111111c','Gap B Org','gap-b-org');
              INSERT INTO public.locations (id, organization_id, name, effective_to)
              VALUES ('c2222222-2222-2222-2222-22222222222c','c1111111-1111-1111-1111-11111111111c','Gap B Park', current_date + 30);
              INSERT INTO public.locations (id, organization_id, name)
              VALUES ('c2aaaaaa-2222-2222-2222-22222222222c','c1111111-1111-1111-1111-11111111111c','Gap B Control Park');
              INSERT INTO public.fields (id, organization_id, location_id, name, active)
              VALUES ('c3333333-3333-3333-3333-33333333333c','c1111111-1111-1111-1111-11111111111c','c2222222-2222-2222-2222-22222222222c','Gap B Pitch One', true),
                     ('c4444444-4444-4444-4444-44444444444c','c1111111-1111-1111-1111-11111111111c','c2222222-2222-2222-2222-22222222222c','Gap B Pitch Two', true),
                     ('c5555555-5555-5555-5555-55555555555c','c1111111-1111-1111-1111-11111111111c','c2222222-2222-2222-2222-22222222222c','Gap B Pitch Three', true);
              INSERT INTO public.field_subunits (id, organization_id, field_id, label, effective_to)
              VALUES ('c6666666-6666-6666-6666-66666666666c','c1111111-1111-1111-1111-11111111111c','c3333333-3333-3333-3333-33333333333c','Gap B Pitch One North', current_date + 45),
                     ('c7777777-7777-7777-7777-77777777777c','c1111111-1111-1111-1111-11111111111c','c4444444-4444-4444-4444-44444444444c','Gap B Pitch Two North', current_date + 50);" \
         >/tmp/harness_seed 2>&1; then
      echo "FAIL seeding ${id}: the venue and sub-surface retirements the revert check requires were never inserted"
      dump 10 /tmp/harness_seed; STATUS=1; continue
    fi
  fi

  if [ "$id" = "20260906000000" ]; then
    if ! psql_cmd "INSERT INTO public.organizations (id, name, slug)
              VALUES ('11111111-1111-1111-1111-111111111111','Revert Org','revert-org');
              INSERT INTO public.locations (id, organization_id, name)
              VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Revert Park');
              INSERT INTO public.fields (organization_id, location_id, name, active, effective_to)
              VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','Closing Soon', true, current_date + 30);" \
         >/tmp/harness_seed 2>&1; then
      echo "FAIL seeding ${id}: the future-dated retirement the revert check requires was never inserted"
      dump 10 /tmp/harness_seed; STATUS=1; continue
    fi
  fi

  # **The migration's own PRE-EXISTING warning, on a database that has some.**
  #
  # That branch had never executed. `apply_all` builds from scratch, so when
  # 20260908000000 applies the table is always empty and only its NOTICE branch
  # fires -- and `apply_all` sends migration output to a file it prints only on
  # failure, so nothing was displayed either. The one thing telling a production
  # operator how many field-less profiles they already hold, and pointing at the
  # listing query, was unreached and unseen, while its byte-for-byte twin in the
  # revert had a seed, two greps and a census entry.
  #
  # The seed above has just planted an orphan, so re-applying the migration here
  # runs that branch against real rows. The migration is idempotent -- CREATE OR
  # REPLACE, COMMENT ON, and a reporting DO block -- so this leaves the database
  # exactly as the revert expects to find it.
  if [ "$id" = "20260908000000" ]; then
    if psql_file "$REPO/supabase/migrations/20260908000000_field_availability_profile_field_resolution.sql" \
         >/tmp/harness_reapply 2>&1; then
      if grep -q 'PRE-EXISTING: 1 field_availability_profiles row(s) have field_id IS NULL, carrying 1 blackout window(s)' /tmp/harness_reapply; then
        echo "  | (checked) applying the migration onto a database that already holds a field-less profile warns and counts it"
      else
        echo "FAIL ${id}: re-applied onto a seeded database and the PRE-EXISTING warning did not name the orphan it found"
        dump 10 /tmp/harness_reapply; STATUS=1
      fi
    else
      echo "FAIL ${id}: the migration is not idempotent -- re-applying it failed"
      dump 15 /tmp/harness_reapply; STATUS=1
    fi
  fi

  # **The smoke's two stale-comment needles are proved against the revert.**
  # Section 7 of docs/sql/20260909000000_smoke.sql refuses a comment that still
  # claims a field delete orphans the profile. A NOT-LIKE needle that matches
  # nothing passes vacuously -- the plant `M5 the collapse-blocker comment is
  # left stale` proved exactly that, scoring NOT CAUGHT -- so the smoke now
  # matches each needle against the superseded sentence it was written from,
  # held in the smoke as a literal.
  #
  # That literal is a COPY of wording owned by the revert, and a copy drifts.
  # This check reads the two literals OUT OF THE SMOKE and requires each to
  # appear in the revert. Hard-coding the sentences here instead would have
  # compared this file against the revert and left the smoke -- the file that
  # actually uses them -- unexamined, which is the same self-comparison this
  # harness has been caught making before.
  if [ "$id" = "20260909000000" ]; then
    if ! python3 - "$REPO" <<'NEEDLES'
import io, re, sys
repo = sys.argv[1]
smoke = io.open(repo + '/docs/sql/20260909000000_smoke.sql', encoding='utf8').read()
revert = io.open(repo + '/docs/sql/20260909000000_revert.sql', encoding='utf8').read()
found = re.findall(r"v_stale_(?:view|table) := '((?:[^']|'')*)'", smoke)
if len(found) != 2:
    print('the smoke no longer declares exactly two stale-comment literals; found %d' % len(found))
    sys.exit(1)
bad = [n for n in found if n not in revert]
for n in bad:
    print('the smoke pins a needle to wording the revert does not restore: %s' % n[:90])
sys.exit(1 if bad else 0)
NEEDLES
    then
      echo "FAIL ${id}: the smoke's stale-comment needles no longer match the wording its revert puts back"
      STATUS=1
    else
      echo "  | (checked) both stale-comment literals in the smoke are wording the revert actually restores"
    fi
  fi

  # **The same reasoning for 20260909000000**, whose own WARNING branch counts
  # the field-less profiles it is leaving in place. The seed above planted one,
  # so re-applying here runs the branch that a from-scratch build never
  # reaches. The migration is idempotent -- a reporting DO block, a
  # DROP/ADD CONSTRAINT pair, CREATE OR REPLACE and COMMENT ON -- so this
  # leaves the database exactly as the revert expects to find it.
  if [ "$id" = "20260909000000" ]; then
    if psql_file "$REPO/supabase/migrations/20260909000000_rollback_field_import_booking_guard.sql" \
         >/tmp/harness_reapply 2>&1; then
      if grep -q 'LEAVING 2 field-less availability profile(s), carrying 3 blackout window(s)' /tmp/harness_reapply; then
        echo "  | (checked) applying the migration onto a database that already holds a field-less profile counts what it leaves behind"
      else
        echo "FAIL ${id}: re-applied onto a seeded database and the LEAVING warning did not name the orphan it found"
        dump 10 /tmp/harness_reapply; STATUS=1
      fi
    else
      echo "FAIL ${id}: the migration is not idempotent -- re-applying it failed"
      dump 15 /tmp/harness_reapply; STATUS=1
    fi
  fi

  if psql_file "$REPO/docs/sql/${id}_revert.sql" >/tmp/harness_rev 2>&1; then
    echo "PASS revert ${id}"
    grep -E '^(psql:[^ ]+ )?(NOTICE|WARNING):' /tmp/harness_rev |
      sed -E 's/^psql:[^ ]+ //; s/^/  | /' || true
    if [ "$id" = "20260911000000" ]; then
      # Three counts, three checks, each against a figure the seed above made
      # unique. `closing 3 field(s)` is the containment figure, and it is
      # derived from `fields` rather than from anything the retirement wrote --
      # a retirement writes nothing to a child, so a check reading child state
      # would report zero for a total loss.
      if grep -q 'LOSING venue retirement: Gap B Park' /tmp/harness_rev &&
         grep -q 'closing 3 field(s)' /tmp/harness_rev; then
        echo "  | (checked) the revert named the venue retirement it was about to erase and the fields its containment was closing"
      else
        echo "FAIL revert ${id}: planted a retired venue with three fields and the revert did not name it, or miscounted the containment"
        STATUS=1
      fi
      if grep -q 'LOSING sub-surface retirement: Gap B Pitch One North' /tmp/harness_rev &&
         grep -q 'erasing 1 venue retirement(s) and 2 sub-surface retirement(s)' /tmp/harness_rev; then
        echo "  | (checked) the revert named both sub-surface retirements and totalled the two kinds separately"
      else
        echo "FAIL revert ${id}: planted two retired sub-surfaces and the revert did not name or total them"
        STATUS=1
      fi
      # **The restore is the dangerous half.** Dropping the scoped producer
      # without putting the three-argument one back leaves admin_retire_field,
      # admin_delete_field and rollback_field_import_job raising 42883 on every
      # call -- the three guards standing between an admin click and a
      # destroyed schedule. The revert asserts this itself; this is the
      # independent confirmation, read from the catalogue rather than from the
      # revert's own NOTICE.
      if grep -q 'the three-argument producer is restored with all 6 arms' /tmp/harness_rev; then
        echo "  | (checked) the revert proved its own restore of the three-argument producer"
      else
        echo "FAIL revert ${id}: the revert did not prove it restored the three-argument producer"
        STATUS=1
      fi
      v_scope_verdict=$(psql_cmd "SELECT CASE
             WHEN count(*) = 0 THEN 'GONE'
             WHEN count(*) > 1 THEN 'AMBIGUOUS:' || count(*)
             WHEN bool_or(oidvectortypes(p.proargtypes) <> 'uuid, uuid, date') THEN 'STILL-SCOPED'
             ELSE 'RESTORED'
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'field_bookings'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_scope_verdict" != "RESTORED" ]; then
        echo "FAIL revert ${id}: field_bookings after the revert reads ${v_scope_verdict}, wanted RESTORED"
        STATUS=1
      else
        echo "  | (checked) exactly one public.field_bookings survives the revert, at the three-argument field-scoped signature its three callers use"
      fi
      # And every lifecycle object this migration added is gone. A revert that
      # leaves an RPC calling a producer that can no longer answer its question
      # is worse than one that leaves nothing.
      v_left=$(psql_cmd "SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), 'none')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('admin_retire_location','admin_unretire_location',
                          'admin_retire_field_subunit','admin_unretire_field_subunit',
                          'estate_scope_covers','estate_contained_nodes')" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_left" != "none" ]; then
        echo "FAIL revert ${id}: these objects survived the revert: ${v_left}"
        STATUS=1
      else
        echo "  | (checked) all six lifecycle objects this migration added are gone"
      fi
      v_cols=$(psql_cmd "SELECT coalesce(string_agg(table_name, ',' ORDER BY table_name), 'none')
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'effective_to'
        AND table_name IN ('locations','field_subunits')" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_cols" != "none" ]; then
        echo "FAIL revert ${id}: effective_to survived on ${v_cols}"
        STATUS=1
      else
        echo "  | (checked) both effective_to columns are gone, and fields.effective_to is untouched"
      fi
    fi
    if [ "$id" = "20260906000000" ]; then
      if grep -q 'LOSING future retirement: field Closing Soon' /tmp/harness_rev; then
        echo "  | (checked) the revert named the retirement it was about to erase"
      else
        echo "FAIL revert ${id}: planted a future-dated retirement and the revert did not name it"
        STATUS=1
      fi
    fi
    if [ "$id" = "20260908000000" ]; then
      # It counted what the database already holds. The seed above planted
      # exactly one, so a revert that counted nothing -- or counted rows it
      # should not -- fails here instead of printing a reassuring zero.
      if grep -q 'ORPHANS: 1 field-less availability profile' /tmp/harness_rev; then
        echo "  | (checked) the revert counted the field-less profile already in the database"
      else
        echo "FAIL revert ${id}: planted a field-less profile with a blackout window and the revert did not count it"
        STATUS=1
      fi
      # And it named what restoring the old body costs. A revert that quietly
      # reinstates a silent accretion is the same silence one level up.
      if grep -q 'RESTORING finalize_field_availability_import_job' /tmp/harness_rev; then
        echo "  | (checked) the revert named the import guard it was putting back"
      else
        echo "FAIL revert ${id}: restored the unguarded finalize without naming what that costs"
        STATUS=1
      fi
      # **The migration bundles three fixes and the revert undoes all three.**
      # Restoring the body verbatim also reinstates the outright
      # `warning_summary` assignment and drops the `validation_errors` clearing,
      # and a warning naming one cost of three reads as complete to an operator
      # reverting during an incident. The seed above plants a row refused with
      # reason=field_unresolved so the count in that warning cannot pass on an
      # empty table -- the same reasoning as the orphaned profile beside it.
      if grep -q 'ALSO REVERTING two fixes bundled into 20260908000000' /tmp/harness_rev &&
         grep -q '1 staged row(s) currently refused' /tmp/harness_rev; then
        echo "  | (checked) the revert named the two bundled fixes it also undoes, and counted the rows one of them strands"
      else
        echo "FAIL revert ${id}: planted a row refused with reason=field_unresolved and the revert did not name the two bundled fixes it undoes, or did not count it"
        STATUS=1
      fi
      # **Present in the catalogue is not the same as reverted.** The verdict
      # enumerates the ways this can be wrong rather than testing for the one
      # way it can be right: no function at all, two of them (a second overload
      # is a route round whichever body a caller means), or a body that still
      # carries the guard because the revert was a no-op. `field_unresolved`
      # has no prefix-sibling in this repository, so unlike the
      # field_bookings/field_bookings_digest pair this LIKE cannot fire on a
      # different identifier.
      v_fin_verdict=$(psql_cmd "SELECT CASE
             WHEN count(*) = 0 THEN 'GONE'
             WHEN count(*) > 1 THEN 'AMBIGUOUS:' || count(*)
             WHEN bool_or(p.prosrc LIKE '%field_unresolved%') THEN 'STILL-GUARDED'
             ELSE 'RESTORED'
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'finalize_field_availability_import_job'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_fin_verdict" != "RESTORED" ]; then
        echo "FAIL revert ${id}: finalize_field_availability_import_job after the revert reads ${v_fin_verdict}, wanted RESTORED"
        STATUS=1
      else
        echo "  | (checked) exactly one public.finalize_field_availability_import_job survives the revert, and its body no longer carries the resolution guard"
      fi
    fi
    if [ "$id" = "20260909000000" ]; then
      # **Four warnings, four checks, and two of them carry a count.** LIVE-2's
      # round 1 found a revert naming one cost of three; the answer was not
      # "write three sentences" but "make each sentence a check, and make the
      # countable ones count something that is really there". The seed above
      # planted exactly one attached profile with one window, and exactly one
      # import job carrying a field_rollback.blocked list.
      if grep -q 'EXPOSING 1 availability profile(s) currently attached to a field, carrying 1 blackout window' /tmp/harness_rev &&
         grep -q '2 profile(s) in this database are already in that state' /tmp/harness_rev; then
        echo "  | (checked) the revert counted the attached profile and its window it was about to expose, and the orphan already there"
      else
        echo "FAIL revert ${id}: planted an attached profile with a window and an already-orphaned one, and the revert did not count all three"
        STATUS=1
      fi
      if grep -q 'RESTORING public.field_bookings to five kinds' /tmp/harness_rev; then
        echo "  | (checked) the revert named the sixth booking kind it was removing"
      else
        echo "FAIL revert ${id}: restored the five-kind producer without naming what that costs"
        STATUS=1
      fi
      if grep -q 'RESTORING rollback_field_import_job to its two-table guard' /tmp/harness_rev; then
        echo "  | (checked) the revert named the rollback guard it was putting back"
      else
        echo "FAIL revert ${id}: restored the two-table rollback guard without naming what that costs"
        STATUS=1
      fi
      if grep -q 'ALSO REVERTING two silent switch arms and the blocked list' /tmp/harness_rev &&
         grep -q '1 existing import job(s) carry a field_rollback.blocked list' /tmp/harness_rev; then
        echo "  | (checked) the revert named the two silent arms it restores, and counted the jobs whose blocked list is stranded"
      else
        echo "FAIL revert ${id}: planted a job carrying field_rollback.blocked and the revert did not name the silent arms it restores, or did not count it"
        STATUS=1
      fi
      # **Present in the catalogue is not the same as reverted**, and the two
      # functions fail differently. The producer can be gone, duplicated, or
      # still carrying the sixth arm; the rollback can be gone, duplicated, or
      # still calling the producer. `availability_profile` has no
      # prefix-sibling in this schema, so unlike field_bookings /
      # field_bookings_digest this LIKE cannot fire on a different identifier.
      v_prod_verdict=$(psql_cmd "SELECT CASE
             WHEN count(*) = 0 THEN 'GONE'
             WHEN count(*) > 1 THEN 'AMBIGUOUS:' || count(*)
             WHEN bool_or(p.prosrc LIKE '%availability_profile%') THEN 'STILL-SIX-KINDS'
             ELSE 'RESTORED'
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'field_bookings'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_prod_verdict" != "RESTORED" ]; then
        echo "FAIL revert ${id}: field_bookings after the revert reads ${v_prod_verdict}, wanted RESTORED"
        STATUS=1
      else
        echo "  | (checked) exactly one public.field_bookings survives the revert, and it no longer enumerates the profile"
      fi
      v_roll_verdict=$(psql_cmd "SELECT CASE
             WHEN count(*) = 0 THEN 'GONE'
             WHEN count(*) > 1 THEN 'AMBIGUOUS:' || count(*)
             WHEN bool_or(p.prosrc LIKE '%field_bookings%') THEN 'STILL-CALLS-PRODUCER'
             ELSE 'RESTORED'
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'rollback_field_import_job'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_roll_verdict" != "RESTORED" ]; then
        echo "FAIL revert ${id}: rollback_field_import_job after the revert reads ${v_roll_verdict}, wanted RESTORED"
        STATUS=1
      else
        echo "  | (checked) exactly one public.rollback_field_import_job survives the revert, and it no longer calls the producer"
      fi
      # And the restored constraint is the one that matters, read from the
      # catalogue rather than inferred from the ALTER having parsed.
      v_fk=$(psql_cmd "SELECT COALESCE(max(con.confdeltype::text), 'MISSING')
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_class tgt ON tgt.oid = con.confrelid
       WHERE con.contype = 'f' AND src.relname = 'field_availability_profiles'
         AND tgt.relname = 'fields'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_fk" != "n" ]; then
        echo "FAIL revert ${id}: field_availability_profiles.field_id reads ON DELETE '${v_fk}' after the revert, wanted n (SET NULL)"
        STATUS=1
      else
        echo "  | (checked) field_availability_profiles.field_id is back to ON DELETE SET NULL"
      fi
      # **The revert DROPS two helpers, so the body it restores must not call
      # them.** A restored body that still does raises undefined_function on
      # every subsequent delete -- present in the catalogue and not callable,
      # which is the R3 shape one migration along. Enumerated by the ways it
      # can be wrong rather than tested for the one way it can be right.
      v_adf_verdict=$(psql_cmd "SELECT CASE
             WHEN count(*) = 0 THEN 'GONE'
             WHEN count(*) > 1 THEN 'AMBIGUOUS:' || count(*)
             WHEN bool_or(p.prosrc LIKE '%field_availability_scenario_ids_on_field%'
                       OR p.prosrc LIKE '%prune_empty_field_availability_scenarios%')
               THEN 'STILL-PRUNES'
             ELSE 'RESTORED'
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'admin_delete_field'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_adf_verdict" != "RESTORED" ]; then
        echo "FAIL revert ${id}: admin_delete_field after the revert reads ${v_adf_verdict}, wanted RESTORED"
        STATUS=1
      else
        echo "  | (checked) exactly one public.admin_delete_field survives the revert, and it no longer calls the dropped scenario helpers"
      fi
    fi
    if [ "$id" = "20260910000000" ]; then
      # **Three costs, three checks, and every one of them counts.** The seed
      # above planted 2 admin windows, 1 edit audit row and 3 import windows --
      # three different figures, so a warning counting the WRONG set cannot
      # print the RIGHT number.
      if grep -q 'RESTORING remove-and-re-add as the only way to change a blackout: each of the 2 admin-authored window(s)' /tmp/harness_rev; then
        echo "  | (checked) the revert counted the admin-authored windows that go back to losing their id on an edit"
      else
        echo "FAIL revert ${id}: planted 2 admin-authored blackouts and the revert did not name or count what they lose"
        STATUS=1
      fi
      if grep -q 'ALSO REVERTING the single-entry edit audit shape: 1 existing audit row(s)' /tmp/harness_rev; then
        echo "  | (checked) the revert counted the edit audit rows whose operation stops having a writer"
      else
        echo "FAIL revert ${id}: planted an admin_update_field_blackout audit row and the revert did not name or count the vocabulary it closes"
        STATUS=1
      fi
      if grep -q 'ALSO REVERTING the 0A000 import-owned refusal: 3 window(s)' /tmp/harness_rev; then
        echo "  | (checked) the revert counted the frozen import windows that lose their server-side refusal"
      else
        echo "FAIL revert ${id}: planted 3 import-owned windows and the revert did not name or count the refusal they lose"
        STATUS=1
      fi
      # **Present in the catalogue is not the same as reverted.** This revert
      # drops a function, so the only right answer is GONE -- and the ways it
      # can be wrong are enumerated rather than one way it can be right, the
      # shape LIVE-2's R3 plants established. `SURVIVES` covers a DROP whose
      # argument list drifted from the CREATE's, which is exactly how
      # docs/sql/reverts/20260504060000 became a silent no-op.
      v_upd_verdict=$(psql_cmd "SELECT CASE
             WHEN count(*) = 0 THEN 'GONE'
             WHEN count(*) > 1 THEN 'AMBIGUOUS:' || count(*)
             ELSE 'SURVIVES'
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'admin_update_field_blackout'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_upd_verdict" != "GONE" ]; then
        echo "FAIL revert ${id}: admin_update_field_blackout after the revert reads ${v_upd_verdict}, wanted GONE"
        STATUS=1
      else
        echo "  | (checked) no overload of public.admin_update_field_blackout survives the revert"
      fi
      # ... and its two siblings are untouched. This migration adds a function
      # and changes none, so a revert that took a sibling with it would be
      # destroying capability the operator never asked to lose -- and nothing
      # else here would notice, because every check above is about the new one.
      v_sib=$(psql_cmd "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('admin_create_field_blackout','admin_delete_field_blackout')" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_sib" != "2" ]; then
        echo "FAIL revert ${id}: the create/delete siblings read ${v_sib} after the revert, wanted 2"
        STATUS=1
      else
        echo "  | (checked) both blackout siblings survive the revert untouched"
      fi
    fi
    if [ "$id" = "20260907000000" ]; then
      if grep -q 'EXPOSING 1 practice_assignment' /tmp/harness_rev; then
        echo "  | (checked) the revert counted the practice assignment it was about to expose"
      else
        echo "FAIL revert ${id}: planted a practice_assignment with a field_id and the revert did not count it"
        STATUS=1
      fi
      # It also puts admin_retire_field back on its own four-arm union, and must
      # say so: a revert that silently reinstates an under-reporting guard is
      # the same silence this PR exists to remove, one level up.
      if grep -q 'RESTORING admin_retire_field' /tmp/harness_rev; then
        echo "  | (checked) the revert named the retirement guard it was putting back"
      else
        echo "FAIL revert ${id}: restored the old admin_retire_field without naming what that costs"
        STATUS=1
      fi
      # And the restored RPC must actually WORK -- the producer it used to call
      # is gone by now, so a revert that left the call in place would leave the
      # function raising undefined_function on the next retirement.
      #
      # **Both halves of this check used to pass on the failure they name.** The
      # resolve probe had `:` in one branch and nothing in the other, so it set
      # no status and printed nothing whatever happened. The prosrc probe read
      # `... | grep -q '^t$'`, and a revert that DROPPED admin_retire_field
      # returns zero rows -- no `t`, so the else branch fired and reported the
      # restored function as clean, for a database that no longer has one. Both
      # are now one verdict that a zero-row answer fails loudly, and
      # `R3 revert drops the retirement RPC instead of restoring it` in
      # prove.sh is the positive control for exactly that scenario.
      # **`LIKE '%field_bookings%'` also matched `field_bookings_digest`.** The
      # two helpers share a prefix, so the verdict fired on a body that
      # mentioned only the digest -- which meant the plant aimed at the probe
      # below was caught HERE as well, and scored on borrowed evidence. The
      # digest name is stripped before the producer is looked for.
      v_verdict=$(psql_cmd "SELECT CASE
             WHEN count(*) = 0 THEN 'GONE'
             WHEN count(*) > 1 THEN 'AMBIGUOUS:' || count(*)
             WHEN bool_or(regexp_replace(p.prosrc, 'field_bookings_digest', '', 'g')
                            LIKE '%field_bookings%') THEN 'STILL-CALLS-PRODUCER'
             ELSE 'RESTORED'
           END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'admin_retire_field'" 2>/dev/null || echo "QUERY-FAILED")
      if [ "$v_verdict" != "RESTORED" ]; then
        echo "FAIL revert ${id}: admin_retire_field after the revert reads ${v_verdict}, wanted RESTORED"
        STATUS=1
      else
        echo "  | (checked) exactly one public.admin_retire_field survives the revert, and it no longer calls the dropped producer"
      fi
      # Present in the catalogue is not the same as callable. A NULL org makes
      # it raise -- the point is WHICH error: 22023 from its own validation
      # means the body ran, 42883 means the revert left it calling something
      # that is no longer there.
      # Written to a FILE rather than passed through `psql_cmd`: that helper
      # interpolates its argument through a second shell (`as_pg ... bash -lc`),
      # which ate the `$probe$` dollar-quote tags and left psql parsing a bare
      # `DO $`. A heredoc keeps the SQL as SQL.
      #
      # **The probe has to REACH the enumeration.** Its first version called the
      # RPC with a NULL organisation, which the function rejects in its opening
      # statement -- so it never got as far as the `field_bookings` call, and a
      # reverted retire still referencing the dropped producer printed RESOLVED.
      # That is the third check in this file to report health without exercising
      # the thing it names, after the `:`-in-one-branch probe and the
      # zero-rows-reads-clean probe. A probe that cannot fail is worse than no
      # probe, because it occupies the place where a real one would go.
      #
      # So it builds a real org, a real admin session and a booked field -- the
      # same prelude the scenario generator uses -- and requires the call to run
      # all the way to a decision. `field_bookings` is dropped by this revert, so
      # a retire still calling it raises 42883 here and the harness goes red.
      #
      # **Staged with an unchecked `cat`, to a path reused across runs.** A
      # write that failed left the PREVIOUS run's probe on disk and psql ran
      # that one -- the identical stale-staging shape `psql_file` was fixed for
      # last round, on the one call site that does its own staging. Removed
      # first so a failed write leaves nothing to run, and the write is checked.
      rm -f /tmp/harness_rev_probe.sql
      if ! cat >/tmp/harness_rev_probe.sql <<'PROBE'
DO $probe$
DECLARE
    v_org uuid; v_loc uuid; v_field uuid; v_user uuid := gen_random_uuid();
    v_res jsonb;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES (v_user, 'revert-probe@example.test', jsonb_build_object('password_length', 16))
    ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Revert Probe Org','revert-probe-org')
    RETURNING id INTO v_org;
    INSERT INTO public.profiles (id, email) VALUES (v_user, 'revert-probe@example.test')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.organization_members (organization_id, profile_id, role)
    VALUES (v_org, v_user, 'admin');
    PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
    INSERT INTO public.locations (organization_id, name) VALUES (v_org,'Revert Probe Park')
    RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name)
    VALUES (v_org, v_loc, 'Revert Probe Pitch') RETURNING id INTO v_field;
    -- A booking AFTER the retirement date, so every arm of the enumeration runs
    -- and returns a row rather than short-circuiting on an empty field.
    INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index)
    VALUES (v_org, v_field, current_date + 30, 1);

    v_res := public.admin_retire_field(v_org, v_field, current_date + 10, false);
    IF v_res IS NULL OR NOT (v_res ? 'retired') THEN
        RAISE EXCEPTION 'UNRESOLVED: the restored admin_retire_field returned %', v_res;
    END IF;
    -- It enumerated, found the slot, and refused. Anything else means the body
    -- did not run the enumeration this check exists to exercise.
    IF (v_res->>'retired')::boolean IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'UNRESOLVED: the restored admin_retire_field did not refuse a booked field: %', v_res;
    END IF;
    RAISE NOTICE 'RESOLVED: the restored admin_retire_field enumerated % booking(s) and refused',
        v_res->>'affected_count';

    -- **And the CONFIRMED path, which the refusal above never reaches.** A
    -- revert that restored the refusal branch but left the confirmed branch on
    -- `field_bookings_digest` -- the before-audit, the UPDATE, the after-audit,
    -- the success RETURN -- passed every check here while raising 42883 on the
    -- first confirmed retirement anyone ran: the `pg_proc` verdict strips the
    -- digest name by design, and a probe that only ever refuses never executes
    -- those statements. A broken revert scoring clean is the exact failure this
    -- stage exists to make impossible, so the probe drives both halves.
    v_res := public.admin_retire_field(v_org, v_field, current_date + 10, true);
    IF v_res IS NULL OR (v_res->>'retired')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'UNRESOLVED: the restored admin_retire_field did not complete a confirmed retirement: %', v_res;
    END IF;
    RAISE NOTICE 'RESOLVED: the restored admin_retire_field also ran its confirmed path to completion';

    DELETE FROM public.organizations WHERE id = v_org;
    DELETE FROM auth.users WHERE id = v_user;
END
$probe$;
PROBE
      then
        echo "FAIL revert ${id} probe: the probe script could not be staged"
        STATUS=1
      # **`probe` is no longer enough to name this check, and the commit that
      # made that true said the opposite here.** This comment used to read "the
      # failure line carries `probe` so `prove.sh`'s `expect` can name THIS
      # check rather than the stage" -- and then the staging branch directly
      # above it added a SECOND line beginning `FAIL revert <id> probe:`, in the
      # same commit, leaving the assertion describing the state it had just
      # ended. Six lines in this stage now begin `FAIL revert 20260907000000`.
      # Both plants aimed here carry `^` and the whole line, which is the only
      # form that separates the probe that RAN from the probe that could not be
      # staged.
      elif psql_file /tmp/harness_rev_probe.sql >/tmp/harness_rev_probe 2>&1; then
        echo "  | (checked) the restored admin_retire_field resolves and runs both its refusal and its confirmed path"
      else
        echo "FAIL revert ${id} probe: the restored admin_retire_field does not resolve"
        dump 5 /tmp/harness_rev_probe
        STATUS=1
      fi
    fi
  else
    echo "FAIL revert ${id}"; dump 10 /tmp/harness_rev; STATUS=1
  fi
done

# ---------------------------------------------------------------------------
# The emergency rollback nobody was running
# ---------------------------------------------------------------------------
#
# `docs/sql/reverts/20260504060000_admin_facility_mutation_rpcs.sql` is the file
# an operator runs at 2am when the admin facility RPCs have to go. Nothing
# executed it, and 20260907000000 invalidated it: it drops
# `admin_delete_field(uuid, uuid)`, a signature that no longer exists, so the
# DROP became a silent no-op and the script COMMITTED and reported success while
# leaving the guarded three-argument function in place.
#
# A fix to a rollback nothing runs is a claim, not a fix. So it runs here, on a
# database built to head -- the state it would actually be used against -- and
# the assertion is that no overload of any of the four names survives.
echo "=== emergency rollback docs/sql/reverts/20260504060000 (on a database built to head) ==="
if ! fresh_db; then
  echo "FAIL building a fresh database for the emergency rollback"; STATUS=1
else
  if ! apply_all; then
    echo "FAIL building to head for the emergency rollback"; STATUS=1
  else
    # The precondition, asserted rather than assumed: if the guarded delete were
    # already absent the rollback would have nothing to remove and would pass
    # for the reason this whole stage exists to rule out.
    v_before=$(psql_cmd "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.proname = 'admin_delete_field'" 2>/dev/null || echo 0)
    if [ "$v_before" != "1" ]; then
      echo "FAIL emergency rollback 20260504060000: expected exactly one admin_delete_field before it runs, found ${v_before}"
      STATUS=1
    elif psql_file "$REPO/docs/sql/reverts/20260504060000_admin_facility_mutation_rpcs.sql" \
           >/tmp/harness_emerg 2>&1; then
      echo "PASS emergency rollback 20260504060000"
      grep -E '^(psql:[^ ]+ )?(NOTICE|WARNING):' /tmp/harness_emerg |
        sed -E 's/^psql:[^ ]+ //; s/^/  | /' || true
      v_left=$(psql_cmd "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.proname IN
                            ('admin_delete_field','admin_update_field','admin_create_field','admin_create_location')" 2>/dev/null || echo -1)
      if [ "$v_left" = "0" ]; then
        echo "  | (checked) the rollback removed every overload of all four admin facility RPCs"
      else
        echo "FAIL emergency rollback 20260504060000: ${v_left} admin facility RPC(s) survived a rollback that reported success"
        STATUS=1
      fi
      # And it must NOT take the producer with it: admin_retire_field belongs to
      # a different migration and still calls public.field_bookings.
      if psql_cmd "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'field_bookings'" 2>/dev/null |
           grep -q '^1$'; then
        echo "  | (checked) it left public.field_bookings standing, which admin_retire_field still calls"
      else
        echo "FAIL emergency rollback 20260504060000: it dropped public.field_bookings, breaking admin_retire_field"
        STATUS=1
      fi
    else
      echo "FAIL emergency rollback 20260504060000"; dump 10 /tmp/harness_emerg; STATUS=1
    fi
  fi
fi

[ "$STATUS" -eq 0 ] && echo "HARNESS OK" || echo "HARNESS FAILED"
exit $STATUS
