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
M4="$REPO/supabase/migrations/20260908000000_field_availability_profile_field_resolution.sql"
R4="$REPO/docs/sql/20260908000000_revert.sql"
M5="$REPO/supabase/migrations/20260909000000_rollback_field_import_booking_guard.sql"
R5="$REPO/docs/sql/20260909000000_revert.sql"
S5="$REPO/docs/sql/20260909000000_smoke.sql"
ATTEMPTED=0; PASS=0; FAIL=0; MISS=0
# What each plant scored, by label, for the census at the bottom of this file.
# The census asserts that every health claim run.sh prints has a plant that
# reached one of its RED branches, and it reads THIS run's results rather than a
# sentence in a comment -- so a prover that stopped catching its defect fails
# the census as loudly as a claim with no prover at all.
declare -A RESULT=()

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
# same silence, one layer in.
#
# **The failure is a RETURN STATUS, and that is all it is.** This also set a
# `RESTORE_ALL_FAILED` flag, in two places, and the comment above said the
# callers acted on it -- they act on the status, and nothing anywhere read the
# flag. A field that reads as load-bearing and is not is how the board waiver
# was lost; in a restore path whose whole subject is a mutation possibly left on
# disk, a second signal nobody reads is worse than none, because it is the one a
# reader trusts. Both callers turn a non-zero return into exit 6.
restore_all() {
  local orig list failed=0
  # A sweep that FAILED is not a sweep that found nothing: saying so is the
  # whole point, because this runs when the script is already going down and
  # there is nobody left to notice a mutation it quietly declined to restore.
  if ! list="$(stale_backups)"; then
    echo "restore_all: could not sweep the plant directories -- a planted file may" >&2
    echo "  STILL BE ON DISK. Check 'git status' before trusting this tree." >&2
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
  if [ "$failed" -ne 0 ]; then return 4; fi
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

# **A PLANT AIMED AT A SUPERSEDED FUNCTION BODY IS A CHECK OF NOTHING.**
#
# Migrations apply in filename order and `CREATE OR REPLACE FUNCTION` is
# last-one-wins, so when a later migration recreates a function the earlier
# file's copy of that body never reaches the database. A mutation planted into
# it applies cleanly, changes the file, and is overwritten before anything
# runs. The plant then scores NOT CAUGHT -- the correct verdict, and one that
# costs a whole sweep to reach. This happened: 20260909000000 recreated
# `field_bookings` and `admin_delete_field`, and eight plants aimed at
# 20260907000000's copies became inert in one commit.
#
# So it is derived and refused here, before the baseline. The superseded set
# comes from the MIGRATION DIRECTORY, not from a list in this file -- a list
# would go stale on exactly the change it exists to catch -- and a plant is
# refused only when its anchor falls INSIDE a superseded body, so a plant
# against a DDL statement or a comment in the same file is untouched.
#
# The meta-assertion is on the other side: if this finds no plants at all it
# says so and stops, because a parse that matched nothing would clear every
# plant in the file by looking at none of them.
echo "=== pre-flight: no plant may target a superseded function body ==="
python3 - "$REPO" <<'PREFLIGHT'
import io, os, re, sys

repo = sys.argv[1]
mig_dir = os.path.join(repo, 'supabase', 'migrations')
sh = io.open(os.path.join(repo, 'scripts', 'dbharness', 'prove.sh'), encoding='utf8').read()

# `M1="$REPO/..."` -> absolute path, so a plant's file is resolvable from its
# shell variable without re-implementing the assignments.
files = {}
for name, path in re.findall(r'^(\w+)="(\$REPO/[^"]+)"', sh, re.M):
    files[name] = path.replace('$REPO', repo)

# Which migration defines each function LAST.
last_def = {}
for name in sorted(os.listdir(mig_dir)):
    if not name.endswith('.sql'):
        continue
    src = io.open(os.path.join(mig_dir, name), encoding='utf8').read()
    for fn in re.findall(r'CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(', src):
        last_def[fn] = name
if not last_def:
    print('PRE-FLIGHT FAILED: no CREATE OR REPLACE FUNCTION found in', mig_dir)
    sys.exit(2)

# Every plant: label, file variable, and the `old` anchor.
plants = re.findall(
    r'^plant "([^"]+)" "\$(\w+)" \\\n\s*"((?:[^"\\]|\\.)*)"', sh, re.M | re.S)
if not plants:
    print('PRE-FLIGHT FAILED: parsed no plants out of prove.sh; this check looked at nothing')
    sys.exit(2)

bad = []
examined = 0
for label, var, old in plants:
    path = files.get(var)
    if path is None or not path.startswith(mig_dir):
        continue  # reverts and the emergency rollback are not migrations
    base = os.path.basename(path)
    src = io.open(path, encoding='utf8').read()
    pos = src.find(old)
    if pos < 0:
        continue  # a moved anchor is ANCHOR-MISS's business, not this check's
    examined += 1
    for fn in re.findall(r'CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(', src):
        start = src.index('CREATE OR REPLACE FUNCTION public.%s(' % fn)
        end = src.find('\n$$;\n', start)
        if end < 0:
            continue
        if start <= pos < end + 5 and last_def.get(fn) != base:
            bad.append((label, base, fn, last_def[fn]))
            break

if examined == 0:
    print('PRE-FLIGHT FAILED: no plant anchor resolved inside a migration; the walk found nothing to judge')
    sys.exit(2)

for label, base, fn, winner in bad:
    print('PRE-FLIGHT REFUSAL: plant "%s"' % label)
    print('  mutates public.%s in %s, but %s recreates it.' % (fn, base, winner))
    print('  The installed body is the later one, so this mutation never reaches the database.')
    print('  Re-aim the plant at %s, or at a part of %s the later migration does not replace.'
          % (winner, base))
if bad:
    sys.exit(1)
print('pre-flight: %d migration-targeted plant anchors examined, none inside a superseded body'
      % examined)
PREFLIGHT
preflight_status=$?
if [ "$preflight_status" -ne 0 ]; then
  echo "REFUSING TO PLANT -- see the pre-flight refusals above." >&2
  exit 7
fi
echo

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
  # **The label is the census's key, so two plants may not share one.** A
  # duplicate would overwrite the first one's result and the census would then
  # read a verdict belonging to a different mutation -- a check answering about
  # data other than the data it names, which is the shape this file exists to
  # find. Cheap to make impossible, so it is.
  if [ -n "${RESULT[$label]+x}" ]; then
    echo "REFUSING TO PLANT: two plants share the label \"$label\"" >&2
    echo "  The census keys on the label; a duplicate makes it report on the" >&2
    echo "  wrong mutation. Rename one." >&2
    exit 5
  fi
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
  # **An empty checksum compares equal to an empty checksum.** `sha256sum`'s
  # status is eaten by the pipe and was never read, so a file this could not
  # read produced "" here and "" again at the verification below -- the restore
  # check passing exactly when it had nothing to check, in the guard that exists
  # to stop a planted mutation escaping onto disk. Same swallowed-status shape
  # as the two seeds in run.sh, found by the sweep those prompted.
  if [ -z "$before_sum" ]; then
    echo "REFUSING TO PLANT \"$label\": could not checksum $file before planting" >&2
    echo "  Without a baseline the restore verification below cannot fail." >&2
    exit 4
  fi
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
    RESULT["$label"]=ANCHOR-MISS
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
  #
  # **The transcript is not only the harness's own words, and a plant writes
  # into it.** Every stage `tail`s the failing psql log and pipes NOTICE and
  # WARNING lines through a `  | ` prefix -- and rewriting a NOTICE is what half
  # the plants in this file DO. Both matches below searched the whole transcript
  # for a substring, so a mutation that raised `FAIL smoke 20260906000100`
  # forged the catch, and one that raised `| (checked) <claim>` forged the very
  # claim that exists to prove the claim was checked. The mechanism this PR
  # added to make isolation expressible was satisfiable by output the plant
  # itself controls, which is the borrowed-evidence mode with the plant as the
  # lender.
  #
  # Both now match only the shape `run.sh`'s own `echo`s produce: a verdict line
  # starts with `PASS `/`FAIL ` in column 0, and a claim line IS
  # `  | (checked) ...` entire. Constructed both ways before being believed; the
  # controls are in the commit messages.
  #
  # **The comment here used to declare a residual UNCLOSABLE, and it was wrong
  # in both halves.** It read: a multi-line RAISE whose continuation line
  # reproduces a checker line byte for byte arrives in a `tail` dump unlabelled
  # and would still match, and closing that "needs run.sh to report its verdicts
  # on a channel psql cannot write to". The first half was true and worse than
  # stated -- it was a live forge, measured: a mutation raising
  # `E'...\nFAIL scenario table\n  | (checked) ...'` scored `CAUGHT (at
  # substring "FAIL scenario table")` with the scenario table PASSING, and its
  # twin scored a claim "stayed green" the run never printed.
  #
  # The second half was false, and the disproof was one function away in the
  # file it was written about: `run.sh`'s NOTICE passthrough has always indented
  # what psql says, and its eleven `tail` dumps had not. They do now, through
  # one `dump` helper, and no plant-authored byte can reach column 0 or shrink
  # `      | ` back to `  | `. Both forgeries above are rejected -- MISATTRIBUTED
  # and BORROWED -- against the same mutation that produced them.
  #
  # An impossibility asserted in a comment that a neighbouring function
  # disproves is worse than no comment: it stops the next reader looking.
  local verdict_lines
  verdict_lines="$(grep -E '^(PASS|FAIL) ' <<<"$out")"
  #
  # **And the transcript has to say WHICH form matched.** Both branches printed
  # `$expect_line`, the expect with its `^` stripped, so a whole-line match and
  # a substring match were indistinguishable in the evidence -- and the
  # difference between them is the entire content of the third finding this PR
  # closed: `^emergency rollback 20260504060000` asserts that the stage printed
  # nothing but its bare line, while the same words unanchored are satisfied by
  # any of the four checks under it. A reader could not tell which claim a
  # CAUGHT line was making.
  local expect_line="${expect#^}" expect_hit=1 expect_desc=""
  if [ -n "$expect" ]; then
    case "$expect" in
      '^'*) expect_desc="whole line \"FAIL $expect_line\""
            grep -qxF "FAIL $expect_line" <<<"$verdict_lines" || expect_hit=0 ;;
      *)    expect_desc="substring \"FAIL $expect_line\""
            grep -qF  "FAIL $expect_line" <<<"$verdict_lines" || expect_hit=0 ;;
    esac
  fi
  if [ "$status" -ne 0 ]; then
    if [ "$expect_hit" -ne 1 ]; then
      # The harness went red, but not where this plant was aimed. Some other
      # check caught it -- which is exactly the borrowed-evidence mode above --
      # so it is NOT a catch for the named check and the difference is printed.
      printf '%-52s MISATTRIBUTED  <-- red, but not at %s\n' "$label" "$expect_desc"
      RESULT["$label"]=MISATTRIBUTED
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
    # `PASS scenario table` as soon as the generated script exits 0, and only
    # THEN checks that the table reported how many scenarios it executed,
    # printing `FAIL scenario table ran without reporting ...` underneath its
    # own PASS. (It said "at line 165" until round 3, which was the `done` of
    # the smoke loop by then -- the third stale line citation in this file, and
    # the twin the round-2 sweep of the other two missed. Nothing here cites a
    # line number any more; a check's own words do not move.) Three stages are
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
          grep -qxF "  | $green" <<<"$out" || green_ok=0
          ;;
        *)
          grep -qF "PASS $green" <<<"$verdict_lines" || green_ok=0
          ! grep -qF "FAIL $green" <<<"$verdict_lines" || green_ok=0
          ;;
      esac
    fi
    if [ "$green_ok" -ne 1 ]; then
      printf '%-52s BORROWED  <-- "%s" did not stay green\n' "$label" "$green"
      RESULT["$label"]=BORROWED
      FAIL=$((FAIL+1))
      grep -E '^(applied|PASS|FAIL|BASELINE|HARNESS|  \|)' <<<"$out" | sed 's/^/    /'
      return
    fi
    printf '%-52s CAUGHT%s%s\n' "$label" "${expect:+ (at $expect_desc)}" \
      "${green:+, $green stayed green}"; RESULT["$label"]=CAUGHT; PASS=$((PASS+1))
  else
    # **Print the transcript on a miss.** `out` was captured and never read --
    # a field parsed and left unread, in the tool whose whole output is the
    # evidence. A NOT CAUGHT line on its own says a defect went undetected and
    # nothing about what the harness actually did, so the next step was always
    # to re-run by hand. The failing case is the one worth keeping the
    # transcript of; a catch needs no explanation.
    printf '%-52s NOT CAUGHT  <-- the check is hollow\n' "$label"
    RESULT["$label"]="NOT CAUGHT"; FAIL=$((FAIL+1))
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
# **EIGHT PLANTS BELOW MOVED FROM $M3 TO $M5, AND THE MOVE IS THE POINT.**
#
# 20260909000000 recreates `public.field_bookings` and
# `public.admin_delete_field`. Migrations apply in filename order, so the body
# that ENDS UP INSTALLED is 20260909000000's -- and a mutation planted into
# 20260907000000's copy is overwritten moments later by the unmutated one. The
# plant applies, the anchor matches, the file really changes, and the database
# never sees it. Every such plant silently became a check of nothing.
#
# It cost a three-hour sweep to discover, because a plant aimed at a superseded
# body scores NOT CAUGHT -- which is the right verdict and the slowest possible
# way to learn it. The pre-flight refusal near the top of this file now derives
# the superseded bodies from the migration directory and stops the run in
# seconds instead, so the next migration to recreate a function cannot quietly
# hollow out the plants aimed at its predecessor.
#
# Each anchor below was confirmed to appear exactly once in 20260909000000 as
# well, because that migration carries both bodies forward verbatim.
plant "M3 the shared producer loses its games arm" "$M5" \
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
plant "M3 delete reads a NULL confirmation as yes" "$M5" \
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
plant "M3 the refusal embeds the whole list in the audit row" "$M5" \
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
plant "M3 delete loses its booking guard entirely" "$M5" \
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
plant "ONLY-SCEN refusal also audits a phase it never reached" "$M5" \
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
plant "M3 every game assignment claimed to survive" "$M5" \
  "           EXISTS (SELECT 1 FROM public.game_slots s
                    WHERE s.field_id = p_field_id
                      AND s.id IN (ga.game_slot_id, ga.slot_id))
    FROM public.game_assignments ga" \
  "           false
    FROM public.game_assignments ga" \
  "smoke 20260907000000" \
  "smoke 20260906000000"
