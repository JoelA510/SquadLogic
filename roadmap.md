# Development Roadmap for Youth‑Sports Scheduling Program

This roadmap describes the high‑level steps required to build a cost‑effective youth sports scheduling application.  The goal is to ingest GotSport registrations, form balanced teams with mutual buddy requests, allocate practice slots on weeknights, schedule games on Saturdays, and export per‑team schedules for import into TeamSnap.  The project leverages modern agentic design concepts for flexibility and uses inexpensive cloud services like Netlify or Vercel alongside Supabase.  Citations reference research on agentic systems, scheduling patterns and hosting considerations【21†L225-L233】【25†L155-L163】.

## Progress Summary

- [x] Requirements Analysis & Planning – Documentation complete; validated during the 2024-07-08 audit.
- [x] Architecture & Technology Selection – Documentation complete; audit confirms status.
- [x] Data Modeling & Storage – Documentation complete; audit confirms status.
- [x] Prior Fix Audit – Re-ran practice, game, export, and evaluation regression suites to confirm previously recommended fixes remain in place with no regressions detected.
- [ ] Team Generation – Core allocator implemented in `src/teamGeneration.js` with deterministic unit tests; conflict detection and validation safeguards added, overflow tracking via the new `overflowByDivision` return channel surfaces manual follow-ups, and buddy diagnostics now expose mutual pairs and unresolved requests for admin review through `buddyDiagnosticsByDivision`, while `src/rosterSizing.js` standardizes default roster caps from division formats and UI wiring plus admin workflows remain outstanding.
- [ ] Practice Scheduling – Scheduling workflow outlined in `docs/practice-scheduling.md`; initial slot allocator implemented in `src/practiceScheduling.js` with unit tests, swap-based conflict resolution for unique slot requirements, and metrics reporting now covered by `src/practiceMetrics.js`, while the manual override tooling is exposed through the `lockedAssignments` parameter, the allocator now penalises stacking the same division on a shared base slot to improve field fairness, the new seasonal slot expander `src/practiceSlotExpansion.js` normalises early/late windows ahead of scheduler integration, and admin UI remains to be built.
- [ ] Game Scheduling – Game scheduling blueprint refined in `docs/game-scheduling.md` with clarified inputs and fairness metrics; round-robin generator and the slot allocator in `src/gameScheduling.js` now rotate divisions across shared fields to avoid hogging, emit shared-slot telemetry for downstream analysis, and are covered by regressions in `tests/gameScheduling.test.js`, while Supabase persistence and admin conflict resolution tooling remain outstanding.
- [ ] Evaluation & Refinement – Evaluation pipeline, fairness metrics, and remediation workflow documented in `docs/evaluation.md`; automated schedule checks now include `src/practiceMetrics.js` for practices, the enhanced `src/gameMetrics.js` for games (with shared slot distribution analysis), and the orchestration helper `src/evaluationPipeline.js` that aggregates readiness signals for the admin dashboard while preserving evaluator validation and conflict severity semantics through additional unit tests, and Supabase orchestration plus UI reporting remain outstanding.
- [ ] Output Generation & Integration – Export and communication workflow planned in `docs/output-generation.md`; baseline formatter module `src/outputGeneration.js` with unit tests now produces master and per-team CSV-ready rows with shared header constants and hardened CSV quoting while serverless exporters, storage integration, and admin tooling still required.
- [ ] Front-End Development – Navigation, screen blueprint, and state management approach documented in `docs/frontend-architecture.md`; project scaffolding (e.g., with Vite), Supabase client wiring, and component implementation pending.

## 1. Requirements Analysis & Planning

**Status:** Baseline requirements, iteration plan, and Season Intake form blueprint captured in `docs/requirements.md`; initial Season Intake template exported to `docs/intake-snapshots/season-intake-20240701.csv` with representative data; stakeholder interview agenda, logistics checklist, and capture template (`docs/meeting-notes/stakeholder-interview-template.md`) finalized. Verified during the 2024-07-08 codebase audit, with live stakeholder validation still pending once registrations arrive.

1. **Stakeholder interviews and scope definition** – Meet with the league administrator to confirm the exact feature set: number of divisions, roster size formulas (e.g., 7v7 → max 12 players), buddy rules (only mutual requests are honored), practice days (Mon–Thu), game days (Sat), season duration (August–October), and coach preferences.
2. **Document constraints** – List all hard constraints (one practice per team per week, avoid coach conflicts, field capacities and halves, practice shortening when sunsets change, limit of one buddy per player) and soft preferences (balanced teams, coach time preferences).
3. **Define success criteria** – Establish metrics for schedule quality (no overlaps, even distribution of practice times, equitable field usage) and output requirements (master spreadsheet, per‑team exports, manual email drafts).  Clarify that the scheduler will generate a season schedule at the start and occasionally adjust for weather or field changes.
4. **Plan iterations** – Agree on project phases, acceptance tests and a review process.  Since only one person manages scheduling for ~1500 participants, emphasise automation and user‑friendliness.

