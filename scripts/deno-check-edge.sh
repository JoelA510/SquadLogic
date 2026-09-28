#!/usr/bin/env bash
#
# Type-check every Supabase Edge Function entrypoint with `deno check`.
#
# **Why this exists.** Until this script, no CI step type-checked an Edge
# entrypoint. `deno-mirror-tests.sh` runs `deno test` over `_shared/tests/`,
# which checks those tests and what they import -- and no test imports an
# `index.ts`. The deploy job runs `supabase functions deploy`, which bundles the
# function; nothing in this repo relies on it to type-check. So
# `calendar-feed/index.ts` sat on main with two type errors (#483) and every
# gate was green.
#
# **The subject set is the function directories, not a list.** Every directory
# directly under supabase/functions/ is a function, except `_`-prefixed ones
# (`_shared`), which the Supabase CLI does not deploy. Enumerating directories
# rather than globbing `*/index.ts` means a function directory with no
# `index.ts` is reported, not silently absent. A new function is checked the
# moment its directory exists; this script is not edited for it.
#
# Usage: bash scripts/deno-check-edge.sh
#   EDGE_FUNCTIONS_DIR overrides the directory scanned (default
#   supabase/functions). It exists so the zero-found check can be proven to
#   fire; CI does not set it.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTIONS_DIR="${EDGE_FUNCTIONS_DIR:-$REPO/supabase/functions}"
# The same import map and the same env as scripts/deno-mirror-tests.sh.
IMPORT_MAP="$REPO/supabase/functions/import_map.json"

cd "$REPO" || exit 1

# DENO_NO_PACKAGE_JSON: the root package.json declares a `frontend` workspace
# member with no package.json of its own, which Deno's discovery rejects.
export DENO_NO_PACKAGE_JSON=1

STATUS=0
fail() { echo "FAIL  $*" >&2; STATUS=1; }

echo "=== discovery: ${FUNCTIONS_DIR#"$REPO"/} ==="

if [[ ! -d "$FUNCTIONS_DIR" ]]; then
  fail "functions directory does not exist: $FUNCTIONS_DIR"
  exit 1
fi

FUNCTION_DIRS=()
while IFS= read -r d; do
  [[ -n "$d" ]] && FUNCTION_DIRS+=("$d")
done < <(find "$FUNCTIONS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '_*' | sort)

# `find` exits 0 on no matches, so without this the step would be a green job
# that checked nothing at all.
if [[ ${#FUNCTION_DIRS[@]} -eq 0 ]]; then
  fail "discovery found no Edge Function directories in ${FUNCTIONS_DIR#"$REPO"/} --"
  fail "the step would have checked nothing and passed."
  exit 1
fi

ENTRYPOINTS=()
for d in "${FUNCTION_DIRS[@]}"; do
  if [[ -f "$d/index.ts" ]]; then
    ENTRYPOINTS+=("$d/index.ts")
  else
    fail "function directory has no index.ts: ${d#"$REPO"/}"
  fi
done

echo "discovered ${#ENTRYPOINTS[@]} entrypoint(s) in ${#FUNCTION_DIRS[@]} function dir(s)"
[[ $STATUS -eq 0 ]] || exit 1

# One `deno check` per entrypoint, so the log names each function's result
# rather than one combined verdict.
PASSED=0
for f in "${ENTRYPOINTS[@]}"; do
  rel="${f#"$REPO"/}"
  if deno check --import-map "$IMPORT_MAP" "$f"; then
    echo "  ok    $rel"
    PASSED=$((PASSED + 1))
  else
    fail "deno check: $rel"
  fi
done

echo
if [[ $STATUS -eq 0 ]]; then
  echo "OK  ${PASSED} of ${#ENTRYPOINTS[@]} entrypoint(s) type-check"
else
  echo "FAILED  ${PASSED} of ${#ENTRYPOINTS[@]} entrypoint(s) type-check" >&2
fi
exit $STATUS
