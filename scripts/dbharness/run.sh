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

fresh_db() {
  if ! as_pg "psql -h ~/sock -U postgres -q -c 'DROP DATABASE IF EXISTS $DB' -c 'CREATE DATABASE $DB'" >/tmp/harness_freshdb 2>&1; then
    echo "FAIL creating a fresh database"; tail -10 /tmp/harness_freshdb; return 1
  fi
  # **The prelude's exit status was thrown away.** `psql_file ... >/dev/null`
  # discarded both the output and, because nothing tested `$?`, the failure --
  # so a prelude that died part-way left a half-built stand-in and the run
  # carried on against it. Found by trying to prove the baseline gate could
  # fail: a deliberately broken prelude produced BASELINE GREEN and fifteen
  # meaningless CAUGHTs. The gate was right; what it stood on was not.
  if ! psql_file "$REPO/scripts/dbharness/prelude.sql" >/tmp/harness_prelude 2>&1; then
    echo "FAIL applying the prelude"; tail -20 /tmp/harness_prelude; return 1
  fi
}

apply_all() {
  local applied=0
  for m in "$REPO"/supabase/migrations/*.sql; do
    if ! psql_file "$m" >/tmp/harness_err 2>&1; then
      echo "FAIL applying $(basename "$m")"
      tail -20 /tmp/harness_err
      return 1
    fi
    applied=$((applied + 1))
  done
  echo "applied $applied migrations"
  # Meta-assertion: a loop that applied nothing would print "applied 0" and
  # every check below would pass against an empty database.
  if [ "$applied" -lt 100 ]; then echo "FAIL: only $applied migrations applied"; return 1; fi
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
# **Scoped to the migrations this PR adds** (`NEW_MIGRATIONS`, three of them),
# and that is a deliberate limit
# worth stating. Several pre-existing smokes are BEHAVIOURAL: they seed an org,
# assume an authenticated admin session, and exercise an RPC. They fail here for
# want of fixtures and a real JWT, not because anything is wrong with them --
# running them would need a seeding layer this harness does not have and the
# pgTAP suite already does. Claiming to verify them would be the hollow kind of
# green this whole phase exists to stop.
STATUS=0
NEW_MIGRATIONS=(20260906000000 20260906000100 20260907000000)

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
    echo "FAIL smoke ${id}"; tail -15 /tmp/harness_smoke; STATUS=1
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
  echo "FAIL generating the scenario script"; tail -10 /tmp/harness_scen_gen; STATUS=1
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
  echo "FAIL scenario table"; tail -15 /tmp/harness_scen_out; STATUS=1
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
  ok=1
  for m in "$REPO"/supabase/migrations/*.sql; do
    psql_file "$m" >/tmp/harness_err 2>&1 || { ok=0; break; }
    [[ "$(basename "$m")" == ${id}* ]] && break
  done
  if [ "$ok" -eq 0 ]; then echo "FAIL building up to ${id}"; STATUS=1; continue; fi

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
  if [ "$id" = "20260907000000" ]; then
    psql_cmd "INSERT INTO public.organizations (id, name, slug)
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
              VALUES ('33333333-3333-3333-3333-333333333333','88888888-8888-8888-8888-888888888888','55555555-5555-5555-5555-555555555555');" >/dev/null
  fi

  if [ "$id" = "20260906000000" ]; then
    psql_cmd "INSERT INTO public.organizations (id, name, slug)
              VALUES ('11111111-1111-1111-1111-111111111111','Revert Org','revert-org');
              INSERT INTO public.locations (id, organization_id, name)
              VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Revert Park');
              INSERT INTO public.fields (organization_id, location_id, name, active, effective_to)
              VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','Closing Soon', true, current_date + 30);" >/dev/null
  fi

  if psql_file "$REPO/docs/sql/${id}_revert.sql" >/tmp/harness_rev 2>&1; then
    echo "PASS revert ${id}"
    grep -E '^(psql:[^ ]+ )?(NOTICE|WARNING):' /tmp/harness_rev |
      sed -E 's/^psql:[^ ]+ //; s/^/  | /' || true
    if [ "$id" = "20260906000000" ]; then
      if grep -q 'LOSING future retirement: field Closing Soon' /tmp/harness_rev; then
        echo "  | (checked) the revert named the retirement it was about to erase"
      else
        echo "FAIL revert ${id}: planted a future-dated retirement and the revert did not name it"
        STATUS=1
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
      cat >/tmp/harness_rev_probe.sql <<'PROBE'
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
      # The failure line carries `probe` so `prove.sh`'s `expect` can name THIS
      # check rather than the stage: both this and the verdict above print
      # `FAIL revert 20260907000000...`, and a substring match cannot tell two
      # checks apart when one is a prefix of the other's line.
      if psql_file /tmp/harness_rev_probe.sql >/tmp/harness_rev_probe 2>&1; then
        echo "  | (checked) the restored admin_retire_field resolves and runs both its refusal and its confirmed path"
      else
        echo "FAIL revert ${id} probe: the restored admin_retire_field does not resolve"
        tail -5 /tmp/harness_rev_probe
        STATUS=1
      fi
    fi
  else
    echo "FAIL revert ${id}"; tail -10 /tmp/harness_rev; STATUS=1
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
  ok=1
  for m in "$REPO"/supabase/migrations/*.sql; do
    psql_file "$m" >/tmp/harness_err 2>&1 || { ok=0; break; }
  done
  if [ "$ok" -eq 0 ]; then
    echo "FAIL building to head for the emergency rollback"; tail -5 /tmp/harness_err; STATUS=1
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
      echo "FAIL emergency rollback 20260504060000"; tail -10 /tmp/harness_emerg; STATUS=1
    fi
  fi
fi

[ "$STATUS" -eq 0 ] && echo "HARNESS OK" || echo "HARNESS FAILED"
exit $STATUS
