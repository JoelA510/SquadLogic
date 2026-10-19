# B2: export and registration hardening (DS-4, DS-5)

Status: approved by the owner 2026-10-19 (blanket approval of the recommended work). Built in the
PR that carries this file. Source items: July audit DS-4 and DS-5; placed in B2 by the Close-out of
`docs/audits/2026-10-production-readiness/remediation-plan.md`. AGENTS.md rule 14 applies to DS-5
(persistence): this is the plan.

## DS-4: formula characters in CSV exports

**What was wrong.** Every CSV a person opens in a spreadsheet quoted only `"`, `,`, CR and LF. A
team, coach, opponent or notes cell that begins `=`, `+`, `-` or `@` (a leading tab or CR also
works) is run as a formula by Excel, LibreOffice and Sheets. The cells are free text that
registration and import put there.

**CSV writers found** (search: `text/csv`, `new Blob`, `join(',')`, `escapeCsv|quoteCell|toCsv`
over `packages/`, `frontend/src/`, `supabase/` and `scripts/`; Edge Functions write none, and
`calendar-feed` writes ICS):

| Writer                                               | Output                                                                                                                                         | Decision                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outputGeneration.formatCsv` (core)                  | master and per-team schedule exports, downloaded and uploaded to the `exports` bucket; also the roster export in `AdminReportingDashboard.jsx` | **escape**                                                                                                                                                               |
| `frontend/src/utils/csvTemplates.js` `escapeCsvCell` | import template download (constant example rows)                                                                                               | **escape**, by adopting the shared helper (one rule, one copy)                                                                                                           |
| `ColumnMapper.serializeCanonicalCsv`                 | re-packages an upload for our own import parser                                                                                                | **leave**: not a file anyone opens; a prefix would corrupt names and `+1...` phone numbers on import. The export is where data meets a spreadsheet, and it escapes there |
| `fieldAdmin/serialise.js` `toCsv` / `quoteCell`      | lossless round-trip of the field registry; only tests call it                                                                                  | **leave**: its reader would have to strip a prefix. Revisit if a download is ever wired to it                                                                            |

**Options.**

1. Prefix an apostrophe to any cell starting `=`, `+`, `-`, `@` (leading spaces allowed, as the July
   audit's fix approach says), tab or CR (OWASP). Cheap, one
   place, every spreadsheet shows text. Costs: a legitimate `-5` is changed unless exempted.
2. Prefix a tab instead. Excel hides it but it stays in the data and breaks re-import.
3. Do nothing and document "open as text". The audit already ruled this out for an admin tool
   that opens files from untrusted registrants.

**Recommendation: option 1, with one exemption.** A JavaScript number, and a string that is only
a signed decimal (`-5`, `+15551234567`, `-0.25`), is written untouched: a spreadsheet reads it as
a number and no formula can be spelled with only digits, one sign and one point. Anything longer
(`-5+cmd`, `+1 (555) 123`, a bare `-`) is neutralised. No export column is numeric today, so there
is no per-column switch to get wrong; the rule is on the value. The helper is `escapeCsvCell` in
`packages/core/src/csv.js`, adopting `escapeCsvValue`'s contract (null and undefined are empty,
RFC 4180 quoting unchanged) so every caller keeps working.

**Risks.** A cell now shows a leading `'` in the file (Excel shows it literally when a CSV is
opened; it is a visible, honest marker). A coach email beginning `+` or `-` (rare), or a free-text cell such as `+1 (555) 123`, is prefixed;
other CSV readers keep the apostrophe as data (the exports carry no phone column today).
Anything that parses our exports back would see the prefix: nothing does (searched).

## DS-5: a throttle on `submit_registration`

**What was wrong.** The RPC is deliberately executable by `anon` (public registration links). It
refuses a caller with no `auth.uid()` or no membership, but nothing capped how many rows a member
could create by repeating the call. `supabase/functions/_shared/rateLimit.ts` serves Edge
Functions only; `[auth.rate_limit]` covers Auth endpoints only.

**Options.**

1. **Count the caller's own recent `registrations` rows inside the RPC** (every successful call
   inserts exactly one). No log table to grow or prune. Needs an index on
   `(profile_id, form_id, created_at)` and a per-caller advisory lock so concurrent calls cannot
   both read nine.
2. A `registration_submission_log` table, written then checked. A refusal raises, which rolls the
   log insert back, so it would count exactly the same events as option 1 for more schema.
3. Throttle at the edge (an Edge Function in front of the RPC, or Vercel). A second public
   surface to build and secure; the anon key still reaches PostgREST directly.
4. A CAPTCHA on `/register`. A product and vendor decision; out of scope here.

**Recommendation: option 1.** Ten registrations per caller per form per 60 seconds (a family
registering several children in one sitting fits; a script does not). The eleventh raises SQLSTATE
`PT429` (PostgREST turns `PTnnn` into that HTTP status) with a message the registration page
already shows (`error.message`). Migration `20261019010000_submit_registration_throttle.sql`
replaces the function wholesale from `20260602010000` (production's body is that text minus its
comment lines, read back 2026-10-19) and adds the index; signature, grants (anon and
authenticated), search_path and comment are unchanged. The mock client mirrors the limit, and a
test ties the mock's observed limit to the migration's.

**Risks.**

- Refused and invalid calls insert nothing, so a flood of calls that fail validation is not
  counted; connection load stays bounded by the platform, not here. A per-organization cap and
  a CAPTCHA are not added.
- The window and limit are constants in the function body: changing them is a new migration (and
  the mock follows; the parity test fails if only one moves).
- Replacing the whole function risks drifting a line of it: the revert restores
  `20260602010000`'s text and the harness compares its md5; the smoke exercises the unchanged
  paths (closed form refused 22023, grants, posture).
- `registrations` is empty in production (read 2026-10-19), so the index builds instantly and no
  existing row changes meaning.
- A registration deleted inside the window lowers the count; only an admin or a cascade deletes one.
- Rollback: `docs/sql/20261019010000_revert.sql` restores the body and drops the index.