plant "M3 every practice assignment claimed to be destroyed" "$M5" \
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
plant "ONLY-SCEN the practice range boundary is read exclusively again" "$M5" \
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
# **SIX checks in this one stage print `FAIL revert 20260907000000...`**, so a
# bare stage name as `expect` cannot say which of them a plant reached. Each is
# named by its own line now, counted by command rather than by eye -- and it was
# five until the round-2 fix for the probe's unchecked `cat` added a second
# `FAIL revert <id> probe:` line. That made `probe` ambiguous between the probe
# that RAN and the probe that could not be STAGED, which is the same
# prefix-of-its-neighbour defect one level down, introduced by the commit that
# was fixing a swallowed status. Both plants aimed at the probe carry `^` and
# the whole line now; a substring cannot separate those two.
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
# `^` anchor on this plant's `expect` is what names the probe alone.
#
# **That last clause used to credit the WORD, and my own staging branch made it
# false.** It read "the probe's failure line carries `probe` so `expect` can
# name it alone", which was true when written and stopped being true in the
# round-2 commit that added `FAIL revert <id> probe: the probe script could not
# be staged`. Two lines share the `probe` prefix now, so the word distinguishes
# nothing and a substring naming it is satisfied by a probe that was never
# staged -- measured, not reasoned about: both plants aimed here scored CAUGHT
# with the probe never run. The whole-line `^` form is what makes the attribution
# exact, and the corresponding note in run.sh says the same thing from the other
# side. A sentence crediting the wrong mechanism is the same defect as the wrong
# impossibility this round removed: it tells the next reader to stop looking.
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
  "^revert 20260907000000 probe: the restored admin_retire_field does not resolve" \
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
# plant caught.
#
# **Re-measured, because this PR's own probe fix invalidated the first
# measurement.** That control read "with the strip widened to
# `field_bookings[a-z_]*`, the harness exits 0 and this plant prints NOT
# CAUGHT", and it was true when it was taken. It is not now: the probe drives a
# confirmed retirement, and what a widened strip goes blind to is a LIVE
# producer call in the path the probe executes. Executed again, against a run.sh
# with the strip widened: `FAIL revert 20260907000000 probe: the restored
# admin_retire_field does not resolve`, every other stage green, and this plant
# printing `MISATTRIBUTED  <-- red, but not at substring "FAIL revert
# 20260907000000: admin_retire_field after the revert reads
# STILL-CALLS-PRODUCER"`.
#
# The control still proves what this plant is for, and proves it more exactly:
# the probe says the restored body is BROKEN, and only the verdict says which
# way. What it no longer proves is a hollow harness, because there no longer is
# one. A measurement recorded in a comment is a measurement the code can move
# under -- the second time in this PR that strengthening one check changed a
# neighbour's recorded control, and the reason the census below reads results
# rather than prose.
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
# path restored, the CONFIRMED path left on the new producer.
#
# **It carried a `green` naming the probe's claim, and the sweep took it away.**
# When it was written the probe drove only a refusal, so this statement never
# executed and the probe stayed green -- a genuine isolation, measured. Then the
# finding above extended the probe to drive the confirmed path too, and a LIVE
# producer call there is now something the probe executes and dies on: the sweep
# reported BORROWED, correctly, because the claim it named no longer prints.
# Both halves of that are this PR's own work, which is the interaction worth
# recording -- strengthening one check can invalidate a neighbour's isolation,
# and the mechanism said so on the first run rather than a review round later.
#
# So the isolation is not claimed. The probe is RIGHT to fail beside it: after
# the revert the producer is gone, and a call to it anywhere the function
# executes is a real break. `expect` names the branch, which only the verdict
# prints, so attribution stays exact -- the same honest shape as the AMBIGUOUS
# plant below. The verdict's unique value is unchanged and still proved: it
# reads the SOURCE, so it is what names WHICH way the restored body is wrong.
plant "R3 the restored retire still calls the dropped producer" "$R3" \
  "        'affected', v_affected,
        'field', to_jsonb(v_after)" \
  "        'affected', (SELECT jsonb_agg(to_jsonb(b))
                     FROM public.field_bookings(p_organization_id, p_field_id, p_effective_to) b),
        'field', to_jsonb(v_after)" \
  "revert 20260907000000: admin_retire_field after the revert reads STILL-CALLS-PRODUCER"

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
  "^revert 20260907000000 probe: the restored admin_retire_field does not resolve" \
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
# `admin_delete_field` overload -- which fires the precondition, `expected
# exactly one admin_delete_field before it runs` -- would have scored BOTH of
# them CAUGHT with neither named check running. That
# is the stage-not-check defect fixed for the reverts in this PR's parent,
# unapplied one stage along: the twin, again, in the round that was about twins.
#
# Measured rather than written by eye, and the measurement corrected a guess:
# removing the three-argument DROP does not leave a survivor for the survivor
# check -- `N admin facility RPC(s) survived a rollback that reported success`
# -- to find, because the rollback script's own by-name guard raises first and
# the stage prints nothing but its bare line. Hence `^`.
#
# **Named by their words rather than by `run.sh:406` and `run.sh:419`.** Those
# two references were correct when written and were stale fifteen lines later,
# by exactly the fifteen lines this PR added above them -- both then pointed at
# unrelated code. A line number in a comment is a reference that rots silently;
# the check's own text does not.
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

