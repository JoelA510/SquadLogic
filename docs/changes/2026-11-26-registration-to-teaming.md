# Registration to teaming after a first import

Approved scope, November 26, 2026. Restore the path from an empty season to reviewed teams, including reopening the app before generation.

## Reproduction and acceptance

**Executed on the hosted app.** A new season accepted a synthetic player file naming U10. The directory showed all players with an empty division. The first generate reported every registration unmatched. Saving U10's rules and repeating the same import allowed the eligible players to be placed. Reloading Teams before the first generation also lost the import-based generation controls.

1. The player finalizer resolves an explicit division label within the job's destination season. Create each distinct missing named division once while holding the existing season lock. A supplied division ID belongs to the destination season. Preserve derived divisions for GotSport's age-and-gender exports. Test mixed case, duplicate labels, another season with the same label, and repeat application.
2. Rebuild generation inputs from paged, season- and organization-filtered player records. Use their saved identities, division names, waitlist state and balancing fields. Retain a newly imported file's supported hints on its immediate workflow. Discard stale results on a season switch. A historical player with no recoverable division needs explicit correction or reimport. Display that outcome.
3. Exercise first generation after reloading and verify the count against the input, then run again with a late registrant. Confirm that the other season, reviewed team identities, and existing placements stay intact. Cover the schema and mock independently. Reverse the change in test to show the failure.
4. Apply the migration in CI after review. Ship a guarded revert and smoke test. Retest on the hosted UI using a new synthetic season. The migration changes the finalizer prospectively. An administrator can reimport the original file to repair an earlier unassigned registration. No league-wide backfill.

The repair uses existing registration fields and membership checks. It requires no dependency, new user data category, preference change, or league-wide reshuffle. The test-suite audit and desktop build retain their own completion gates.
