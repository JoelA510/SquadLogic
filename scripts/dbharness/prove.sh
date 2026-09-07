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
EMERG="$REPO/docs/sql/reverts/20260504060000_admin_facility_mutation_rpcs.sql"
ATTEMPTED=0; PASS=0; FAIL=0; MISS=0

# **Refuse to start on a stale backup.** `plant()` writes `<file>.orig` before
# it mutates and removes it on the way out; a run killed in between leaves one
# behind. Mutating on top of that would restore the WRONG content when this run
# finishes -- the surviving `.orig` is whatever the dead run had saved, not what
# is on disk now -- and a byte-identical copy of a migration sitting in
# `supabase/migrations/` is also something a directory glob may pick up. So:
# find one, stop, and say what to do about it. `.gitignore` covers `*.orig` as
# the second line of defence, not the first.
#
# **Derived from the DISK, not from a list.** This was a hand-written
# `for f in "$M1" "$M2" "$M3" "$R1" "$R3"`, and when `$EMERG` was added as a
# fifth plantable file it went into neither this loop nor `restore_all` -- so an
# interrupted run would have left the emergency rollback mutated on disk and the
# next run would have adopted that mutation as its baseline. That is the exact
# failure both of these exist to prevent, and it happened to this session once
# already: a container restart froze a plant mid-flight and left a security
# mutant in the tree. A second list to keep in step is a list that falls out of
# step, so the sweep now looks wherever it plants.
PLANT_DIRS=("$REPO/supabase/migrations" "$REPO/docs/sql")

# **`2>/dev/null` on the sweep made both callers silent no-ops.** The first
# version of `stale_backups` discarded `find`'s stderr AND its exit status, so a
# `PLANT_DIRS` entry that did not resolve -- a mis-resolved `$REPO`, a directory
# renamed -- produced an empty result that reads exactly like a clean tree. The
# refusal then printed nothing and exited 0, and `restore_all` left whatever was
# planted sitting on disk. That is the silent-no-op class this file has now been
# bitten by three times, in the one function whose whole job is to stop a
# mutation escaping into the working tree -- and an escaped mutation is not
# hypothetical here: a container restart earlier in this series left
# `security_invoker` stripped from the `field_closures` view.
#
# So an entry that is not a directory stops the run before anything is planted,
# and a `find` that fails at all stops it wherever it is noticed. An empty sweep
# is only allowed to mean "nothing is planted" once the places it looked are
# known to exist.
for d in "${PLANT_DIRS[@]}"; do
  if [ ! -d "$d" ]; then
    echo "REFUSING TO START: plant directory $d does not exist" >&2
    echo "  The stale-backup refusal and restore_all sweep only these paths, so a" >&2
    echo "  wrong one makes both silently do nothing. Fix PLANT_DIRS." >&2
    exit 2
  fi
done

#
# **It RETURNS rather than exits, and every caller checks.** The first version
# of this guard printed the refusal and called `exit 3` from inside the
# function -- but the function is used as `done < <(stale_backups)` and
# `$(stale_backups)`, both of which run it in a SUBSHELL, so the exit killed the
# subshell and the script carried straight on. Measured, not reasoned about: a
# `find` shim that exits 1 produced the refusal message AND then
# `=== baseline: ...`, the run continuing exactly as if nothing had happened.
# The identical mistake as the thing being fixed, one layer in -- a loud message
# that changes nothing is still a silent no-op.
stale_backups() {
  local out status
  out="$(find "${PLANT_DIRS[@]}" -name '*.orig' -type f 2>/tmp/harness_find_err)"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "find over the plant directories failed (exit $status)" >&2
    sed 's/^/  /' /tmp/harness_find_err >&2
    return 3
  fi
  printf '%s\n' "$out"
  return 0
}

if ! STALE_AT_START="$(stale_backups)"; then
  echo "REFUSING TO START: the plant directories could not be swept" >&2
  echo "  A planted file may be on disk with its .orig beside it. Compare against" >&2
  echo "  git before re-running." >&2
  exit 3
