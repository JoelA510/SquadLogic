#!/usr/bin/env bash
#
# Deno mirror tests: run every Deno test under supabase/functions/_shared/tests/,
# under each host zone that matters.
#
# **Why this exists.** The CI job used to name its test files one by one. A file
# left off the list was never run and the job said nothing about it -- the same
# hollow-check shape as #29, where `scripts/dbharness/run.sh` carried a
# hand-maintained `NEW_MIGRATIONS` list and silently skipped every smoke that
# was not on it (fixing that took the harness from 10 smokes to 33).
#
# It is not hypothetical here either. `scoring-engine_test.ts` arrived in #310
# and never ran once, for months, behind a stale comment claiming it was
# excluded for one red expectation. That expectation ('Time overlap', a string
# the engine has never produced) was the only thing wrong with it, and while it
# sat unrun the engine underneath it drifted: `assignedTeams` became
# `assignments.length` and published a negative `unassignedTeams`.
#
# So the default is inverted, exactly as #29 inverted it. The subject set is
# every Deno test file on disk (`*_test.ts` and `*.test.ts`, at any depth --
# the same set `deno test` itself discovers) -- the registry a break leaves
# intact -- and each one is either EXECUTED or named in EXCLUDED below with
# the reason it cannot be. A file is skipped only by being written down, and writing one down that
# does not need to be there fails the run too.
#
# **Both host zones, every file.** The season clock's expectations are absolute
# instants, so an arm that consults the host zone fails exactly one of the two
# runs and a single run could not tell the difference (#400, LIVE-5/LIVE-7).
# That control used to apply to three named files; it now applies to all of
# them, because deciding per-file which ones are zone-sensitive is one more
# hand-maintained list that would go stale the same way.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$REPO/supabase/functions/_shared/tests"
IMPORT_MAP="supabase/functions/import_map.json"

# Every deno invocation below names paths relative to the repo root, so the
# working directory is fixed here rather than just before the final loop.
cd "$REPO" || exit 1

# DENO_NO_PACKAGE_JSON: the root package.json declares a `frontend` workspace
# member with no package.json of its own, which Deno's discovery rejects.
export DENO_NO_PACKAGE_JSON=1

# The host zones the suite is run under. UTC is the Supabase edge default and
# is exactly where a host-zone reading hides; the second zone is what makes the
# first one a control rather than a single reading. Both are checked below --
# one zone silently dropped would leave every assertion in the suite green
# while destroying the only thing that can catch a host-zone read.
ZONES=(UTC America/Los_Angeles)

# **A floor, stated rather than derived.** Its only job is to catch a suite
# that silently shrinks -- a moved directory, a broken glob, a renamed suffix,
# a deleted file. Deriving it by counting what discovery found would compare
# the glob against itself and could never fail.
#
# Adding a test file needs no change here: discovery runs it already.
#
# **Adding an EXCLUDED entry DOES require lowering this number, and that
# friction is the point.** It is checked against RUNNABLE, so one exclusion
# takes the suite to 4 and trips the floor. The obvious softening --
# `${#DISCOVERED[@]} - ${#EXCLUDED[@]}` -- is the hollow version of this
# check: the bar would move down by exactly the amount each new exclusion
# removes, so no exclusion could ever trip it and the floor would only ever
# catch deletions. Suppressing a file must therefore be written down twice,
# once in EXCLUDED and once here, and the lowered number is the durable record
# in the diff that coverage went down. A reviewer seeing `5` become `4` is the
# entire mechanism.
EXPECTED_MIN_TEST_FILES=5

# Test files that must NOT run, each with the reason. Empty is the correct
# state.
#
# **What the checks below actually establish**, stated exactly, because the
# stronger sentence that used to sit here ("an exclusion cannot outlive the
# reason for it") is not what they deliver: an entry naming a file that does
# not exist fails, and an entry whose file now PASSES fails. So an exclusion
# cannot outlive the *failure* it records.
#
# It CAN outlive the *reason* it records. A file whose documented cause was
# fixed while a different failure appeared stays suppressed behind a
# justification that is now false, and nothing here notices. Matching the
# recorded reason against the failure output was considered and rejected:
# it would pin this script to Deno's assertion formatting, and a reason like
# "expects a string the engine has never produced" has no stable textual
# counterpart in the failure at all. A wrong reason is a smaller problem than
# a check that pretends to verify one, so it is written down instead.
EXCLUDED=()

STATUS=0
fail() { echo "FAIL  $*" >&2; STATUS=1; }

