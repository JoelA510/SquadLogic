# B3: triage of production's unindexed foreign keys and unused indexes

Approved by the owner 2026-10-19 (blanket approval of the recommended work). The recommendation
below is **defer: build nothing, no migration.**

## What production reports

Performance advisors, read 2026-10-19 (_executed_, read-only): 90 `unindexed_foreign_keys` and 19
`unused_index`, all at INFO. The 90 was re-derived from the catalog (it matches), then set against the data (all _executed_, `execute_sql` SELECTs on
`mmwupqsjkikqzvmdvuzm`):

| Measure                                          | Value                                                                                                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live rows in all 57 `public` tables together     | 1,703                                                                                                                                                                                         |
| Largest table                                    | `staging_players`, 1,153 rows (1.8 MB)                                                                                                                                                        |
| Tables with 500 or more rows                     | 1                                                                                                                                                                                             |
| Database size                                    | 27 MB                                                                                                                                                                                         |
| Unindexed FKs on a table with 1,000 or more rows | 1 (`staging_players.promoted_by`, to `auth.users`)                                                                                                                                            |
| Unused indexes (`idx_scan = 0`)                  | 38 with no scan since the stats were reset (the advisor's 19 is a narrower definition). 16 of the 38 back a unique or exclusion constraint. Every one of the rest is on a table with no rows. |

## What an unindexed FK costs

Only two things: a join or filter on the FK column scans the child table, and a delete or key
update on the _parent_ row scans the child table to check or cascade. At 1,153 rows the scan is
under a millisecond. The parents deleted in practice are `organizations`, `teams`, `fields` and
`season_settings`, deleted rarely and by an admin; `auth.users` rows are not deleted by the
application.

## Options

1. **All 90 indexes in one migration.** Removes the advisor's INFO list. Costs 90 new relations,
   write overhead on every insert and update of 90 columns, a migration that must pass the
   harness, a revert and a smoke, and a catalog-snapshot update, for tables where a sequential
   scan is faster than an index scan anyway. Rejected.
2. **A handful, for the tables that grow.** `audit_log` (29 rows; the Phase 9 roadmap records a 180-day
   retention prune, which was not checked here), `staging_players` and `staging_import_rows` (bounded by the import job; staged rows are
   replaced on re-import) are the only ones with a growth story, and none is large. Not yet
   worth a migration.
3. **Defer, with a trigger.** Build nothing now. Revisit when any table passes about 10,000 rows
   (check with the query in "Re-check" below), or before a feature that deletes organizations or
   users in bulk. Recommended.

The 19 unused indexes are not candidates for dropping: production serves a handful of users, so
`idx_scan = 0` says the feature has not been used, not that the index is wasted; 16 of the 38
back constraints; the rest are 8 KB each on empty tables for features (field availability,
practice exceptions, lighting overrides) that shipped recently. Dropping would save nothing and
risk the first real use.

## Re-check

```sql
select c.relname, c.reltuples::bigint as est_rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.reltuples > 10000
order by 2 desc;
```

If it returns a table with an unindexed FK (the advisor names them), write the migration then:
`create index concurrently` is not allowed inside a migration transaction here, so plain
`create index if not exists`, a revert under `docs/sql/`, a smoke, `REVERT_CHECKS` in both
`scripts/dbharness/run.sh` and `prove.sh`, and the claim census.

## Risk of the recommendation

None to the system: nothing changes. The cost is that the advisor's INFO list stays; it is
recorded in the close-out as a known, triaged finding.
