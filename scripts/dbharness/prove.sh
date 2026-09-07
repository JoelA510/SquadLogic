#!/usr/bin/env bash
# Prove each smoke FAILS when the defect it exists to catch is planted.
#
# A smoke that passes proves nothing on its own -- three review rounds have
# found checks that could not fail. Each entry below plants one defect in a
# migration, re-runs the harness, and requires it to go RED.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
M1="$REPO/supabase/migrations/20260906000000_field_effective_dating.sql"
M2="$REPO/supabase/migrations/20260906000100_field_blackouts.sql"
M3="$REPO/supabase/migrations/20260907000000_field_delete_booking_guard.sql"
R1="$REPO/docs/sql/20260906000000_revert.sql"
R3="$REPO/docs/sql/20260907000000_revert.sql"
ATTEMPTED=0; PASS=0; FAIL=0; MISS=0

# **Refuse to start on a stale backup.** `plant()` writes `<file>.orig` before
# it mutates and removes it on the way out; a run killed in between leaves one
# behind. Mutating on top of that would restore the WRONG content when this run
# finishes -- the surviving `.orig` is whatever the dead run had saved, not what
# is on disk now -- and a byte-identical copy of a migration sitting in
# `supabase/migrations/` is also something a directory glob may pick up. So:
# find one, stop, and say what to do about it. `.gitignore` covers `*.orig` as
# the second line of defence, not the first.
for f in "$M1" "$M2" "$M3" "$R1" "$R3"; do
  if [ -e "$f.orig" ]; then
    echo "REFUSING TO START: stale backup $f.orig" >&2
    echo "  A previous run died between backing up and restoring. Compare it with" >&2
    echo "  the live file, keep whichever is correct, and delete the .orig." >&2
    exit 2
  fi
done

# Restore anything still planted if this run is interrupted, so the next one is
# not blocked by a backup THIS run abandoned.
restore_all() {
  local f
  for f in "$M1" "$M2" "$M3" "$R1" "$R3"; do
    if [ -e "$f.orig" ]; then
      mv -f "$f.orig" "$f"
      echo "restored $(basename "$f") from its backup" >&2
    fi
  done
}

# **A signal handler that returns does not stop the script.** The first version
# of this was `trap restore_all EXIT INT TERM`, and it made things worse rather
# than better: bash resumes where it left off after a trap handler returns, so
# `timeout 20 prove.sh` restored the file and then carried straight on planting.
# The run outlived its own timeout, and because the LAST plant re-created the
# backup after the handler had cleared it, the abandoned `.orig` this trap
# exists to prevent survived anyway. A signal now restores and EXITS; only the
# EXIT trap is allowed to return.
#
# **The second version's comment was also wrong, and this one was measured.**
# It ran `pkill -TERM -P $$` and claimed to "kill the in-flight harness". Bash
# defers a trap until the running FOREGROUND command finishes, so with
# `out="$(bash run.sh)"` the handler could not run until `run.sh` had already
# exited -- there was never an in-flight harness left to kill. Measured rather
# than reasoned about: TERM sent at t+0, handler observed running at t+27, after
# the 30s foreground command completed. A bare `timeout` hid it, because timeout
# signals the whole process group and the child dies on its own.
#
# `wait` IS interruptible, so `run.sh` is started in the BACKGROUND and waited
# on. Same measurement, same script: handler at t+0, and it genuinely killed the
# child. That is worth more than the comment fix -- an interrupted proof now
# stops in moments rather than after the current two-minute harness run.
HARNESS_PID=""
kill_harness() {
  [ -n "$HARNESS_PID" ] || return 0
  kill -0 "$HARNESS_PID" 2>/dev/null || return 0
  # Descendants first: killing the shell alone orphans the psql it is waiting
  # on, which was visible in the same experiment.
  pkill -TERM -P "$HARNESS_PID" 2>/dev/null
  kill -TERM "$HARNESS_PID" 2>/dev/null
}
on_signal() {
  trap - EXIT INT TERM
  kill_harness
  restore_all
  exit 130
}
trap restore_all EXIT
trap on_signal INT TERM