# **The one claim in this harness that no plant had ever reached.**
#
# `(checked) the rollback removed every overload of all four admin facility
# RPCs` is claim 6 of 7, and its RED branch -- `N admin facility RPC(s) survived
# a rollback that reported success` -- had nothing aimed at it. Not because it
# is unreachable: it is gated behind the rollback script's OWN by-name guard,
# which raises on any mutation that leaves an RPC standing, so the stage fails
# at its bare line and this branch is never evaluated. Every EMERG plant tried
# so far stopped there. So the census this PR wrote -- "all seven claims have a
# plant" -- was false, and the branch was neither planted nor declared
# unplantable, which is the state the QUERY-FAILED declaration exists to keep
# things out of.
#
# Reaching it means defeating that guard in the SAME edit, and the shape that
# does is the realistic one: the script stops dropping an RPC and its own guard
# stops looking for it, so it commits and reports success with an admin RPC
# still callable. That is the whole reason run.sh names the four independently
# of the script rather than trusting the guard -- and this is what proves the
# independent census is not redundant.
#
# `green` names the claim beside it, which is untouched: the producer survives
# either way, so an isolation is genuinely available here and is asserted.
plant "EMERG the rollback and its own guard drift together" "$EMERG" \
  "DROP FUNCTION IF EXISTS public.admin_create_location(uuid, text, text, boolean);

-- Every overload, by NAME rather than by signature: a rollback that reports
-- success must have removed the thing it names, and only a name survives a
-- signature change.
DO \$rollback_check\$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(n.nspname || '.' || p.proname || '(' ||
                      pg_get_function_identity_arguments(p.oid) || ')', ', ' ORDER BY p.proname)
      INTO v_left
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('admin_delete_field', 'admin_update_field',
                         'admin_create_field', 'admin_create_location');" \
  "-- admin_create_location is left standing, and the guard below stops naming it

DO \$rollback_check\$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(n.nspname || '.' || p.proname || '(' ||
                      pg_get_function_identity_arguments(p.oid) || ')', ', ' ORDER BY p.proname)
      INTO v_left
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('admin_delete_field', 'admin_update_field',
                         'admin_create_field');" \
  "emergency rollback 20260504060000: 1 admin facility RPC(s) survived a rollback that reported success" \
  "(checked) it left public.field_bookings standing, which admin_retire_field still calls"