## 2. Architecture & Technology Selection

**Status:** Preferred architecture and platform decisions recorded in `docs/architecture.md`; proof-of-concept validation plan outlined, with cost assumption validation, trial deployments, and CI/CD documentation still outstanding. Audit action items call for locking in a default hosting provider before the sandbox spike.

1. **Adopt an agentic design** – Use a modular, goal‑oriented architecture inspired by the Belief–Desire–Intention (BDI) model.  Research shows that multi‑agent systems excel at dynamic scheduling tasks because they can reason about goals, act in complex environments and iteratively refine plans【21†L225-L233】【25†L155-L163】.  The roadmap therefore divides the logic into distinct “agents” or modules: data ingestion, team generation, schedule orchestration and evaluation.
2. **Choose the tech stack** – Implement the back end using Supabase Edge Functions or lightweight serverless handlers in JavaScript/TypeScript, whichever best fits the team’s expertise.  Build the front end using a modern React build tool such as Vite so the UI ships as a static bundle while benefiting from faster dev-server startup and HMR.  Host the bundle on a static provider such as Netlify or Vercel. Evaluate their free-tier allowances for bandwidth, build minutes, and serverless executions to confirm they cover initial usage【503490883893339†L60-L87】.  Store data in Supabase’s free tier, which offers unlimited API requests, 50,000 monthly active users and a 500 MB Postgres database【243507034388311†L19-L47】.  Use Supabase authentication if user roles are needed, and expose configuration via `REACT_APP_*` environment variables.
3. **Assess limitations** – Document the hosting provider's free-tier caps (bandwidth, build minutes, function/runtime quotas) using resources such as Vercel and Netlify plan guides【503490883893339†L60-L124】, and Supabase's limits (project pauses after one week of inactivity, up to two active projects)【243507034388311†L19-L47】. Plan for a possible upgrade if league usage pushes past those allowances.
4. **Define integration points** – Plan integration with TeamSnap via CSV import rather than direct API calls (TeamSnap may support CSV/Excel imports).  Consider adding mailto links or using an email API to generate drafts without auto‑sending.

## 3. Data Modeling & Storage

**Status:** Proposed Supabase schema detailed in `docs/data-modeling.md` with ingestion pipeline workflows elaborated in `docs/ingestion-pipeline.md`; initial DDL captured in `docs/sql/initial_schema.sql` now extends beyond core tables to include scheduler run histories, evaluation artifacts, and export/email logs for observability ahead of Supabase migration tests; reusable Fall 2024 seed data added in `docs/sql/sample_seed_data.sql` to enable realistic local demos; RLS strategy authored in `docs/rls-policies.md`. Audit recommends converting the drafts into timestamped migrations and validating against a Supabase instance.

1. **Design database schema** – Define Supabase tables (or Postgres schemas) for:
   - **Players**: fields include `PlayerID`, name, grade/division, contact details, mutual buddy identifier, skill/experience indicators (if collected), coach volunteer flag.
   - **Teams**: `TeamID`, division, roster size cap, coach details, assigned practice and game slots.
   - **Fields & time slots**: each row represents a discrete resource – location, field number, subfield (A/B), day of week, start time, end time, slot type (practice/game), optional `capacity`.  This declarative representation mirrors the tool schema concept used in agent frameworks【8†L137-L144】.
   - **Coaches**: `CoachID`, name, email, associated player (if a parent), available practice days/times, preferences and multi‑team indicator.
   - **Schedules**: separate tables for practices and games with references to `TeamID` and `FieldSlotID` along with date/duration.
   - **Configuration**: table for adjustable parameters (roster size formulas, buddy rules, season date ranges, practice durations before and after sunset, etc.).
2. **Implement importers** – Write utilities to parse GotSport registration CSVs and field availability spreadsheets.  Validate mutual buddy codes, remove duplicates and store clean data in Supabase.  Provide an admin UI for manual entry of field slots or allow uploading of a standardized CSV containing location, field, subfield, day, start, end and type.
3. **Seed the database** – Populate example data for testing (e.g., sample players, fields and coaches) and write scripts to reset data at the start of each season.  A baseline dataset for Fall 2024 already exists in `docs/sql/sample_seed_data.sql`; follow-up work will integrate it into a Supabase seeding workflow and expand coverage for additional divisions and edge cases.
4. **Validate DDL in Supabase** – Run the script from `docs/sql/initial_schema.sql` against a local Supabase instance, add missing triggers or constraints surfaced during testing, and convert the draft into timestamped migrations.