# **A green baseline, asserted before anything is planted.**
#
# Without this the whole proof has the defect it exists to find. Any harness
# failure unrelated to a plant -- the cluster refusing to start, a stub
# extension missing, an unrelated migration breaking -- makes EVERY plant report
# CAUGHT, and "11 caught, 0 not caught" exits 0. In that mode the proof cannot
# fail, which is precisely the shape it was written to detect. I found and fixed
# exactly this in the JS mutation harness last round and did not carry it one
# directory across.
#
# So: the unmutated harness must pass first. If it does not, nothing below is
# evidence of anything and the run stops rather than printing eleven CAUGHTs.
echo "=== baseline: the unmutated harness must pass before any plant ==="
bash "$REPO/scripts/dbharness/run.sh" >/tmp/harness_baseline_out 2>&1 &
HARNESS_PID=$!
wait "$HARNESS_PID"; baseline_status=$?
HARNESS_PID=""
baseline_out="$(cat /tmp/harness_baseline_out)"
if [ "$baseline_status" -eq 0 ]; then
  echo "BASELINE GREEN"
else
  echo "BASELINE RED -- refusing to plant. Every plant would report CAUGHT and prove nothing." >&2
  echo "$baseline_out" | tail -25 >&2
  exit 3
fi

# **A plant is CAUGHT only if the check it targets goes red.**
#
# Reading `run.sh`'s aggregate exit status alone was not evidence of anything in
# particular. The three scenario-table plants were all independently caught by
# `docs/sql/20260906000000_smoke.sql`, which runs EARLIER in the same script, so
# the run exited non-zero and every one scored CAUGHT while the scenario table
# was free to pass them. Executed and confirmed: with the scenario runner's
# expected-active assertion neutered and the retire defect planted, the harness
# printed `FAIL smoke ... / PASS scenario table / HARNESS FAILED` and this file
# called it a catch. The scenario table is the whole mechanism for ending the
# mock/SQL divergence, and its evidence was borrowed from the smoke.
#
# A plant now names the check that must fail. `plant <label> <file> <old> <new>
# [expect]` where `expect` is a substring of the FAIL line -- "smoke
# 20260906000000", "scenario table", "revert 20260906000000". Omitted means
# "any failure will do", which is honest for a plant that stops the migration
# applying at all and cannot reach a named check.
plant() { # label file old new [expected-failing-check] [check-that-must-stay-green]
  local label="$1" file="$2" old="$3" new="$4" expect="${5:-}" green="${6:-}"
  ATTEMPTED=$((ATTEMPTED+1))
  # **What the file looked like before this run touched it.** See the restore
  # check below for why a checksum rather than trust.
  local before_sum
  before_sum="$(sha256sum "$file" | cut -d' ' -f1)"
  python3 - "$file" "$old" "$new" <<'PY'
import io,sys
f,old,new=sys.argv[1],sys.argv[2],sys.argv[3]
s=io.open(f,encoding='utf8').read()
if s.count(old)!=1:
    print(f'ANCHOR-MISS {s.count(old)}'); sys.exit(2)
io.open(f+'.orig','w',encoding='utf8').write(s)
io.open(f,'w',encoding='utf8').write(s.replace(old,new,1))
PY
  if [ $? -ne 0 ]; then
    printf '%-52s ANCHOR-MISS (meaningless)\n' "$label"
    MISS=$((MISS+1)); FAIL=$((FAIL+1)); return
  fi
  # **Detect by EXIT STATUS, not by a string.** The first version grepped for
  # "HARNESS FAILED", which run.sh only prints if it reaches the end -- a
  # migration that fails to APPLY exits early, so the loudest possible catch was
  # recorded as NOT CAUGHT. Six of ten results were wrong for that reason.
  local out status
  bash "$REPO/scripts/dbharness/run.sh" >/tmp/harness_plant_out 2>&1 &
  HARNESS_PID=$!
  wait "$HARNESS_PID"; status=$?
  HARNESS_PID=""
  out="$(cat /tmp/harness_plant_out)"
  python3 -c "
import io,os,sys
f=sys.argv[1]
orig=io.open(f+'.orig',encoding='utf8').read()
io.open(f,'w',encoding='utf8').write(orig); os.remove(f+'.orig')" "$file"
  # **Verify the restore, byte for byte.** `prove-mock.mjs` has always done this
  # and exits 4 when the mock client does not match what it read at start; this
  # side restored a MIGRATION and simply trusted that it worked -- the twin with
  # the correction on one arm only, which is the recurring shape of this PR.
  #
  # Not hypothetical. A container died mid-plant in this very series and left
  # `20260906000100_field_blackouts.sql` on disk with `WITH (security_invoker =
  # true)` stripped from the `field_closures` view -- the exact RLS bypass the
  # new pgTAP test exists to catch -- with its `.orig` beside it. Silence from
  # this function is what a successful restore and an abandoned mutation both
  # look like, so it is no longer taken on trust. A mismatch stops the run
  # rather than planting the next defect on top of a file that is already wrong.
  if [ "$(sha256sum "$file" | cut -d' ' -f1)" != "$before_sum" ]; then
    echo "RESTORE FAILED: $(basename "$file") does not match what was read before planting" >&2
    echo "  The planted mutation may still be on disk. Compare it against git," >&2
    echo "  repair the file, and only then re-run." >&2
    exit 4
  fi
  if [ "$status" -ne 0 ]; then
    if [ -n "$expect" ] && ! grep -qF "FAIL $expect" <<<"$out"; then
      # The harness went red, but not where this plant was aimed. Some other
      # check caught it -- which is exactly the borrowed-evidence mode above --
      # so it is NOT a catch for the named check and the difference is printed.
      printf '%-52s MISATTRIBUTED  <-- red, but not at "%s"\n' "$label" "$expect"
      FAIL=$((FAIL+1))
      grep -E '^(applied|PASS|FAIL|BASELINE|HARNESS)' <<<"$out" | sed 's/^/    /'
      return
    fi
    # **A plant aimed at one check, that another check was supposed NOT to
    # see.** Naming the failing check stops evidence being borrowed from a
    # check that ran earlier, but it does not show the other check stayed
    # green -- and for a plant whose whole purpose is "nothing else in the
    # harness can see this", that is the claim. `green` asserts it, so an
    # isolation that used to be argued in a comment is now measured on every
    # run and cannot quietly stop being true.
    if [ -n "$green" ] && ! grep -qF "PASS $green" <<<"$out"; then
      printf '%-52s BORROWED  <-- "%s" did not stay green\n' "$label" "$green"
      FAIL=$((FAIL+1))
      grep -E '^(applied|PASS|FAIL|BASELINE|HARNESS)' <<<"$out" | sed 's/^/    /'
      return
    fi
    printf '%-52s CAUGHT%s%s\n' "$label" "${expect:+ (at $expect)}" \
      "${green:+, $green stayed green}"; PASS=$((PASS+1))
  else
    # **Print the transcript on a miss.** `out` was captured and never read --
    # a field parsed and left unread, in the tool whose whole output is the
    # evidence. A NOT CAUGHT line on its own says a defect went undetected and
    # nothing about what the harness actually did, so the next step was always
    # to re-run by hand. The failing case is the one worth keeping the
    # transcript of; a catch needs no explanation.
    printf '%-52s NOT CAUGHT  <-- the check is hollow\n' "$label"; FAIL=$((FAIL+1))
    echo "$out" | grep -E '^(applied|PASS|FAIL|BASELINE|HARNESS|  \|)' | sed 's/^/    /'
  fi
}