fi
while IFS= read -r stale; do
  [ -n "$stale" ] || continue
  echo "REFUSING TO START: stale backup $stale" >&2
  echo "  A previous run died between backing up and restoring. Compare it with" >&2
  echo "  the live file, keep whichever is correct, and delete the .orig." >&2
  exit 2
done <<< "$STALE_AT_START"

# Restore anything still planted if this run is interrupted, so the next one is
# not blocked by a backup THIS run abandoned. Same derivation, for the same
# reason: a file this run planted is a file this run must put back, whether or
# not anyone remembered to add it to a list.
#
# **`mv`'s status was thrown away and the announcement made anyway.** This
# printed "restored X from its backup" whether or not the move happened, which
# is the loud-message-that-changes-nothing shape three times over in this file.
# `plant()` verifies ITS restore byte for byte and refuses to continue on a
# mismatch; this, the higher-consequence twin -- it runs when the script is
# already going down and nobody is left to notice -- verified nothing. Two
# mutations have escaped onto disk in this series, both on interrupt paths.
#
# Every move is now checked, and the directories are swept a SECOND time
# afterwards: a restore that reported success and left the `.orig` behind is the
# same silence, one layer in. A failure sets a flag the callers act on.
RESTORE_ALL_FAILED=0
restore_all() {
  local orig list failed=0
  # A sweep that FAILED is not a sweep that found nothing: saying so is the
  # whole point, because this runs when the script is already going down and
  # there is nobody left to notice a mutation it quietly declined to restore.
  if ! list="$(stale_backups)"; then
    echo "restore_all: could not sweep the plant directories -- a planted file may" >&2
    echo "  STILL BE ON DISK. Check 'git status' before trusting this tree." >&2
    RESTORE_ALL_FAILED=1
    return 3
  fi
  while IFS= read -r orig; do
    [ -n "$orig" ] || continue
    if mv -f "$orig" "${orig%.orig}"; then
      echo "restored $(basename "${orig%.orig}") from its backup" >&2
    else
      echo "restore_all: FAILED to restore ${orig%.orig} from its backup -- the" >&2
      echo "  PLANTED MUTATION IS STILL ON DISK. Resolve it against 'git show HEAD'," >&2
      echo "  never against the .orig, and do not commit until you have." >&2
      failed=1
    fi
  done <<< "$list"
  if list="$(stale_backups)"; then
    while IFS= read -r orig; do
      [ -n "$orig" ] || continue
      echo "restore_all: $orig SURVIVED the restore sweep" >&2
      failed=1
    done <<< "$list"
  else
    echo "restore_all: could not re-sweep to confirm the restores" >&2
    failed=1
  fi
  if [ "$failed" -ne 0 ]; then RESTORE_ALL_FAILED=1; return 4; fi
  return 0
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
  restore_all || exit 6
  exit 130
}
# **A trap that returns cannot change the exit status.** `trap restore_all EXIT`
# discarded restore_all's status -- bash ignores what an EXIT handler returns --
# and `on_signal` exited 130 regardless, so both callers could announce that a
# planted file may still be on disk and then exit 0. The status of the run has
# to carry that: `exit` inside an EXIT handler sets the final status and the
# handler is not re-entered, so the original status is preserved on success and
# replaced by 6 when a mutation may have survived.
on_exit() {
  local status=$?
  restore_all || status=6
  exit "$status"
}
trap on_exit EXIT
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
  # **Every planted file must live under a PLANT_DIRS entry.** Those directories
  # are the only thing the stale-backup refusal and `restore_all` look at, and
  # PLANT_DIRS is still hand-maintained one level up from the list it replaced --
  # so this is what stops it drifting, derived from what is ACTUALLY planted
  # rather than from a second list. `$EMERG` fell into exactly this gap: it was
  # planted for a whole round while appearing in neither sweep, so an
  # interrupted run would have left the emergency rollback mutated and the next
  # run would have adopted that mutation as its baseline.
  local covered=0 pd
  for pd in "${PLANT_DIRS[@]}"; do
    case "$file" in "$pd"/*) covered=1; break;; esac
  done
  if [ "$covered" -ne 1 ]; then
    echo "REFUSING TO PLANT \"$label\": $file is under no PLANT_DIRS entry" >&2
    echo "  restore_all and the stale-backup refusal would never see its .orig," >&2
    echo "  so an interrupted run would leave the mutation on disk. Add its" >&2
    echo "  directory to PLANT_DIRS." >&2
    exit 5
  fi
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
  # **A stage name is a PREFIX of every check under it.** The emergency
  # rollback stage prints four different `FAIL emergency rollback 20260504060000`
  # lines -- the precondition, the script itself, and its two claims -- so a
  # substring naming the stage is satisfied by whichever fired, which is the
  # borrowed-evidence mode one level down. Most checks can be named by their own
  # words; one cannot, because the line it prints IS the bare stage line. An
  # `expect` beginning with `^` is matched against the WHOLE line, which is the
  # only way to say "this check and not the three that share its prefix".
  local expect_line="${expect#^}" expect_hit=1
  if [ -n "$expect" ]; then
    case "$expect" in
      '^'*) grep -qxF "FAIL $expect_line" <<<"$out" || expect_hit=0 ;;
      *)    grep -qF  "FAIL $expect_line" <<<"$out" || expect_hit=0 ;;
    esac
  fi
  if [ "$status" -ne 0 ]; then
    if [ "$expect_hit" -ne 1 ]; then
      # The harness went red, but not where this plant was aimed. Some other
      # check caught it -- which is exactly the borrowed-evidence mode above --
      # so it is NOT a catch for the named check and the difference is printed.
      printf '%-52s MISATTRIBUTED  <-- red, but not at "%s"\n' "$label" "$expect_line"
      FAIL=$((FAIL+1))
      # `  |` lines included: half the harness's health claims print there and
      # nowhere else, so a filter without them cannot show the line the verdict
      # under it turned on. The NOT CAUGHT branch below had this and its two
      # siblings did not -- the one-arm-corrected twin, again.
      grep -E '^(applied|PASS|FAIL|BASELINE|HARNESS|  \|)' <<<"$out" | sed 's/^/    /'
      return
    fi
    # **A plant aimed at one check, that another check was supposed NOT to
    # see.** Naming the failing check stops evidence being borrowed from a
    # check that ran earlier, but it does not show the other check stayed
    # green -- and for a plant whose whole purpose is "nothing else in the
    # harness can see this", that is the claim. `green` asserts it, so an
    # isolation that used to be argued in a comment is now measured on every
    # run and cannot quietly stop being true.
    #
    # **A health CLAIM is a green line too.** `green` could only ever name a
    # STAGE, because it matched `PASS <green>` -- and half of what this harness
    # asserts is not a stage. Seven checks print `  | (checked) ...` beneath a
    # stage that says PASS whether or not the claim under it held, so an
    # isolation FROM one of those could not be written down at all. The plant
    # that most needed it -- the probe isolation, whose whole point is that the
    # verdict beside it must NOT see the mutation -- was left passing no green
    # argument while its comment claimed the isolation had been measured, and
    # `expect` is a substring match that scores CAUGHT either way. A `green`
    # beginning with `(checked)` is matched against the claim line instead,
    # which makes all seven claims usable as a neighbour that must stay quiet.
    #
    # **And a stage's `PASS` is not the stage's verdict.** `run.sh` prints
    # `PASS scenario table` at line 165 and only THEN checks that the table
    # reported how many scenarios it executed, printing `FAIL scenario table
    # ran without reporting ...` underneath its own PASS. Three stages are
    # built this way -- the scenario table, each revert, and the emergency
    # rollback -- so `grep "PASS <stage>"` asserts that the stage's first
    # command exited 0, not that the stage concluded green. Six plants carry
    # `green "scenario table"` and would have reported "stayed green" for a
    # stage that went red one line later: the same defect as the one this
    # commit's parent fixed, in the older half of this same function. A stage
    # green now requires its PASS AND the absence of any FAIL naming it.
    local green_ok=1
    if [ -n "$green" ]; then
      case "$green" in
        '(checked)'*)
          grep -qF "| $green" <<<"$out" || green_ok=0
          ;;
        *)
          grep -qF "PASS $green" <<<"$out" || green_ok=0
          ! grep -qF "FAIL $green" <<<"$out" || green_ok=0
          ;;
      esac
    fi
    if [ "$green_ok" -ne 1 ]; then
      printf '%-52s BORROWED  <-- "%s" did not stay green\n' "$label" "$green"
      FAIL=$((FAIL+1))
      grep -E '^(applied|PASS|FAIL|BASELINE|HARNESS|  \|)' <<<"$out" | sed 's/^/    /'
      return
    fi
    printf '%-52s CAUGHT%s%s\n' "$label" "${expect:+ (at $expect_line)}" \
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
# **The internal helpers, actually internal.** 20260614000000 grants EXECUTE on
# every new public function to `authenticated` by default privilege, and a
# revoke from PUBLIC does not remove it -- so the producer's COMMENT claimed "no
# EXECUTE grant" while the catalogue said otherwise. RLS contained it (the
# producer is SECURITY INVOKER over five tables that all have org-scoped
# policies), but a claim nothing enforces is the shape this phase keeps finding.
# Drop the explicit revoke and section 5c must go red; the scenario table stays
# green, because both callers are SECURITY DEFINER and behaviour is unchanged --
# which is exactly why nothing noticed for two rounds.
plant "M3 the producer is left callable by authenticated" "$M3" \
  "REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM authenticated;" \
  "-- the default privilege from 20260614000000 is left in place" \
  "smoke 20260907000000" \
  "scenario table"
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
# **The boundary, and the one plant the smokes cannot catch.** A daterange
# canonicalises to `[)`, so `upper()` is the day AFTER the last one covered;
# comparing it to `p_after` reported a practice ending exactly ON the retirement
# date as stranded, while a game slot the same day was not. The mock had the
# identical off-by-one, so the two runners AGREED and the table saw one answer
# twice -- which is why this plant names the scenario table and requires the
# smoke to stay green. Agreement is not correctness; only a fixture that states
# the boundary as data can adjudicate it.
plant "ONLY-SCEN the practice range boundary is read exclusively again" "$M3" \
  "                 ELSE upper(pa.effective_date_range) - 1" \
  "                 ELSE upper(pa.effective_date_range)" \
  "scenario table" \
  "smoke 20260907000000"
# The revert's loss report is code like any other, and the harness plants a
# future-dated retirement so it cannot pass by iterating zero rows. This proves
# THAT check can fail: silence the report and the harness must go red.
# `expect` names the CHECK, not the stage, for the same reason as its R3
# siblings below: `FAIL revert 20260906000000` is also what a revert that failed
# to APPLY prints, and then the loss report never ran at all -- so the bare
# stage name would score this a catch for a run in which the thing it exists to
# exercise was never reached.
plant "R1 revert erases a future retirement silently" "$R1" \
  "    RAISE NOTICE 'LOSING future retirement: field % (%) org % closes % active=%'," \
  "    RAISE NOTICE 'considering a row: % % % % %'," \
  "revert 20260906000000: planted a future-dated retirement and the revert did not name it"

# The same, for the revert that re-opens LIVE-1. It counts the
# practice_assignments about to lose the foreign key protecting their field_id,
# and run.sh plants one so the count cannot pass on an empty table.
plant "R3 revert exposes dangling rows silently" "$R3" \
  "        'EXPOSING % practice_assignment(s) with a field_id: after this revert a field delete leaves them dangling'," \
  "        'considering % row(s)'," \
  "revert 20260907000000: planted a practice_assignment with a field_id and the revert did not count it"

# **A revert that removes the RPC instead of restoring it.** Both of run.sh's
# checks on the restored admin_retire_field used to PASS on this mutation: the
# resolve probe reported nothing whatever happened, and the prosrc probe read a
# zero-row answer as "no longer calls the producer" and printed its green line
# for a database with no retirement RPC at all. This is the positive control
# for the fix -- a check that matches zero records must be a loud failure.
#
# **`expect` names the BRANCH, not the stage.** Three checks in this stage print
# `FAIL revert 20260907000000...` and this mutation makes two of them fire (the
# probe cannot resolve a function that is gone either), so the bare stage name
# scored a catch without ever showing WHICH answer the verdict gave. Measured:
# it reads GONE.
plant "R3 revert drops the retirement RPC instead of restoring it" "$R3" \
  "DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid, boolean);" \
  "DROP FUNCTION IF EXISTS public.admin_retire_field(uuid, uuid, date, boolean);
DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid, boolean);" \
  "revert 20260907000000: admin_retire_field after the revert reads GONE"

# **One plant per health claim the harness prints.** The three `(checked)` lines
# above had two plants between them, and the gap is how a probe that reported
# health without exercising anything survived two rounds: the members of that
# class share no syntax, so no grep finds them, but the class is enumerable --
# every line that prints `(checked)` is a claim, and a claim with no plant is a
# claim nobody has tried to make fail. These two close the remaining gap.
#
# **Five checks in this one stage print `FAIL revert 20260907000000...`**, so a
# bare stage name as `expect` cannot say which of them a plant reached. Each is
# named by its own line now, measured from a run rather than copied by eye.
plant "R3 revert reinstates the weaker guard silently" "$R3" \
  "  RAISE WARNING 'RESTORING admin_retire_field to its pre-20260907000000 body:" \
  "  RAISE NOTICE 'restoring a function, no consequences worth naming:" \
  "revert 20260907000000: restored the old admin_retire_field without naming what that costs"
# **A restored body that calls something ELSE this revert drops.** A botched
# revert that reinstated the new audit line -- `field_bookings_digest`, dropped
# three statements later -- leaves a retirement raising 42883 on the next call,
# and only a probe that RUNS the function can see it.
#
# It did not isolate the probe when it was written, and the report claiming it
# did was wrong: `LIKE '%field_bookings%'` matched `field_bookings_digest`, so
# the verdict fired too and this plant was scored on borrowed evidence -- the
# defect fixed in PR 2 round 5, recurring in the check built to prevent it.
# Measured, not argued: with the plant applied, the harness printed BOTH
# `FAIL ... reads STILL-CALLS-PRODUCER` and `FAIL ... does not resolve`. The
# verdict now strips the digest name before looking for the producer, and the
# probe's failure line carries `probe` so `expect` can name it alone.
#
# **And the isolation is now ASSERTED rather than hand-measured.** That
# re-measurement was a number in a report: nothing in the sweep would have
# noticed it stopping being true, because `expect` is a substring match and this
# plant passed no `green`, so it scored CAUGHT whether or not the verdict fired
# beside it. Reproduced before it was fixed -- a variant of this mutation that
# calls the PRODUCER rather than the digest makes both checks red, and the plant
# as it stood still printed CAUGHT.
#
# **What this `green` does and does not defend**, stated exactly, because the
# first version of this sentence claimed both directions and delivers one. It
# catches the strip being REMOVED or NARROWED: the verdict starts seeing the
# digest again, the claim never prints, and this reports BORROWED -- the pass-3
# defect, watched by the run instead of by a report. It does NOT catch the strip
# WIDENING: a strip that also removed `field_bookings_digest` would still leave
# the claim green here and this plant scoring a catch. That direction belongs to
# the plant below, and is measured there.
plant "R3 the restored retire calls a helper the revert also drops" "$R3" \
  "            'affected_count', v_affected_count,
            'affected', v_affected
        );
    END IF;" \
  "            'affected_count', v_affected_count,
            'affected', public.field_bookings_digest(v_affected)
        );
    END IF;" \
  "revert 20260907000000 probe" \
  "(checked) exactly one public.admin_retire_field survives the revert, and it no longer calls the dropped producer"

# **The census counted claims, and a claim is not always one assertion.** All
# seven `(checked)` lines had a plant and one of them was still half unprovable,
# because the verdict under it decides between three failing branches and only
# one of them was ever reached. The rule the next census wants: enumerate the
# ways a claim can go RED, not the lines it prints when it does not.
#
# **So: the other half of that verdict's claim, which nothing had ever tried to
# fail.** The verdict decides between three red answers and only one of them was
# reachable by a plant: `GONE`, above. This is the second; the third is below.
# `STILL-CALLS-PRODUCER` is the half the claim says out loud -- "it no longer
# calls the dropped producer" -- and no plant reached it, because the digest
# plant above is the only one that puts a `field_bookings` name back into the
# restored body and the verdict strips that name before it looks. So a strip
# widened to remove the PRODUCER's name too would let a revert that never
# restored the enumerator read RESTORED with this sweep still printing every
# plant caught. Measured, as the control for this plant: with the strip widened
# to `field_bookings[a-z_]*`, the harness exits 0 and this plant prints
# NOT CAUGHT.
#
# There is a fourth answer, `QUERY-FAILED`, and it deliberately has no plant:
# it comes from `psql_cmd` itself failing, which no mutation of a file this
# sweep plants can cause. Saying so is the point -- an unplanted branch that is
# unplantable has to be declared, not left looking like the three that were
# simply never tried.
#
# Reproduced before it was written, by running the harness under each of the
# four plants that mutate $R3 and reading the branch it printed: GONE once and
# the green claim three times, never STILL-CALLS-PRODUCER. No plant on any other
# file can reach it either -- the restored body is whatever $R3's CREATE OR
# REPLACE says, so $R3's text is the verdict's only input.
#
# The mutation is the shape a half-finished revert actually takes: the refusal
# path restored, the CONFIRMED path left on the new producer. The probe drives a
# REFUSAL, so it never executes that statement and stays green -- which is what
# makes this the verdict's own catch rather than one borrowed from the probe
# beside it, and why it names the probe's claim as the line that must stay
# green. Measured: verdict red at STILL-CALLS-PRODUCER, probe claim printed.
plant "R3 the restored retire still calls the dropped producer" "$R3" \
  "        'affected', v_affected,
        'field', to_jsonb(v_after)" \
  "        'affected', (SELECT jsonb_agg(to_jsonb(b))
                     FROM public.field_bookings(p_organization_id, p_field_id, p_effective_to) b),
        'field', to_jsonb(v_after)" \
  "revert 20260907000000: admin_retire_field after the revert reads STILL-CALLS-PRODUCER" \
  "(checked) the restored admin_retire_field resolves and runs both its refusal and its confirmed path"

# **The half of the probe's claim that no plant could reach, and the probe that
# now reaches it.** The probe drove only the REFUSAL path, and the verdict
# strips `field_bookings_digest` by design -- so a revert that restored the
# refusal branch and left the CONFIRMED branch on the digest (before-audit,
# UPDATE, after-audit, success RETURN) passed both checks with the harness
# fully green, while raising 42883 on the first confirmed retirement anyone
# ran. A broken revert scoring clean is the failure this whole stage exists to
# make impossible, so it is closed by making the claim true rather than by
# declaring it out of reach: the probe now runs a confirmed retirement too, and
# this plant is what proves that half can fail. Measured both ways -- against
# the refusal-only probe it scores NOT CAUGHT with the harness green, which is
# the reproduction; against the two-half probe it is red at the probe with the
# verdict's claim still printed.
plant "R3 the restored retire's CONFIRMED path calls a dropped helper" "$R3" \
  "            'affected_count', v_affected_count,
            'after', to_jsonb(v_after)" \
  "            'affected_count', v_affected_count,
            'affected', public.field_bookings_digest(v_affected),
            'after', to_jsonb(v_after)" \
  "revert 20260907000000 probe" \
  "(checked) exactly one public.admin_retire_field survives the revert, and it no longer calls the dropped producer"

# **And the third branch, for the same reason.** `AMBIGUOUS` is the other half
# of "exactly one survives", and it was as unreached as STILL-CALLS-PRODUCER
# was: `GONE` is what a revert that removes too much prints, and nothing tried a
# revert that removes too LITTLE. This restores the function under a CHANGED
# signature, so 20260907000000's own version is left standing beside the
# restored one -- the unguarded-overload shape this migration exists to close,
# in the revert rather than the migration.
#
# No `green` here, and the omission is the honest one: the surviving overload IS
# the pre-revert body, which cannot resolve once the producer is dropped, so the
# probe is RIGHT to fail beside it. `expect` names the branch, which only the
# verdict prints, so the attribution is exact even though the isolation is not
# available to be claimed.
plant "R3 revert restores retire under a second signature" "$R3" \
  "    p_confirm boolean DEFAULT false
)
RETURNS jsonb" \
  "    p_confirm text DEFAULT 'false'
)
RETURNS jsonb" \
  "revert 20260907000000: admin_retire_field after the revert reads AMBIGUOUS"

# **The emergency rollback, back in the state 20260907000000 left it in.** It
# dropped a signature that no longer exists, so the DROP was a silent no-op and
# the script committed and reported success with the guarded delete still
# standing -- the file someone runs at 2am, lying to them. Nothing executed it
# until this round, which is why two review passes went by without noticing.
#
# **Both expects name their own check now, and one of them can only be named by
# its whole line.** This stage prints four `FAIL emergency rollback
# 20260504060000` lines and both plants carried the bare prefix, so a second
# `admin_delete_field` overload -- which fires the precondition at run.sh:406 --
# would have scored BOTH of them CAUGHT with neither named check running. That
# is the stage-not-check defect fixed for the reverts in this PR's parent,
# unapplied one stage along: the twin, again, in the round that was about twins.
#
# Measured rather than written by eye, and the measurement corrected a guess:
# removing the three-argument DROP does not leave a survivor for the check at
# run.sh:419 to find, because the rollback script's own by-name guard raises
# first and the stage prints nothing but its bare line. Hence `^`.
plant "EMERG rollback drops a signature that no longer exists" "$EMERG" \
  "DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid, boolean);" \
  "DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid);" \
  "^emergency rollback 20260504060000"
# The other direction: a rollback that over-reaches and takes the producer
# `admin_retire_field` still needs, breaking a function it does not own.
# This one the stage can name in its own words, and its transcript showed an
# isolation available for nothing: the rollback still removes all four RPCs, so
# the claim above it stays green while only the producer check goes red.
plant "EMERG rollback takes the producer another RPC still calls" "$EMERG" \
  "DROP FUNCTION IF EXISTS public.admin_create_location(uuid, text, text, boolean);" \
  "DROP FUNCTION IF EXISTS public.admin_create_location(uuid, text, text, boolean);
DROP FUNCTION IF EXISTS public.field_bookings(uuid, uuid, date) CASCADE;" \
  "emergency rollback 20260504060000: it dropped public.field_bookings, breaking admin_retire_field" \
  "(checked) the rollback removed every overload of all four admin facility RPCs"

# **Three numbers, not one.** A single "N caught" cannot tell a genuine catch
# from a plant that never applied: last round seven mutations reported RED and
# every one was trivially red against an already-red suite. So the count of
# attempts, the count that failed to anchor (and are therefore MEANINGLESS, not
# passes), and the count genuinely caught are reported separately, and a single
# anchor miss fails the run.
echo
echo "attempted $ATTEMPTED, anchor-miss $MISS (meaningless), caught $PASS, not caught $((FAIL-MISS))"
[ "$FAIL" -eq 0 ] || exit 1