## 4. Team Generation

**Status:** Team formation algorithm, manual adjustment workflow, and acceptance/test harness outline documented in `docs/team-generation.md`; initial roster allocator now lives in `src/teamGeneration.js` with repeatable `node:test` coverage, and next steps cover Supabase wiring plus roster review UI.

1. **Define roster size rules** – Implemented in `src/rosterSizing.js`, which derives caps via the max roster = 2 × playable roster − 2 formula and respects manual overrides; next steps wire the helper into Supabase-backed configuration with admin UI controls for per-season adjustments.
2. **Implement pairing logic for buddies** – Detect mutual buddy requests and treat each pair as a single unit during assignment.  Ignore one‑sided requests but log them for reference.  When assigning players to teams, always place mutual buddies together unless roster limits or skill balancing rules conflict.
3. **Algorithm for balanced teams** – Develop a function to distribute players evenly across teams:
   - Group registrations by division (and possibly by gender if the league is not co‑ed).
   - Optionally sort players by skill, experience or other attributes to balance ability.  Without rating data, simply randomize the list.
   - Create `N = ceil(totalPlayers / maxRosterSize)` teams and iteratively allocate players (or buddy units) to the team with the current smallest roster.  If a coach’s child is in a division, place that player on their parent’s team and mark the team as coached.
   - Honour volunteer coaches by ensuring they are assigned to a team with their child; assign assistant coaches if needed.
4. **Manual adjustments** – After auto‑assignment, expose rosters in the UI for review.  Allow the admin to swap players between teams by drag‑and‑drop or by editing an exported CSV and re‑uploading it.  Changes should be persisted back to Supabase.

## 5. Practice Scheduling

**Status:** Practice scheduling design captured in `docs/practice-scheduling.md`; initial scheduler service delivered in `src/practiceScheduling.js` with automated tests, with conflict resolution logic, metrics, and admin override tooling still outstanding.

1. **Collect practice slots** – Load field availability for Monday through Thursday evenings, including sub‑fields and capacities.  Represent each slot as a resource with a maximum team capacity (usually 1; 2 if the field can be split into halves).  Include a `ValidUntilDate` to handle shorter practice durations later in the season.
2. **Schedule generation algorithm** – Implement a greedy or constraint‑solving algorithm that assigns each team one weekly practice slot:
   - Prioritize coaches with multiple teams to avoid conflicts, scheduling their teams on different days or at least different times.
   - Respect coach availability preferences (e.g., certain days or times).  Use a scoring function to pick the most preferred available slot; fall back to any slot if preferences cannot be met.
   - Fill slots by looping through teams and assigning the earliest feasible slot with available capacity.  Decrease the slot’s capacity after assignment.
   - If a team cannot be assigned due to capacity limits, attempt targeted swaps to free unique slots and, when that fails, flag the team for manual resolution or create overflow slots (e.g., Friday or Sunday) with admin approval.
3. **Daylight adjustments** – When the league transitions from one‑hour practices to 45‑minute blocks (e.g., in October), adjust existing schedules by splitting each hour slot into two shorter slots (e.g., 4:00–4:45 and 4:45–5:30).  Predefine both sets of slots in the database with validity dates so the scheduler can treat them as separate resources.  Provide an option to output both early‑ and late‑season practice times for each team.
4. **Coach conflict checks** – After assignment, scan the schedule to ensure that no coach appears in overlapping slots and that no field is double‑booked.  Log any conflicts and run a local swap algorithm to resolve them.

## 6. Game Scheduling

**Status:** Game scheduling blueprint documented in `docs/game-scheduling.md`; deterministic round-robin generation and a first-pass slot allocator now live in `src/gameScheduling.js` with unit tests capturing even/odd divisions and coach conflict handling, while Supabase persistence, fairness tuning across shared slots, and admin UI workflows remain upcoming.

1. **Determine game weeks and matchups** – Decide on the number of game weeks (e.g., eight Saturdays) and generate matchups within each division.  Use a round‑robin generator to produce a rotation where each team plays every other team; handle odd numbers of teams with byes or double‑headers.
2. **Assign game slots** – For each week, assign each game (pair of teams) to a Saturday field/time slot.  Use similar logic as practice scheduling: prioritize avoiding coach conflicts, then allocate the earliest available slot.  If divisions share fields, consider field size constraints and age group requirements.
3. **Consistent times** – If there are enough slots, assign each team the same Saturday time each week to simplify family logistics.  Otherwise, rotate times fairly across weeks.
4. **Record results** – Save the scheduled games in the database with references to the participating teams and the specific date/time.  Provide space for entering scores if desired.