# The two-zone control, checked rather than assumed.
if [[ ${#ZONES[@]} -lt 2 ]]; then
  fail "ZONES holds ${#ZONES[@]} zone(s); the host-zone control needs at least two."
  exit 1
fi
if [[ "$(printf '%s\n' "${ZONES[@]}" | sort -u | wc -l)" -lt 2 ]]; then
  fail "ZONES holds no two distinct zones; running the same zone twice is not a control."
  exit 1
fi

echo "=== discovery: ${TEST_DIR#"$REPO"/} ==="

if [[ ! -d "$TEST_DIR" ]]; then
  fail "test directory does not exist: $TEST_DIR"
  exit 1
fi

# **Both suffixes, and no depth limit**, because `deno test` itself discovers
# `*_test.ts` and `*.test.ts` at any depth. A narrower pattern here would mean
# a file that Deno considers a test, and that passes when a developer runs
# `deno test` locally, is skipped by CI without a word -- the same omission
# channel as the old hand-written list, just spelled as a glob.
DISCOVERED=()
while IFS= read -r f; do
  [[ -n "$f" ]] && DISCOVERED+=("$f")
done < <(find "$TEST_DIR" -type f \( -name '*_test.ts' -o -name '*.test.ts' \) | sort)

echo "discovered ${#DISCOVERED[@]} test file(s):"
for f in "${DISCOVERED[@]}"; do echo "  ${f#"$REPO"/}"; done

# The zero case is called out separately: `find` exits 0 on no matches, so
# without this the run would be a green job that executed nothing at all.
if [[ ${#DISCOVERED[@]} -eq 0 ]]; then
  fail "discovery found no *_test.ts files -- the job would have run nothing and passed"
  exit 1
fi

RUNNABLE=()
for f in "${DISCOVERED[@]}"; do
  base="$(basename "$f")"
  skip=0
  for x in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do
    [[ "$base" == "$x" ]] && skip=1
  done
  if [[ $skip -eq 1 ]]; then
    echo "  EXCLUDED  $base"
  else
    RUNNABLE+=("${f#"$REPO"/}")
  fi
done

if [[ ${#RUNNABLE[@]} -eq 0 ]]; then
  fail "every discovered test file is excluded -- nothing would run"
  exit 1
fi

# **The floor counts what RUNS, not what was found.** Checked against
# DISCOVERED it could be satisfied by five files of which four are excluded --
# the floor would pass while one file ran, which is the exact arithmetic that
# let four-of-five look like coverage before this script existed.
if [[ ${#RUNNABLE[@]} -lt $EXPECTED_MIN_TEST_FILES ]]; then
  fail "${#RUNNABLE[@]} test file(s) would run, fewer than the floor of ${EXPECTED_MIN_TEST_FILES}."
  fail "(${#DISCOVERED[@]} discovered, ${#EXCLUDED[@]} excluded.)"
  if [[ ${#EXCLUDED[@]} -gt 0 ]]; then
    fail ""
    fail "If you just added an EXCLUDED entry: this is expected, and the second edit is"
    fail "deliberate. Lower EXPECTED_MIN_TEST_FILES to ${#RUNNABLE[@]} in the same commit."
    fail "That number is the record that coverage went down; see its comment for why the"
    fail "floor is not computed from EXCLUDED automatically."
  else
    fail "A file was deleted or discovery is broken. Neither may pass silently."
  fi
  exit 1
fi

# **An excluded file is RUN, and a pass is a failure of the exclusion.**
# The existence check alone would let an exclusion whose cause was fixed go on
# suppressing a file that now passes -- precisely this PR's incident, where
# `scoring-engine_test.ts` sat excluded for months over a single reconcilable
# expectation.
#
# This establishes "still failing", not "still failing for the recorded
# reason"; see the note on EXCLUDED for why the stronger check was rejected.
for x in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do
  if [[ ! -f "$TEST_DIR/$x" ]]; then
    fail "EXCLUDED names '$x', which does not exist in $TEST_DIR -- a stale exclusion."
    continue
  fi
  if TZ="${ZONES[0]}" deno test --allow-read=. --import-map "$IMPORT_MAP" \
    "${TEST_DIR#"$REPO"/}/$x" >/dev/null 2>&1; then
    fail "EXCLUDED names '$x', but it PASSES under TZ=${ZONES[0]}. Its reason has expired --"
    fail "remove it from EXCLUDED so it runs, rather than leaving a green file suppressed."
  else
    echo "  (exclusion confirmed still red: $x)"
  fi
done

[[ $STATUS -eq 0 ]] || exit 1

echo
echo "=== running ${#RUNNABLE[@]} file(s) under ${#ZONES[@]} host zone(s) ==="

for zone in "${ZONES[@]}"; do
  echo
  echo "--- TZ=$zone ---"
  # --allow-read=. is for the sibling-file assertions in the season-clock arm
  # (the check that the JS arm reads the same vectors table). The vectors
  # themselves arrive as a JSON module import and need no permission.
  if ! TZ="$zone" deno test \
    --allow-read=. \
    --import-map "$IMPORT_MAP" \
    "${RUNNABLE[@]}"; then
    fail "deno test failed under TZ=$zone"
  fi
done

echo
if [[ $STATUS -eq 0 ]]; then
  echo "OK  ${#RUNNABLE[@]} file(s) x ${#ZONES[@]} zone(s) passed"
else
  echo "FAILED" >&2
fi
exit $STATUS