plant "M3 retire deactivates a FUTURE retirement" "$M3" \
  "        active = v_before.active AND public.field_is_live_on(p_effective_to)," \
  "        active = false," \
  "smoke 20260906000000"
plant "M1 field_is_live_on declared IMMUTABLE" "$M1" \
  "LANGUAGE sql
STABLE
SET search_path = public" \
  "LANGUAGE sql
IMMUTABLE
SET search_path = public" \
  "smoke 20260906000000"
plant "M1 trigger does not deactivate" "$M1" \
  "    IF NOT public.field_is_live_on(NEW.effective_to) THEN" \
  "    IF false THEN" \
  "smoke 20260906000000"
plant "M1 window read exclusive, not inclusive" "$M1" \
  "  SELECT p_effective_to IS NULL OR p_effective_to >= COALESCE(p_on, current_date);" \
  "  SELECT p_effective_to IS NULL OR p_effective_to > COALESCE(p_on, current_date);" \
  "smoke 20260906000000"
plant "M2 view loses security_invoker" "$M2" \
  "WITH (security_invoker = true) AS" \
  "AS" \
  "smoke 20260906000100"
plant "M2 scope columns collapse to one meaning" "$M2" \
  "    NULL::uuid AS closes_location_id," \
  "    f.location_id AS closes_location_id," \
  "smoke 20260906000100"