# ---------------------------------------------------------------------------
# LIVE-2: the import's field resolution, and the revert that undoes it
# ---------------------------------------------------------------------------
#
# `docs/sql/20260908000000_smoke.sql` is the first BEHAVIOURAL smoke on this
# function. The one it sits beside -- `docs/sql/20260602000000_smoke.sql`, on
# the very same function -- is three bare SELECTs with no RAISE in them, so it
# exits 0 whatever the body does and has done since the day it was written.
# These plants are what stops the new one going the same way.
#
# Every M4 plant carries `green "smoke 20260907000000"`: LIVE-1's smoke runs in
# the same stage and must NOT see a mutation of the import path, so the
# isolation is measured rather than asserted in a comment.

# **The defect itself, put back.** The guard stops firing, so a row matching no
# field is applied with field_id NULL and its blackout window is hung off it --
# exactly the state the migration exists to make unreachable.
plant "M4 the resolution guard stops firing" "$M4" \
  "      IF v_field_id IS NULL THEN
        v_unresolved_rows := v_unresolved_rows + 1;" \
  "      IF false THEN
        v_unresolved_rows := v_unresolved_rows + 1;" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **The tenant filter.** The mock arm had this filter on the location as well as
# on the field, which made the field-side one unreachable and a control removing
# it changed no test. The SQL puts it on the field only, so this is the plant
# that proves the smoke's cross-org decoy is doing work.
plant "M4 resolution ignores organization_id" "$M4" \
  "WHERE f.organization_id=v_job.organization_id AND lower(l.name)=lower(v_location)" \
  "WHERE lower(l.name)=lower(v_location)" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **A refused row that is marked applied is a DISCARDED row.** Re-running
# finalize would skip it, so the operator's import is gone rather than deferred
# -- the failure mode that would make refusing worse than the defect.
plant "M4 a refused row is marked applied and cannot be replayed" "$M4" \
  "      UPDATE public.staging_import_rows SET validation_errors = v_row_errors WHERE id = v_row.id;" \
  "      UPDATE public.staging_import_rows SET validation_errors = v_row_errors, applied_at = v_now WHERE id = v_row.id;" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **A refusal a caller cannot branch on.** The prose survives -- so section 1's
# `prosrc LIKE '%field_unresolved%'` still passes -- and only the behavioural
# section notices, which is the point of having one.
plant "M4 the refusal carries no branchable reason key" "$M4" \
  "          'reason','field_unresolved','location',v_location,'field_name',v_field_name," \
  "          'note','field_unresolved','location',v_location,'field_name',v_field_name," \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# The corpus this import was built for spells venues as the club's spreadsheet
# spells them, not as the fields table does, so case-insensitive matching is
# the difference between resolving most rows and refusing most rows.
plant "M4 the name match becomes case-sensitive" "$M4" \
  "lower(l.name)=lower(v_location) AND lower(f.name)=lower(v_field_name)" \
  "l.name=v_location AND f.name=v_field_name" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **A replayed row that keeps its refusal** reads as applied AND refused at
# once, so anything asking which rows the import refused names one that
# succeeded.
plant "M4 a replayed row keeps the refusal it no longer deserves" "$M4" \
  "applied_by=auth.uid(), validation_errors='[]'::jsonb WHERE id=v_row.id;" \
  "applied_by=auth.uid() WHERE id=v_row.id;" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **The clause that must stay ABSENT**, planted so the check for its absence is
# itself falsifiable. `finalize_field_import_job` carries it and a refusal there
# is permanent; here it would kill the replay this migration is built on.
plant "M4 adopts the sibling filter and can never replay a refusal" "$M4" \
  "AND applied_at IS NULL AND normalized_payload IS NOT NULL ORDER BY source_row_number" \
  "AND applied_at IS NULL AND normalized_payload IS NOT NULL AND COALESCE(jsonb_array_length(validation_errors), 0) = 0 ORDER BY source_row_number" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **warning_summary assigned rather than merged** destroys the deferred_apply
# key the UI reads to know a job was ever staged. Every sibling finalizer
# merges; this is the control for the one that did not.
plant "M4 the finalize overwrites warning_summary instead of merging" "$M4" \
  "    warning_summary = jsonb_set(
      COALESCE(warning_summary, '{}'::jsonb),
      '{availability_finalize}',
      jsonb_build_object('invalid_rows', v_invalid_rows, 'unresolved_field_rows', v_unresolved_rows),
      true
    )" \
  "    warning_summary = jsonb_build_object('availability_finalize', jsonb_build_object('invalid_rows', v_invalid_rows, 'unresolved_field_rows', v_unresolved_rows))" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# The refusal prose, pinned on both arms after they were found producing
# different sentences. `%L` is the SQL-literal conversion, not a display one.
plant "M4 the refusal prose reverts to SQL-literal quoting" "$M4" \
  'No field named "%s" at location "%s" in this organization' \
  'No field named %L at location %L in this organization' \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **The comment pins, which the migration calls "what stops it drifting back"
# and which had no control at all.** Two objects carry the claim and each gets
# its own plant, because a pin on a pair that only one plant can reach is a pin
# on one of them. Each restores that object's superseded wording -- the exact
# regression the pin exists to catch.
plant "M4 the view comment reverts to the superseded claim" "$M4" \
  "COLLAPSING THE UNION IS STILL BLOCKED, and only half the obstacle is gone:" \
  "The union is temporary: it collapses to field_blackouts alone once finalize_field_availability_import_job resolves a profile to a field reliably. Formerly:" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

plant "M4 the frozen table comment reverts to the superseded claim" "$M4" \
  "COLLAPSING THE UNION IS STILL BLOCKED as of 20260908000000" \
  "The two cannot be collapsed until finalize_field_availability_import_job stops attaching blackouts to profiles whose field_id resolution can be NULL. Formerly blocked as of 20260908000000" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **The obvious wrong fix for this defect**, and the reason section 2 pins the
# nullability: `SET NOT NULL` looks like the tidy repair and breaks the
# ON DELETE SET NULL the fields foreign key relies on.
plant "M4 field_id is made NOT NULL, the tidy wrong fix" "$M4" \
  "COMMIT;" \
  "ALTER TABLE public.field_availability_profiles ALTER COLUMN field_id SET NOT NULL;
COMMIT;" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# Section 1's hardening checks, which also had no plant. SECURITY DEFINER is
# what lets this function write past RLS at all.
plant "M4 the finalize loses SECURITY DEFINER" "$M4" \
  "LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$" \
  "LANGUAGE plpgsql SET search_path = public AS \$\$" \
  "smoke 20260908000000" \
  "smoke 20260907000000"

# **The apply-time report, which had never run.** A migration that says nothing
# about what a production database already holds is the silent half of this
# fix; the plant makes the branch that says it falsifiable.
plant "M4 the apply-time orphan report never fires" "$M4" \
  "  IF v_profiles > 0 THEN
    RAISE WARNING 'PRE-EXISTING:" \
  "  IF false THEN
    RAISE WARNING 'PRE-EXISTING:" \
  "20260908000000: re-applied onto a seeded database and the PRE-EXISTING warning did not name the orphan it found"