## 7. Evaluation & Refinement Loop

**Status:** Evaluation pipeline design, fairness metrics catalog, and remediation workflow documented in `docs/evaluation.md`; automated evaluators now cover practice quality plus game conflict detection and per-team load metrics (`src/practiceMetrics.js`, `src/gameMetrics.js`), and the new aggregation utility `src/evaluationPipeline.js` rolls the results into an admin-ready readiness summary. Next steps include building Supabase helper views, orchestrating the evaluation worker, and surfacing dashboards in the admin UI.

1. **Implement reflection** – After generating schedules, run an evaluation module that verifies hard constraints (one practice per team, no overlapping coach commitments, field capacities) and calculates metrics such as fairness (e.g., distribution of early vs. late slots).  This mirrors the evaluator loop pattern in agentic systems, where the agent reviews its output and revises actions until constraints are satisfied【19†L83-L91】【31†L129-L133】.
2. **Automate fixes** – For each detected violation, attempt to swap assignments or shift teams to alternative slots.  Limit the number of iterations to avoid endless loops; if conflicts remain, flag them for manual resolution.
3. **Admin review** – Present the proposed schedule in the UI with flags for potential issues.  Allow the administrator to override assignments manually and re‑run the evaluation.

## 8. Output Generation & Integration

**Status:** Export architecture, TeamSnap integration considerations, and communication workflow are planned in `docs/output-generation.md`; baseline formatter `src/outputGeneration.js` (covered by `tests/outputGeneration.test.js`) now generates master and per-team CSV-friendly datasets with centralized header constants and resilient quoting (including Windows carriage returns), while follow-on tasks still cover serverless export jobs, Supabase Storage signing, and the admin interface for downloads and email drafts.

1. **Master schedule spreadsheet** – Build a routine that compiles all teams, their rosters and their practice/game assignments into a master CSV or Excel file.  Include columns such as team name, coach, players, practice day/time/location, game day/time/location and notes.
2. **Team‑specific exports** – For each team, generate a CSV or Excel file suitable for import into TeamSnap.  Include roster information and scheduled events.  Provide a ZIP download or a list of links.
3. **Email drafting tool** – Implement a feature that creates a standard email template: subject line, greeting, statement thanking the coach and a note that TeamSnap will be configured.  Provide the attachment for manual insertion or integrate with an email API to attach the file automatically after admin review.
4. **Preview and send** – In the UI, allow the admin to preview each email before sending.  Include a “Send” button that opens a `mailto:` link with the prefilled subject and body or sends via API if configured.  The final sending action should always require explicit confirmation.

## 9. Front‑End Development

**Status:** Front-end architecture outline captured in `docs/frontend-architecture.md` covering routing, screen components, state management, and Supabase integration touchpoints; next steps include scaffolding the project with a modern build tool (e.g., Vite), wiring the Supabase client, and implementing high-priority screens starting with Data Import and Team Review.

1. **User interface** – Build a responsive web app using a modern React build tool such as Vite.  Pages should include:
   - **Dashboard/home**: overview of the current season status, number of teams, schedule generation progress.
   - **Data import**: forms to upload registration CSVs and field availability; show parsing results and validation errors.
   - **Configuration**: inputs for roster size rules, practice durations, buddy rules, season start/end dates and coach preference settings.
   - **Team roster review**: list of teams with rosters; options to swap players or edit details.
   - **Schedule generation**: buttons to run practice and game scheduling, show status/spinner, and then display results.
   - **Schedule visualization**: calendars or tables showing practice and game assignments; ability to filter by team/division or field.
   - **Export & email**: interfaces to download master and team schedules and compose emails.
2. **State management** – Use React context or a state management library (e.g., Zustand or Redux) to handle global state such as loaded players, teams and schedules.
3. **Authentication** – Launch with Supabase Auth to gate admin access (email/password or magic links).  Expand roles or MFA as needed once additional collaborators join.
4. **Accessibility and UX** – Ensure the interface meets accessibility guidelines and is easy to use by a non‑technical administrator.  Provide clear error messages and confirmations for actions.

## 10. Deployment & Infrastructure

