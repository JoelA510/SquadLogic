# Fall 2026 field availability fixture

This fixture pack captures a **Fall 2026** availability import scenario used by pgTAP and JS lifecycle regression tests.

## Source mapping assumptions

- One CSV row maps to one `field_availability_profiles` row.
- Venue names are synthetic (`Venue A` .. `Venue J`); `tests/realNameDenylist.test.js` keeps the original real names out of the tree.
- Venue E Upper/Lower and Venue F are modeled as `available_from=2026-09-01` and include `blackout_months=Aug` for explicit August exclusion checks.
- Venue G is modeled as `available_from=2026-08-01`, `available_until=2026-10-31`, and `blackout_months=Sep` to represent "open in August/October, closed in September".
- Venue H and Venue I are represented with `record_status=excluded` so they import but remain non-active.
- Venue J rows are represented as `record_status=potential` + `approval_status=pending` and grouped with `scenario_name=Venue J Potential` / `scenario_group=venue_j`.
- Equipment requirement rows are only created when `goal_equipment` and/or `goal_status` is present.