plant "M2 reason enum widened to anything" "$M2" \
  "    CHECK (reason IN ('maintenance','weather','event','permit','closed','other'))," \
  "    CHECK (reason IS NOT NULL)," \
  "smoke 20260906000100"
plant "M2 scope CHECK allows both or neither" "$M2" \
  "  CONSTRAINT field_blackouts_scope_check
    CHECK (num_nonnulls(location_id, field_id) = 1)," \
  "  CONSTRAINT field_blackouts_scope_check
    CHECK (num_nonnulls(location_id, field_id) >= 0)," \
  "smoke 20260906000100"
plant "M2 updated_at trigger removed" "$M2" \
  "CREATE TRIGGER field_blackouts_set_timestamp" \
  "CREATE TRIGGER field_blackouts_set_timestamp_disabled" \
  "smoke 20260906000100"
plant "M2 note carries the import reason again" "$M2" \
  "    NULL::text AS note,
    -- The import's own words, under their own name, on their own arm.
    w.reason AS source_reason_text," \
  "    w.reason AS note,
    NULL::text AS source_reason_text," \
  "smoke 20260906000100"

# **The scenario table, planted from the SQL side.** The whole point of the
# table is that a fix landing on one implementation and not the other fails on
# the side that missed it, so both directions must be shown: these plant against
# Postgres, and the mutation sweep in the report plants the same two defects
# against the mock. Both are the round-3 HIGHs, in the arm that had them right.
plant "SCEN retire un-deactivates an inactive field" "$M3" \
  "        active = v_before.active AND public.field_is_live_on(p_effective_to)," \
  "        active = public.field_is_live_on(p_effective_to)," \
  "scenario table"
plant "SCEN unretire reactivates what it never closed" "$M1" \
  "        active = v_before.active,
        updated_at = timezone('utc', now())" \
  "        active = true,
        updated_at = timezone('utc', now())" \
  "scenario table"
plant "SCEN retire stops auditing before" "$M3" \
  "            'operation', 'admin_retire_field',
            'phase', 'before'," \
  "            'operation', 'admin_retire_field',
            'phase', 'after'," \
  "scenario table"
plant "M2 the two blackout tables share a policy name" "$M2" \
  "CREATE POLICY \"Admin field blackouts: members select\"" \
  "CREATE POLICY \"Field Blackouts: members select\"" \
  "smoke 20260906000100"

# **Plants only the scenario table can see.**
#
# This comment used to predict that the three SCEN plants above would come back
# MISATTRIBUTED because "the smoke catches them first". Running it proved that
# wrong, and the correction matters more than the prediction: `run.sh` does NOT
# stop at a failing smoke. Every check still runs and prints its own line, so
# attribution is decided by which line appears, not by which check ran first,
# and all three are scored CAUGHT at the scenario table because the scenario
# table genuinely does go red on them.
#
# They are red at the SMOKE as well, though, so on their own they cannot show
# the table sees anything the smoke does not. These two can, and are the missing
# evidence: the M2 smoke never inserts a TIMED blackout, so nothing else in the
# harness exercises the two time constraints on real rows. Both plants weaken a
# predicate without removing the constraint, so the smoke's "expected 5 CHECK
# constraints" still counts five.
#
# The sixth argument makes that ENFORCED rather than argued. The M2 smoke must
# still PASS, so if either plant ever becomes visible to the smoke this reports
# BORROWED rather than quietly scoring a catch the smoke supplied -- which is
# the exact failure this whole mechanism exists to stop, one level up.
# Measured on the committed tree: `PASS smoke 20260906000000 / PASS smoke
# 20260906000100 / FAIL scenario table / HARNESS FAILED`.
plant "ONLY-SCEN inverted blackout times accepted" "$M2" \
  "          AND end_minutes > start_minutes)" \
  "          AND end_minutes >= 0)" \
  "scenario table" \
  "smoke 20260906000100"
plant "ONLY-SCEN half a blackout window accepted" "$M2" \
  "    CHECK (num_nonnulls(start_minutes, end_minutes) IN (0, 2))," \
  "    CHECK (num_nonnulls(start_minutes, end_minutes) IN (0, 1, 2))," \
  "scenario table" \
  "smoke 20260906000100"