# Its count, on the same seeded row: a report that counts the wrong set says
# zero, which reads exactly like a clean database.
plant "M4 the apply-time report counts the wrong set" "$M4" \
  "  SELECT count(*) INTO v_profiles FROM public.field_availability_profiles WHERE field_id IS NULL;" \
  "  SELECT count(*) INTO v_profiles FROM public.field_availability_profiles WHERE field_id IS NOT NULL;" \
  "20260908000000: re-applied onto a seeded database and the PRE-EXISTING warning did not name the orphan it found"

# **The revert's count, on the row run.sh plants for it.** Without the seed this
# would report zero on a fresh database and prove only that the code parses;
# with the seed, a revert that counts the wrong set prints ORPHANS: 0 and the
# check fires.
plant "R4 revert counts no orphans" "$R4" \
  "  SELECT count(*) INTO v_p FROM public.field_availability_profiles WHERE field_id IS NULL;" \
  "  SELECT count(*) INTO v_p FROM public.field_availability_profiles WHERE field_id IS NOT NULL;" \
  "revert 20260908000000: planted a field-less profile with a blackout window and the revert did not count it"

# A revert that puts the unguarded body back without saying so is the same
# silence this migration removes, one level up.
plant "R4 revert reinstates the unguarded body silently" "$R4" \
  "  RAISE WARNING 'RESTORING finalize_field_availability_import_job to its pre-20260908000000 body:" \
  "  RAISE NOTICE 'reinstating the previous finalize body:" \
  "revert 20260908000000: restored the unguarded finalize without naming what that costs"

# **A revert that names one cost of three.** The migration bundles the guard,
# the warning_summary merge and the validation_errors clearing; restoring the
# body verbatim undoes all three, and an operator reverting during an incident
# reads the warnings and nothing else.
plant "R4 revert does not name the two bundled fixes it also undoes" "$R4" \
  "  RAISE WARNING 'ALSO REVERTING two fixes bundled into 20260908000000:" \
  "  RAISE NOTICE 'restoring the previous body, second note:" \
  "revert 20260908000000: planted a row refused with reason=field_unresolved and the revert did not name the two bundled fixes it undoes, or did not count it"

# The count in that warning, on the row run.sh plants for it: a revert that
# counts the wrong set reports zero and the check fires.
plant "R4 revert counts no stranded refusals" "$R4" \
  "     AND r.applied_at IS NULL
     AND EXISTS (SELECT 1" \
  "     AND r.applied_at IS NOT NULL
     AND EXISTS (SELECT 1" \
  "revert 20260908000000: planted a row refused with reason=field_unresolved and the revert did not name the two bundled fixes it undoes, or did not count it"

# **The verdict's three red branches, one plant each**, because the lesson from
# R3 was that a claim with one reachable branch is a claim two-thirds untested.
#
# STILL-GUARDED: a revert that is a no-op. The comment carries the marker, so
# the restored body reads as still carrying the guard while being the old one.
plant "R4 revert leaves the guard in place" "$R4" \
  "  v_row_errors jsonb;
BEGIN" \
  "  v_row_errors jsonb; -- field_unresolved
BEGIN" \
  "revert 20260908000000: finalize_field_availability_import_job after the revert reads STILL-GUARDED"

# GONE: a revert that removes the function instead of restoring it. The DROP
# goes in front of the trailing COMMENT and the comment is re-aimed at the
# schema, so the revert still applies cleanly and the VERDICT is what fires --
# not the stage, on a script that failed half way.
plant "R4 revert drops the finalizer instead of restoring it" "$R4" \
  "COMMENT ON FUNCTION public.finalize_field_availability_import_job(uuid, jsonb) IS
  'Applies staged field_availability rows. Reverted" \
  "DROP FUNCTION public.finalize_field_availability_import_job(uuid, jsonb);
COMMENT ON SCHEMA public IS
  'Applies staged field_availability rows. Reverted" \
  "revert 20260908000000: finalize_field_availability_import_job after the revert reads GONE"

# AMBIGUOUS: a revert that removes too little. The restored body arrives under a
# CHANGED signature, so 20260908000000's guarded version is left standing beside
# it and every two-argument call becomes 42725 function is not unique.
plant "R4 revert restores the finalizer under a second signature" "$R4" \
  "  p_validation_errors jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb" \
  "  p_validation_errors jsonb DEFAULT '[]'::jsonb,
  p_unused integer DEFAULT 0
) RETURNS jsonb" \
  "revert 20260908000000: finalize_field_availability_import_job after the revert reads AMBIGUOUS:2"

# ---------------------------------------------------------------------------
# LIVE-3: the third deleter, and the profile that outlived its ground
# ---------------------------------------------------------------------------

# **The defect itself.** Put the two-table union back in front of the field
# delete. A field held only by a free-standing assignment or an availability
# profile then rolls back unrefused, which is LIVE-3 exactly.
plant "M5 the rollback goes back to its two-table guard" "$M5" \
  "                SELECT count(*) INTO v_affected_count
                  FROM public.field_bookings(
                         v_job.organization_id, v_record.target_id, NULL);" \
  "                SELECT count(*) INTO v_affected_count
                  FROM public.practice_slots ps
                 WHERE ps.organization_id = v_job.organization_id
                   AND ps.field_id = v_record.target_id;" \
  "smoke 20260909000000"

# **The sixth arm, removed.** `admin_delete_field` then reports nothing for a
# field carrying only a profile and deletes it, which is the half of LIVE-3
# LIVE-2 measured. Section 6 of the new smoke is what must see this.
plant "M5 the producer loses its availability_profile arm" "$M5" \
  "    SELECT 'availability_profile'::text, fap.id," \
  "    SELECT 'availability_profile'::text, fap.id
    FROM public.field_availability_profiles fap WHERE false;
    SELECT 'never'::text, fap.id," \
  "smoke 20260907000000"

# **The FK left SET NULL.** Nothing about the reporting changes -- the arm
# still names the profile -- but a confirmed delete strands it again, and the
# disposition literal `cascades = true` becomes a lie the catalogue contradicts.
plant "M5 the profile FK stays SET NULL" "$M5" \
  "  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE CASCADE;" \
  "  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE SET NULL;" \
  "smoke 20260907000000"

# **The silent arm, restored.** An unhandled `target_table` is stamped as
# rolled back having deleted nothing -- the class 8.3 recorded three instances
# of. Section 5c of the new smoke calls the RPC with exactly such a record.
plant "M5 an unhandled target_table falls through silently again" "$M5" \
  "            ELSE
                -- **The arm that used to be missing.**" \
  "            ELSIF false THEN
                -- **The arm that used to be missing.**" \
  "smoke 20260909000000"

# **The blocked list, reduced to a counter.** The refusal still fires and the
# count is still right; what the operator loses is which record and why.
plant "M5 a blocked record stops saying which one and why" "$M5" \
  "                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'bookings_exist',
                        'affected_count', v_affected_count);" \
  "                    NULL;" \
  "smoke 20260909000000"

# **The subunit argument, falsified at its root.** Give `game_slots` a
# `field_subunit_id` and the subunit arm's single `practice_slots` check stops
# being a complete cut of the closure. Nothing else in the harness looks at
# this, which is the point: section 2 exists because the argument is about the
# graph rather than about the code.
plant "M5 a second edge joins the subunit closure unnoticed" "$M5" \
  "BEGIN;

-- ---------------------------------------------------------------------------
-- 1. field_availability_profiles.field_id" \
  "BEGIN;