1. **Provision Supabase** – Create a Supabase project and define the database schema.  Use the free tier for the initial deployment.  Store the API keys and database URL in environment variables.
2. **Set up hosting** – Create a new project with the chosen hosting provider (Vercel or Netlify) and connect it to the Git repository. Configure environment variables for Supabase keys and any email API keys, ensuring they are prefixed with `REACT_APP_` so they are exposed to the front-end build. Use Supabase Edge Functions or the host’s serverless functions for APIs that interact with Supabase and run scheduling algorithms.
3. **Continuous integration** – Configure the hosting provider's CI/CD to deploy on each push. Use Git branches for development and staging. The free plan's build minutes should suffice for occasional deployments, but monitor usage to stay within whichever limits your provider enforces【503490883893339†L64-L87】.
4. **Static assets and storage** – For user uploads (CSV files) and exported schedules, use Supabase Storage (1 GB included on the free tier【243507034388311†L19-L47】).  Clean up old files regularly to stay within quotas.
5. **Monitor usage** – Use the hosting platform’s dashboard to track bandwidth and function invocations, and Supabase metrics to check database storage and query limits. Plan for upgrade if usage nears free-tier caps.

## 11. Testing & Quality Assurance

1. **Unit tests** – Write automated tests for each algorithmic component: CSV parsing, team assignment (ensuring roster sizes and buddy placements), scheduling functions (checking for conflicts) and export routines.  Use a test runner like Jest or Pytest.
2. **Integration tests** – Simulate a full workflow: load registration data, generate teams, schedule practices and games, produce exports.  Verify that the resulting schedules meet constraints and that the exported files contain correct information.
3. **User acceptance testing** – Invite the administrator to use the system with past season data.  Gather feedback on usability, correctness and needed adjustments.  Incorporate changes before production.
4. **Performance tests** – Measure scheduling runtime for ~1500 participants and ensure it completes in reasonable time (e.g., minutes). Validate that the application remains responsive on the free tiers of your hosting provider and Supabase.

## 12. Documentation & Training

1. **System documentation** – Write internal documentation covering the architecture, database schema, algorithms, configuration parameters and deployment steps.  Include diagrams illustrating agent interactions and data flows.
2. **User guide** – Produce a step‑by‑step guide for the league administrator: how to prepare and upload registration files, adjust settings, review and edit teams, generate schedules, export data and send communications.
3. **On‑boarding** – Provide training sessions or videos to ensure the administrator is comfortable using the application and can troubleshoot common issues.

## 13. Maintenance & Support

1. **Logging & error handling** – Implement structured logging for serverless functions and front-end errors. Store logs in Supabase or use the hosting provider’s built-in logs. Handle exceptions gracefully and surface helpful messages to the user.
2. **Season rollover** – At the end of each season, archive schedules and rosters.  Provide a feature to reset the system for a new season without losing configuration settings.  Consider migrating old data to cold storage or exporting it for historical records.
3. **Handling changes** – Implement tools to re‑schedule practices or games when fields become unavailable or weather causes cancellations.  Provide options to regenerate schedules for affected teams and notify coaches.
4. **Updates and dependencies** – Keep dependencies up to date (Vite, Supabase client, etc.) and monitor security advisories. Since hosting providers such as Netlify or Vercel and Supabase update their platforms, regularly check for breaking changes or updated free-tier policies.
5. **Scalability planning** – If the league grows or usage exceeds free tiers, be prepared to upgrade your hosting and Supabase plans. Review the paid tiers from providers like Netlify and Vercel alongside Supabase Pro to understand bandwidth, function, and database increases before committing budget【426420472487956†L152-L174】【243507034388311†L65-L91】.

## 14. Future Enhancements

1. **Advanced AI scheduling** – Experiment with integrating large language models or optimization libraries to handle complex scheduling scenarios and automatically adapt to changes (e.g., new fields, weather delays).  Research indicates that agentic frameworks can self‑evaluate and refine their output【19†L83-L91】【31†L125-L133】, which could improve fairness and reduce manual intervention.
2. **Full TeamSnap integration** – Investigate TeamSnap’s API for creating teams and events programmatically.  Automate the export and import cycle to eliminate manual steps.
3. **Mobile coach portal** – Build a simple mobile‑friendly interface for coaches to view their rosters and schedules, submit availability changes and receive notifications.
4. **Parent/player communication** – Integrate messaging tools or calendar subscriptions (e.g., iCal feeds) so that parents can subscribe to their team’s schedule and receive updates automatically.
5. **Analytics & reporting** – Add dashboards to analyze resource utilization (field usage, practice attendance), team parity (win/loss trends), and scheduling fairness.  Use these insights to tune algorithms in future seasons.