# ---------------------------------------------------------------------------
# LIVE-1: admin_delete_field's booking guard, and the foreign key beside it
# ---------------------------------------------------------------------------
#
# **Both RPCs now enumerate through one producer**, so the plants below aim at
# the shared reading as well as at each caller. A plant that only one of the two
# would have caught is the shape this PR removed. `games` carries no field_id,
# so a census by column name cannot see this arm at all and the cascade closure
# is the only thing that can -- dropping it must go red.
plant "M3 the shared producer loses its games arm" "$M3" \
    "    SELECT 'game'::text, g.id," \
    "    SELECT 'not_a_game'::text, g.id," \
  "smoke 20260907000000" \
  "smoke 20260906000000"
plant "M3 retire reads a NULL confirmation as yes" "$M3" \
  "    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'operation', 'admin_retire_field'," \
  "    IF v_affected_count > 0 AND NOT p_confirm THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'operation', 'admin_retire_field'," \
  "scenario table" \
  "smoke 20260906000000"
plant "M3 delete reads a NULL confirmation as yes" "$M3" \
  "    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'setting', 'facility.field'," \
  "    IF v_affected_count > 0 AND NOT p_confirm THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'setting', 'facility.field'," \
  "scenario table" \
  "smoke 20260906000000"
# **Re-inlining the union is the defect the producer exists to stop**, and the
# smoke is what notices. Nothing else can: the re-inlined copy below is a
# faithful one, so behaviour is unchanged until it drifts -- which is exactly
# how the two answers came to exist in the first place.
plant "M3 retire keeps a union of its own again" "$M3" \
  "    FROM public.field_bookings(p_organization_id, p_field_id, p_effective_to) b;" \
  "    FROM (SELECT kind, booking_id, on_date, week_index, undated, unbounded
            FROM public.field_bookings(p_organization_id, p_field_id, p_effective_to)
            UNION ALL SELECT NULL, NULL, NULL, NULL, NULL, NULL WHERE false) b;" \
  "smoke 20260907000000" \
  "scenario table"
# The audit digest keeps a refusal from writing an unbounded row. Remove the cap
# and the smoke's bound check goes red.
plant "M3 the refusal embeds the whole list in the audit row" "$M3" \
  "                'affected', public.field_bookings_digest(v_affected),
                'previous', to_jsonb(v_existing)" \
  "                'affected', v_affected,
                'previous', to_jsonb(v_existing)" \
  "smoke 20260907000000" \
  "scenario table"
#
# The sixth argument is load-bearing on all four. Each names a check that must
# stay GREEN, so a catch supplied by a check that ran earlier is reported
# BORROWED rather than scored -- the failure mode round 3 found in this very
# file, where three plants aimed at the scenario table were being caught by a
# smoke that ran before it.
# The guard line is now IDENTICAL in both RPCs -- delete and retire read the
# same shape -- so an anchor that is only that line matches twice and `plant`
# refuses it. Each is disambiguated by the first key of the audit row beneath
# it, the same way the two NULL-confirmation plants above are.
plant "M3 delete loses its booking guard entirely" "$M3" \
  "    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'setting', 'facility.field'," \
  "    IF false THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'setting', 'facility.field'," \
  "smoke 20260907000000" \
  "smoke 20260906000000"
plant "M3 practice_assignments cascades instead of unassigning" "$M3" \
  "  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE SET NULL;" \
  "  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE CASCADE;" \
  "smoke 20260907000000" \
  "scenario table"
# **The unguarded overload survives.** Dropping the two-argument function is
# what stops a caller reaching the old body; without the DROP both exist, and
# the guard is a door beside an open window. Nothing else in the harness looks
# at the signature -- the scenario table calls with three named arguments and
# resolves unambiguously either way -- so this is the smoke's own catch.
plant "M3 the unguarded two-arg overload is left standing" "$M3" \
  "DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid);" \
  "-- overload left in place" \
  "smoke 20260907000000" \
  "scenario table"