ALTER TABLE public.game_slots
  ADD COLUMN field_subunit_id uuid REFERENCES public.field_subunits(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 1. field_availability_profiles.field_id" \
  "smoke 20260909000000"

# **A fifth dependent on the profile.** It would be destroyed by a confirmed
# delete with nothing in `affected` accounting for it -- the reason the four
# parts are excluded from the booking list rather than ignored.
plant "M5 a fifth table hangs off the profile unnoticed" "$M5" \
  "COMMENT ON COLUMN public.field_availability_profiles.field_id IS" \
  "CREATE TABLE public.field_profile_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.field_availability_profiles(id) ON DELETE CASCADE
);
COMMENT ON COLUMN public.field_availability_profiles.field_id IS" \
  "smoke 20260909000000"

# **The derived deleter set, against a fourth deleter.** A new function that
# removes a field without consulting the producer is precisely how LIVE-3
# arrived -- the third deleter was on nobody's list.
plant "M5 a fourth function deletes a field without the producer" "$M5" \
  "GRANT EXECUTE ON FUNCTION public.rollback_field_import_job(uuid) TO authenticated;" \
  "GRANT EXECUTE ON FUNCTION public.rollback_field_import_job(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_purge_field(p_field_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$purge\$
BEGIN
  DELETE FROM public.fields WHERE id = p_field_id;
END;
\$purge\$;" \
  "smoke 20260909000000"

# **The comment that goes stale.** Leave the view telling the next reader that
# the profile is excluded from the delete guard, which this migration makes
# false. Section 7 of the new smoke is the only thing that can see it.
plant "M5 the collapse-blocker comment is left stale" "$S5" \
  "  IF v_view LIKE '%excluded from admin_delete_field%' THEN" \
  "  IF v_view LIKE '%a phrase that appears in no comment anywhere%' THEN" \
  "smoke 20260909000000" \
  "smoke 20260908000000"

# **The new smoke's own anchors.** A section whose parse silently matches
# nothing passes every NOT LIKE below it -- the meta-assertion failure this
# project has found in its own assertion files twice.
plant "M5-SMOKE the fields-arm parse is allowed to match nothing" "$S5" \
  "  IF length(v_fields_arm) < 200 THEN" \
  "  IF length(COALESCE(v_fields_arm, '')) < 0 THEN" \
  "smoke 20260909000000"

# **The asymmetry inside the fix.** `game_assignments` reaches a game slot
# through `game_slot_id` AND `slot_id`, both CASCADE, and the arm read only the
# first while its practice sibling read both. Put it back and an assignment
# carrying `slot_id` alone is destroyed by the rollback with nothing refusing.
plant "M5 the game_slots arm forgets slot_id again" "$M5" \
  "                      AND (
                        ga.game_slot_id = v_record.target_id
                        OR ga.slot_id = v_record.target_id
                      )" \
  "                      AND ga.game_slot_id = v_record.target_id" \
  "smoke 20260909000000"

# **A third table referencing `locations`.** The arm refuses only while a FIELD
# remains, so a new referent that is not under `fields` would be destroyed by a
# rollback in silence -- which is exactly what happened when 20260906000100
# added `field_blackouts.location_id` and nothing noticed.
plant "M5 a third table references locations unnoticed" "$M5" \
  "-- ---------------------------------------------------------------------------
-- 2. The producer gains a SIXTH kind" \
  "CREATE TABLE public.location_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 2. The producer gains a SIXTH kind" \
  "smoke 20260909000000"

# **The unbounded audit row.** Write the raw list where the digest goes and a
# rollback refused on a busy season stores an arbitrarily large array in
# `warning_summary` and the audit row on every attempt -- the hazard
# 20260907000000 built `field_bookings_digest` for.
plant "M5 the audit row gets the raw blocked list" "$M5" \
  "        'blocked', public.field_bookings_digest(v_blocked)" \
  "        'blocked', v_blocked" \
  "smoke 20260909000000"

# **The lock, removed.** Structural only -- a race needs a second session and
# the harness runs one -- so the plant proves the ASSERTION can fail, not that
# the race is reproduced. Said out loud rather than implied.
plant "M5 the fields arm counts bookings without locking the field" "$M5" \
  "                PERFORM 1 FROM public.fields f
                 WHERE f.id = v_record.target_id
                   AND f.organization_id = v_job.organization_id
                 FOR UPDATE;" \
  "                -- lock removed" \
  "smoke 20260909000000"

# Two of three is not three: the field is locked and its slots are not, which
# is the half that covers `games` and a slot-only assignment.
plant "M5 the fields arm locks the field but not its slots" "$M5" \
  "                PERFORM 1 FROM public.game_slots gs
                 WHERE gs.organization_id = v_job.organization_id
                   AND gs.field_id = v_record.target_id
                 FOR UPDATE;" \
  "                -- slot lock removed" \
  "smoke 20260909000000"

# **A lock in another arm.** Correct-looking and a deadlock cycle: it acquires
# a slot before the field, which is the opposite order to admin_delete_field.
plant "M5 a second arm starts taking a row lock" "$M5" \
  "            ELSIF v_record.target_table = 'practice_slots' THEN
                IF EXISTS (" \
  "            ELSIF v_record.target_table = 'practice_slots' THEN
                PERFORM 1 FROM public.practice_slots ps
                 WHERE ps.id = v_record.target_id
                 FOR UPDATE;
                IF EXISTS (" \
  "smoke 20260909000000"

# **The prune, removed.** A confirmed delete then leaves a scenario holding
# nothing -- still listed by get_field_availability_scenarios and still
# activatable by admin_select_field_availability_scenario.
plant "M5 a confirmed delete leaves an emptied scenario standing" "$M5" \
  "    v_deleted_scenarios := public.prune_empty_field_availability_scenarios(
                             p_organization_id, v_scenario_ids);" \
  "    v_deleted_scenarios := 0;" \
  "smoke 20260909000000"

# **The capture, moved after the delete**, which is the subtle way to get this
# wrong: the call is there, the helper is there, and by the time it runs the
# membership rows it reads are already gone, so it always returns nothing.
plant "M5 the scenario capture happens after the cascade removed its evidence" "$M5" \
  "    v_scenario_ids := public.field_availability_scenario_ids_on_field(
                        p_organization_id, p_field_id);

    DELETE FROM public.fields" \
  "    DELETE FROM public.fields" \
  "smoke 20260909000000"

# **The prune widened to a sweep.** It would take an empty scenario created by
# some other path -- a decision nobody has made, and the reason the sibling's
# contract is narrow.
plant "M5 the prune sweeps every empty scenario in the organisation" "$M5" \
  "       AND s.id = ANY(p_scenario_ids)
       AND NOT EXISTS (" \
  "       AND NOT EXISTS (" \
  "smoke 20260909000000"

# **A helper left reachable.** 20260614000000 grants EXECUTE to `authenticated`
# by default privilege, so dropping the explicit revoke does not merely fail to
# tighten anything -- it leaves the function callable by every authenticated
# user while its COMMENT says otherwise. The same claim 20260907000000's
# section 5c was written after.
plant "M5 a scenario helper is left callable by authenticated" "$M5" \
  "REVOKE ALL ON FUNCTION public.prune_empty_field_availability_scenarios(uuid, uuid[]) FROM authenticated;" \
  "-- revoke removed" \
  "smoke 20260909000000"

# ---------------------------------------------------------------------------
# LIVE-3's revert: four warnings, two counts, three verdicts
# ---------------------------------------------------------------------------

# It counts the profiles a future delete will strand. Counting the ALREADY
# stranded ones instead reports the wrong set and reads as reassuring.
plant "R5 revert counts the wrong profiles" "$R5" \
  "  SELECT count(*) INTO v_attached
    FROM public.field_availability_profiles WHERE field_id IS NOT NULL;" \
  "  SELECT count(*) INTO v_attached
    FROM public.field_availability_profiles WHERE field_id IS NULL;" \
  "revert 20260909000000: planted an attached profile with a window and an already-orphaned one, and the revert did not count all three"

# It names the sixth booking kind it is removing. A revert that restores a
# narrower producer without saying so is the same silence one level up.
plant "R5 revert removes the sixth kind silently" "$R5" \
  "  RAISE WARNING 'RESTORING public.field_bookings to five kinds:" \
  "  RAISE NOTICE 'restoring the previous producer:" \
  "revert 20260909000000: restored the five-kind producer without naming what that costs"

plant "R5 revert reinstates the two-table rollback guard silently" "$R5" \
  "  RAISE WARNING 'RESTORING rollback_field_import_job to its two-table guard:" \
  "  RAISE NOTICE 'restoring the previous rollback body:" \
  "revert 20260909000000: restored the two-table rollback guard without naming what that costs"

# **A revert that names three costs of four.** The fourth is the pair of silent
# switch arms and the blocked list, and its count is what run.sh's seeded job
# makes non-empty.
plant "R5 revert does not name the silent arms it restores" "$R5" \
  "  RAISE WARNING 'ALSO REVERTING two silent switch arms and the blocked list:" \
  "  RAISE NOTICE 'also reverting some other things:" \
  "revert 20260909000000: planted a job carrying field_rollback.blocked and the revert did not name the silent arms it restores, or did not count it"

plant "R5 revert counts no stranded blocked lists" "$R5" \
  "  SELECT count(*) INTO v_blocked_jobs
    FROM public.import_jobs
   WHERE warning_summary -> 'field_rollback' ? 'blocked';" \
  "  v_blocked_jobs := 0;" \
  "revert 20260909000000: planted a job carrying field_rollback.blocked and the revert did not name the silent arms it restores, or did not count it"

# The producer verdict, on each branch it can go red by. STILL-SIX-KINDS: a
# revert that restores everything else and leaves the sixth arm standing.
plant "R5 revert leaves the sixth arm in the producer" "$R5" \
  "    FROM public.practice_assignments pa
    CROSS JOIN LATERAL (" \
  "    FROM public.practice_assignments pa
    CROSS JOIN LATERAL (
        SELECT NULL::date WHERE 'availability_profile' = ''
    ) AS unused_marker," \
  "revert 20260909000000: field_bookings after the revert reads STILL-SIX-KINDS"

# GONE: a revert that removes the producer instead of restoring it. Both
# callers then raise undefined_function on the next delete.
plant "R5 revert drops the producer instead of restoring it" "$R5" \
  "COMMENT ON FUNCTION public.field_bookings(uuid, uuid, date) IS" \
  "DROP FUNCTION public.field_bookings(uuid, uuid, date) CASCADE;
COMMENT ON SCHEMA public IS" \
  "revert 20260909000000: field_bookings after the revert reads GONE"

# AMBIGUOUS: the restored producer arrives under a changed signature, so the
# six-kind version is left standing beside it and every call is 42725.
plant "R5 revert restores the producer under a second signature" "$R5" \
  "    p_after date DEFAULT NULL
)
RETURNS TABLE (" \
  "    p_after date DEFAULT NULL,
    p_unused integer DEFAULT 0
)
RETURNS TABLE (" \
  "revert 20260909000000: field_bookings after the revert reads AMBIGUOUS:2"

# The rollback verdict. STILL-CALLS-PRODUCER: a revert that restores the two
# smaller things and leaves the rollback on the producer it also narrows.
plant "R5 revert leaves the rollback on the producer" "$R5" \
  "            ELSIF v_record.target_table = 'fields' THEN
                IF EXISTS (
                    SELECT 1 FROM public.practice_slots ps" \
  "            ELSIF v_record.target_table = 'fields' THEN
                -- public.field_bookings
                IF EXISTS (
                    SELECT 1 FROM public.practice_slots ps" \
  "revert 20260909000000: rollback_field_import_job after the revert reads STILL-CALLS-PRODUCER"

plant "R5 revert drops the rollback instead of restoring it" "$R5" \
  "GRANT EXECUTE ON FUNCTION public.rollback_field_import_job(uuid) TO authenticated;" \
  "DROP FUNCTION public.rollback_field_import_job(uuid);" \
  "revert 20260909000000: rollback_field_import_job after the revert reads GONE"

plant "R5 revert restores the rollback under a second signature" "$R5" \
  "CREATE OR REPLACE FUNCTION public.rollback_field_import_job(p_import_job_id uuid)
RETURNS jsonb" \
  "CREATE OR REPLACE FUNCTION public.rollback_field_import_job(p_import_job_id uuid, p_unused integer DEFAULT 0)
RETURNS jsonb" \
  "revert 20260909000000: rollback_field_import_job after the revert reads AMBIGUOUS:2"

# **The constraint the revert exists to put back.** A revert that restores both
# bodies and leaves the FK CASCADE is a half-revert whose warnings are all
# true and whose schema does not match them.
# **The revert drops two helpers, so the body it restores must not call
# them.** A revert that puts the PRUNING body back and drops the helpers
# underneath it makes every subsequent delete raise undefined_function -- the
# R3 shape, one migration along, and the reason that verdict enumerates its red
# branches instead of testing for the one way it can be right.
plant "R5 revert restores a body that still calls the dropped helpers" "$R5" \
  "    DELETE FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id;" \
  "    v_scenario_ids := public.field_availability_scenario_ids_on_field(
                        p_organization_id, p_field_id);
    DELETE FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id;" \
  "revert 20260909000000: admin_delete_field after the revert reads STILL-PRUNES"

plant "R5 revert drops admin_delete_field instead of restoring it" "$R5" \
  "REVOKE ALL ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) TO authenticated;" \
  "DROP FUNCTION public.admin_delete_field(uuid, uuid, boolean);" \
  "revert 20260909000000: admin_delete_field after the revert reads GONE"

plant "R5 revert leaves the FK cascading" "$R5" \
  "  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE SET NULL;" \
  "  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE CASCADE;" \
  "revert 20260909000000: field_availability_profiles.field_id reads ON DELETE 'c' after the revert, wanted n (SET NULL)"

# **The forward migration's own LEAVING report.** run.sh plants a field-less
# profile and re-applies the migration, because a from-scratch build never
# reaches that branch -- the unreached-warning defect LIVE-2's round 1 found.
plant "M5 the LEAVING report never fires" "$M5" \
  "  IF v_orphans > 0 THEN" \
  "  IF false THEN" \
  "20260909000000: re-applied onto a seeded database and the LEAVING warning did not name the orphan it found"

plant "M5 the LEAVING report counts the wrong set" "$M5" \
  "  SELECT count(*) INTO v_orphans
    FROM public.field_availability_profiles p
   WHERE p.field_id IS NULL;" \
  "  SELECT count(*) INTO v_orphans
    FROM public.field_availability_profiles p
   WHERE p.field_id IS NOT NULL;" \
  "20260909000000: re-applied onto a seeded database and the LEAVING warning did not name the orphan it found"

# ---------------------------------------------------------------------------
# The census, executed rather than counted by eye
# ---------------------------------------------------------------------------
#
# **"All seven claims have a plant" was a sentence in a comment, and it was
# false.** Claim 6 had none, and nothing in the run said so -- the sweep printed
# every plant caught and exited 0 with a health claim nobody had ever tried to
# make fail. That is the same falsely perfect result this whole file exists to
# stop, one level up: a census that cannot fail is not a census.
#
# So it runs. The UNIVERSE comes from the BASELINE transcript -- a claim is a
# claim because the green harness PRINTED it -- and not from this file, because
# a set derived from the thing being checked compares a set against itself. Add
# a claim to run.sh and this fails on its first run rather than on the round
# someone re-counts. The COVERAGE comes from the table below, and it is checked
# against THIS RUN's results: a prover that has stopped catching its defect
# fails the census exactly as loudly as a claim with no prover at all.
#
# The only branch deliberately without a prover is still QUERY-FAILED, argued
# where it lives: it comes from `psql_cmd` itself failing, which no mutation of
# a file this sweep plants can cause. Claim 4's other three branches are named
# here, all three, because the rule that finding taught is to enumerate the ways
# a claim can go RED rather than the lines it prints when it does not.
declare -A CLAIM_PROVER=(
  ["(checked) the revert named the retirement it was about to erase"]="R1 revert erases a future retirement silently"
  ["(checked) the revert counted the practice assignment it was about to expose"]="R3 revert exposes dangling rows silently"
  ["(checked) the revert named the retirement guard it was putting back"]="R3 revert reinstates the weaker guard silently"
  ["(checked) exactly one public.admin_retire_field survives the revert, and it no longer calls the dropped producer"]="R3 revert drops the retirement RPC instead of restoring it|R3 the restored retire still calls the dropped producer|R3 revert restores retire under a second signature"
  ["(checked) the restored admin_retire_field resolves and runs both its refusal and its confirmed path"]="R3 the restored retire calls a helper the revert also drops|R3 the restored retire's CONFIRMED path calls a dropped helper"
  ["(checked) the revert counted the field-less profile already in the database"]="R4 revert counts no orphans"
  ["(checked) the revert named the import guard it was putting back"]="R4 revert reinstates the unguarded body silently"
  ["(checked) applying the migration onto a database that already holds a field-less profile warns and counts it"]="M4 the apply-time orphan report never fires|M4 the apply-time report counts the wrong set"
  ["(checked) the revert named the two bundled fixes it also undoes, and counted the rows one of them strands"]="R4 revert does not name the two bundled fixes it also undoes|R4 revert counts no stranded refusals"
  ["(checked) exactly one public.finalize_field_availability_import_job survives the revert, and its body no longer carries the resolution guard"]="R4 revert drops the finalizer instead of restoring it|R4 revert leaves the guard in place|R4 revert restores the finalizer under a second signature"
  ["(checked) applying the migration onto a database that already holds a field-less profile counts what it leaves behind"]="M5 the LEAVING report never fires|M5 the LEAVING report counts the wrong set"
  ["(checked) the revert counted the attached profile and its window it was about to expose, and the orphan already there"]="R5 revert counts the wrong profiles"
  ["(checked) the revert named the sixth booking kind it was removing"]="R5 revert removes the sixth kind silently"
  ["(checked) the revert named the rollback guard it was putting back"]="R5 revert reinstates the two-table rollback guard silently"
  ["(checked) the revert named the two silent arms it restores, and counted the jobs whose blocked list is stranded"]="R5 revert does not name the silent arms it restores|R5 revert counts no stranded blocked lists"
  ["(checked) exactly one public.field_bookings survives the revert, and it no longer enumerates the profile"]="R5 revert drops the producer instead of restoring it|R5 revert leaves the sixth arm in the producer|R5 revert restores the producer under a second signature"
  ["(checked) exactly one public.rollback_field_import_job survives the revert, and it no longer calls the producer"]="R5 revert drops the rollback instead of restoring it|R5 revert leaves the rollback on the producer|R5 revert restores the rollback under a second signature"
  ["(checked) field_availability_profiles.field_id is back to ON DELETE SET NULL"]="R5 revert leaves the FK cascading"
  ["(checked) exactly one public.admin_delete_field survives the revert, and it no longer calls the dropped scenario helpers"]="R5 revert drops admin_delete_field instead of restoring it|R5 revert restores a body that still calls the dropped helpers"
  ["(checked) the rollback removed every overload of all four admin facility RPCs"]="EMERG the rollback and its own guard drift together"
  ["(checked) it left public.field_bookings standing, which admin_retire_field still calls"]="EMERG rollback takes the producer another RPC still calls"
)

echo
census_ok=1
declare -A CLAIM_SEEN=()
# Whole-line, for the reason the `green` matcher is: `  | NOTICE:  ...` carries
# the same prefix, and a NOTICE is something a plant writes.
while IFS= read -r claim; do
  [ -n "$claim" ] || continue
  CLAIM_SEEN["$claim"]=1
  if [ -z "${CLAIM_PROVER[$claim]+x}" ]; then
    echo "CENSUS FAIL: run.sh prints a health claim no plant is declared for:"
    echo "    $claim"
    census_ok=0
    continue
  fi
  IFS='|' read -r -a provers <<<"${CLAIM_PROVER[$claim]}"
  for prover in "${provers[@]}"; do
    if [ "${RESULT[$prover]:-}" != "CAUGHT" ]; then
      echo "CENSUS FAIL: the claim"
      echo "    $claim"
      echo "  is declared proved by the plant \"$prover\", which this run scored ${RESULT[$prover]:-NOT AT ALL}"
      census_ok=0
    fi
  done
done < <(sed -n 's/^  | \((checked) .*\)$/\1/p' /tmp/harness_baseline_out)

# The other direction: a claim that was renamed or removed leaves its entry here
# naming nothing, and an entry nobody checks is the unread field this project
# keeps finding. A stale key is a failure, not a tidy-up.
for claim in "${!CLAIM_PROVER[@]}"; do
  if [ -z "${CLAIM_SEEN[$claim]+x}" ]; then
    echo "CENSUS FAIL: a plant is declared for a claim the green harness never printed:"
    echo "    $claim"
    census_ok=0
  fi
done

# And the meta-assertion, because every assertion above passes vacuously over an
# empty universe: a baseline transcript with no claim lines in it would report a
# clean census having examined nothing.
if [ "${#CLAIM_SEEN[@]}" -eq 0 ]; then
  echo "CENSUS FAIL: the baseline transcript carries no (checked) claim line at all"
  census_ok=0
fi

if [ "$census_ok" -eq 1 ]; then
  echo "census: ${#CLAIM_SEEN[@]} health claims, each with a plant that reached one of its red branches in this run"
fi

# **Three numbers, not one.** A single "N caught" cannot tell a genuine catch
# from a plant that never applied: last round seven mutations reported RED and
# every one was trivially red against an already-red suite. So the count of
# attempts, the count that failed to anchor (and are therefore MEANINGLESS, not
# passes), and the count genuinely caught are reported separately, and a single
# anchor miss fails the run.
echo
echo "attempted $ATTEMPTED, anchor-miss $MISS (meaningless), caught $PASS, not caught $((FAIL-MISS))"
[ "$FAIL" -eq 0 ] || exit 1
# Kept out of $FAIL so the three numbers stay a count of PLANTS, and a separate
# exit so a census failure cannot be read as a plant that went uncaught.
[ "$census_ok" -eq 1 ] || exit 1