# **A plant only the scenario table can see.** The smoke asserts that a refusal
# writes ONE `refused` audit row; it does not assert that a refusal writes
# nothing ELSE. The scenario table names the exact phase set per case, so a
# refusal that also recorded `before` -- an audit trail claiming a deletion was
# begun when it was refused -- fails there and nowhere else.
plant "ONLY-SCEN refusal also audits a phase it never reached" "$M3" \
  "        );
        RETURN jsonb_build_object(
            'deleted', false," \
  "        );
        PERFORM public.record_audit_event(p_organization_id, 'settings.updated', 'field',
            p_field_id, jsonb_build_object('operation', 'admin_delete_field', 'phase', 'before'));
        RETURN jsonb_build_object(
            'deleted', false," \
  "scenario table" \
  "smoke 20260907000000"

# **The family census, and the disposition literals.** Sections 4 and 5 of the
# new smoke derive the seven-table `field_id` family from the schema and check
# each arm's disposition word against `pg_constraint`. Both are checks about
# checks, and a check about a check is exactly the kind that quietly stops
# working, so each gets a plant.
plant "M3 an eighth table joins the field_id family unnoticed" "$M3" \
  "ALTER TABLE public.practice_assignments
  DROP CONSTRAINT IF EXISTS practice_assignments_field_id_fkey;" \
  "ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS field_id uuid;
ALTER TABLE public.practice_assignments
  DROP CONSTRAINT IF EXISTS practice_assignments_field_id_fkey;" \
  "smoke 20260907000000" \
  "scenario table"
# **The per-row disposition, flattened back to one word per table.** This is
# the defect a review found in the first version of the RPC: `field_id` is SET
# NULL, so every assignment was reported as surviving -- false for every row the
# scheduler writes, because the slot cascade destroys it first. The decision now
# lives in the producer's `cascades` column, so each plant pins that column to a
# constant. Both halves get one, since a flat answer in either direction passes
# the case for the shape it happens to match.
plant "M3 every game assignment claimed to survive" "$M3" \
  "           EXISTS (SELECT 1 FROM public.game_slots s
                    WHERE s.field_id = p_field_id
                      AND s.id IN (ga.game_slot_id, ga.slot_id))
    FROM public.game_assignments ga" \
  "           false
    FROM public.game_assignments ga" \
  "smoke 20260907000000" \
  "smoke 20260906000000"
plant "M3 every practice assignment claimed to be destroyed" "$M3" \
  "           EXISTS (SELECT 1 FROM public.practice_slots s
                    WHERE s.field_id = p_field_id
                      AND s.id IN (pa.practice_slot_id, pa.slot_id))
    FROM public.practice_assignments pa" \
  "           true
    FROM public.practice_assignments pa" \
  "smoke 20260907000000" \
  "smoke 20260906000000"
# The revert's loss report is code like any other, and the harness plants a
# future-dated retirement so it cannot pass by iterating zero rows. This proves
# THAT check can fail: silence the report and the harness must go red.
plant "R1 revert erases a future retirement silently" "$R1" \
  "    RAISE NOTICE 'LOSING future retirement: field % (%) org % closes % active=%'," \
  "    RAISE NOTICE 'considering a row: % % % % %'," \
  "revert 20260906000000"

# The same, for the revert that re-opens LIVE-1. It counts the
# practice_assignments about to lose the foreign key protecting their field_id,
# and run.sh plants one so the count cannot pass on an empty table.
plant "R3 revert exposes dangling rows silently" "$R3" \
  "        'EXPOSING % practice_assignment(s) with a field_id: after this revert a field delete leaves them dangling'," \
  "        'considering % row(s)'," \
  "revert 20260907000000"

# **A revert that removes the RPC instead of restoring it.** Both of run.sh's
# checks on the restored admin_retire_field used to PASS on this mutation: the
# resolve probe reported nothing whatever happened, and the prosrc probe read a
# zero-row answer as "no longer calls the producer" and printed its green line
# for a database with no retirement RPC at all. This is the positive control
# for the fix -- a check that matches zero records must be a loud failure.
plant "R3 revert drops the retirement RPC instead of restoring it" "$R3" \
  "DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid, boolean);" \
  "DROP FUNCTION IF EXISTS public.admin_retire_field(uuid, uuid, date, boolean);
DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid, boolean);" \
  "revert 20260907000000"

# **Three numbers, not one.** A single "N caught" cannot tell a genuine catch
# from a plant that never applied: last round seven mutations reported RED and
# every one was trivially red against an already-red suite. So the count of
# attempts, the count that failed to anchor (and are therefore MEANINGLESS, not
# passes), and the count genuinely caught are reported separately, and a single
# anchor miss fails the run.
echo
echo "attempted $ATTEMPTED, anchor-miss $MISS (meaningless), caught $PASS, not caught $((FAIL-MISS))"
[ "$FAIL" -eq 0 ] || exit 1
