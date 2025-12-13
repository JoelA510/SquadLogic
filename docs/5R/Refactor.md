# **SquadLogic Schema Consolidation and Enhancements**

## **Branch Consolidation Strategy**

We will focus all development on a single main branch moving forward. Existing side branches can be ignored, as their changes have now been merged into the unified schema and codebase. This simplifies our workflow by eliminating divergence:

* All recent enhancements (Phases 2 through 10\) are included in the main branch’s schema and code.  
* We won't maintain separate branches for those phases, avoiding confusion or duplicate work.  
* Future updates will be applied directly to the main branch to keep it as the source of truth.

By consolidating into one branch, we ensure that everyone works off the same up-to-date schema and features, without worrying about merging from older branches.

## **Consolidated Supabase Schema (Phases 1–10)**

The entire database schema for SquadLogic has been unified into a single SQL migration that includes the core schema and all enhancements from Phase 2 through Phase 10\. This Consolidated Schema script ensures a clean setup for any new environment and reflects the latest design. Key aspects of the consolidated schema:

* Enum Types: Custom Postgres types for day of week, source of assignment, and gender policy are created at the top (e.g. day\_of\_week for Monday–Sunday, source\_enum for auto/manual assignments, gender\_policy\_enum for coed/girls/boys) to standardize these fields across tables.  
* Core Tables: Fundamental entities are defined first:  
  * season\_settings – holds season metadata (label, year, start/end dates) and JSONB config fields for roster formulas, daylight savings adjustments, and export settings  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L35-L44)  
  * . Each season acts as a container for a set of divisions.  
  * divisions – subdivisions of a season (by age group or level) with fields like name, gender\_policy, play\_format, and max\_roster\_size  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L56-L64)  
  * . (In Phase 8, max\_roster\_size was updated from a smallint to a full integer to allow larger team sizes as needed.)  
  * players – youth player registrations, including names, birthdate, grade, guardian contacts, buddy codes, skill tier, volunteer status, etc  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L70-L79)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L82-L86)  
  * . Phase 10 enhancements added willing\_to\_coach (boolean) and buddy\_request (text) to capture additional info from player sign-ups. We also expanded players with fields for medical info, contact info, emergency contacts, registration history, status, and geolocation (lat, lng, timezone) to support future features (travel distance calculations, time zone-aware scheduling).  
  * coaches – coach or volunteer records with contact info. This includes a link to the auth.users table (for login), an optional reference to a players entry (if a coach has a child in the league), email/phone, and scheduling preferences  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L93-L101)  
  * . We consolidated certifications into a JSONB array (Phase 2), instead of a plain text field, so multiple certifications can be tracked in one column. Coaches also have location coordinates and timezone fields similar to players for potential mapping features.  
  * locations & fields – represent physical venues. A location is a park or facility (with a name, address, and whether it has lights for night play)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L111-L119)  
  * . Each location can have multiple fields (actual playable surfaces)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L121-L129)  
  * . Fields track surface type, whether they support splitting into halves, and (from Phase 6\) additional attributes: a maximum age group (text) for which the field is suitable, a priority ranking for scheduling, and an active flag to mark if the field is currently in use. Fields can also have field\_subunits (like half-fields or courts) for scheduling smaller units  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L132-L140)  
  * .  
* Scheduling Slots: Structures to define when practices and games can occur:  
  * practice\_slots – recurring weekly time slots for practices  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L141-L149)  
  * . Each slot ties to a field (or optional subunit), a day\_of\_week (Mon–Thu for practices), start/end times, and a date range (valid\_from to valid\_until) to indicate which portion of the season it covers. We enforce that end\_time is after start\_time  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L150-L153)  
  * . Unique indexes ensure no duplicate slot timing on the same field or subunit  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L156-L164)  
  * . (Phase 7 introduced an optional label for slots to tag special cases or notes.)  
  * game\_slots – specific dates and times for games  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L167-L175)  
  * . Each game slot is a one-time slot on a given date (as opposed to weekly recurring). It references a field and optionally a division (if the slot is designated for a certain age group). We allow division\_id to be null for general slots, but if set, the slot is reserved for that division’s games. A uniqueness constraint prevents duplicate games at the same field, date, and time  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L176-L179)  
  * .  
* Teams and Assignments:  
  * teams – team entries linking a division with coaches  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L181-L189)  
  * . Each team has a head coach (coach\_id) and can list assistant coach IDs in an array. Phase 9 added support for multiple assistants via the assistant\_coach\_ids UUID array. We ensure team names are unique within a division  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L182-L191)  
  * .  
  * team\_players – an association table assigning players to teams  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L194-L201)  
  * . It records each player's role on the team (default "player") and the source of assignment (auto-assigned by the algorithm or manual override). The composite primary key prevents a player from being on a team twice.  
  * practice\_assignments – records which practice\_slot a team has throughout the season  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L203-L211)  
  * . It includes an effective date range (as a Postgres daterange) to allow scheduling changes mid-season (e.g., if practice nights change after daylight savings). A uniqueness constraint ensures a team isn't assigned to the same slot twice in overlapping date ranges  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L208-L213)  
  * .  
  * games – actual scheduled games linking teams to game\_slots  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L215-L224)  
  * . Each game uses one game\_slot and has a home and away team. A constraint prevents a team from playing itself  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L219-L225)  
  * . (The week\_index and score fields allow tracking game results and ordering.)  
* Validation Triggers: To maintain data consistency, two trigger functions are defined and applied:  
  * ensure\_assistant\_coach\_ids\_valid() – runs on team inserts/updates to validate the assistant\_coach\_ids array  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L228-L237)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L254-L263)  
  * . It checks that there are no nulls or duplicates, that the head coach isn’t also listed as an assistant, and that all referenced coaches actually exist  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L240-L249)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L258-L266)  
  * . If any check fails, the insert/update is aborted with a clear error message.  
  * ensure\_game\_team\_consistency() – runs on game inserts/updates to enforce division consistency  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L282-L291)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L294-L303)  
  * . It ensures the two teams belong to the same division and that the chosen game\_slot is either non-specific or matches that division  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L295-L303)  
  * . This prevents scheduling a game with teams from different divisions or placing a division’s game into a slot reserved for another division.  
  * These triggers are attached via CREATE TRIGGER statements to the teams and games tables respectively  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L316-L325)  
  * , so they fire automatically on data changes.  
* Import & Buddy System Tables: To support data import and buddy requests:  
  * import\_jobs – tracks bulk import tasks (like importing registrations or field data from CSV)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L330-L339)  
  * . It logs the file source, status (queued, processing, completed, etc.), timestamps, row counts, and any errors or warnings encountered  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L332-L341)  
  * .  
  * staging\_players – holds raw imported player data temporarily during import processing  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L345-L353)  
  * . Each row contains the raw JSON payload from the import file and fields for normalized data and any validation errors. This allows us to review or fix issues before moving data into the main players table.  
  * player\_buddies – stores buddy pairings from registration  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L356-L364)  
  * . If two players request each other as buddies, is\_mutual can be marked true. This table references two player IDs and links to the import job that sourced the buddy info. A constraint ensures a player cannot be buddies with themselves  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L360-L364)  
  * .  
* Scheduler and Evaluation:  
  * scheduler\_runs – records each run of the scheduling algorithm  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L366-L374)  
  * . It logs the type of run (team assignment, practice scheduling, or game scheduling), the input parameters and output results (stored as JSONB), metrics, status, and timestamps  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L368-L377)  
  * . This provides a history of automated scheduling attempts.  
  * evaluation\_runs – if we run automated evaluations of a schedule, this table logs those checks  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L381-L390)  
  * . It can link to a specific scheduler\_run or stand alone as a composite evaluation. It stores a summary of findings (severity of issues), a snapshot of input data, and any auto-fix actions taken  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L382-L391)  
  * .  
  * evaluation\_findings / metrics / events – supporting tables for schedule evaluations  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L401-L409)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L412-L420)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L422-L428)  
  * . For each evaluation\_run, they store detailed findings (errors/warnings with descriptions and involved entities), quantitative metrics (with thresholds, e.g. average team strength), and any events like automatic fixes or manual overrides recorded during evaluation.  
  * schedule\_evaluations – a simplified summary table for schedule health (Phase 9\)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L821-L829)  
  * . It stores an overall status (ok, attention-needed, or action-required) for a given practice schedule, game schedule, or combined schedule run. This table is designed for quick checks (e.g., a coach or admin can see if a schedule has issues) without diving into full evaluation details. It includes a JSONB summary, a list of issues, and a details blob for deep info, along with who created the evaluation  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L821-L829)  
  * .  
* Audit & Logging:  
  * export\_jobs – tracks export tasks (like generating CSV/PDF reports of team rosters or schedules)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L430-L439)  
  * . It stores job type (master schedule or team-specific exports), status, payload (parameters used), output storage path, and error details if any  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L432-L440)  
  * .  
  * email\_log – records actions related to notification emails  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L446-L453)  
  * . For instance, if an export resulted in a draft email to coaches, this log captures when an email was drafted, copied, or sent, and to whom, with any metadata. It helps us audit communications sent from the system.

All tables have created\_at timestamps (and updated\_at where relevant) that default to the current UTC time on insertion

[GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L54-L62)

. We created a generic trigger function trigger\_set\_timestamp() to automatically update updated\_at on each modification

[GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L24-L32)

, and attached this trigger to all tables that have an updated\_at field (e.g. most core tables and scheduler/export logs). This ensures we always know when a record was last changed. Finally, the consolidated schema applies Row-Level Security (RLS) on all tables and defines a comprehensive set of RLS policies:

* Admin Policies: For every table, an "Admins can do everything" policy grants full SELECT/INSERT/UPDATE/DELETE access to any user with the JWT role of admin  
* [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L544-L552)  
* [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L560-L568)  
* . This uses a check on the token’s app\_metadata.role field being 'admin' to allow superuser access to all data.  
* Coach Policies: Coaches have restricted access:  
  * Coaches can view players on their own teams, but only certain fields (likely via a future view or by only returning names, not sensitive info). The policy "Coaches can view roster names (masked)" allows a coach (role \= coach) to select from players only if that player is on one of the coach’s teams  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L570-L578)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L579-L582)  
  * . This leverages a coach\_team\_map view that unions head coach and assistant coach assignments to map coach user IDs to team IDs  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L502-L510)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L511-L519)  
  * .  
  * Coaches can view and update their own coach profile record. Policies on the coaches table allow a coach to SELECT or UPDATE where coaches.user\_id \= auth.uid() (i.e. the coach can only see or change their own entry)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L592-L600)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L601-L609)  
  * .  
  * Coaches can view their teams in the teams table. A policy permits select on teams if the coach is assigned as head or assistant for that team  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L570-L578)  
  *  (via the same coach\_team\_map relationship).  
* Scheduler & Import Policies:  
  * The scheduler\_runs table has a permissive policy allowing any authenticated user to insert/select (this is to enable triggering schedule generation from the frontend)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L517-L525)  
  * . This might be revisited for fine-tuning, but currently any logged-in user can initiate a schedule run (the actual heavy lifting is done in backend functions with proper checks).  
  * The imports table (which logs user-uploaded data files, not covered in detail above) has policies to allow users to insert and view their own imports and no one else’s. It checks that imports.user\_id \= auth.uid() for select/delete operations, ensuring isolation of uploaded data.  
* Service Role: Certain system operations (like writing schedule evaluation results or storage object access) use the Supabase service role (an internal high-privilege role). For example, the schedule\_evaluations table grants full access to service\_role with a policy that uses (true) as condition (since this role bypasses RLS by design)  
* [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L842-L850)  
* . This allows server-side routines to populate evaluations. Meanwhile, regular authenticated users get read-only access to schedule\_evaluations so they can see the status of schedules  
* [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L848-L855)  
* .

All these schema definitions and policies are wrapped in a single transaction (using BEGIN; ... COMMIT;) to ensure the migration either fully applies or rolls back on error, keeping the database in a consistent state. The Consolidated Schema script effectively replaces the numerous phase-by-phase migrations with one authoritative schema, making new deployments much simpler.

## **Multi-Organization Support Considerations**

SquadLogic is designed to be used by multiple youth sports organizations (e.g. different clubs or leagues), but it is operated by a single organization (our company). This has some implications on multi-tenancy and how data is separated or shared:

* Single Deployment, Multiple Leagues: We intend to host one instance of the application that serves many organizations. All data will reside in one database (one Supabase project), as opposed to deploying separate instances per customer. This is more efficient to maintain but requires careful data isolation.  
* No Explicit Organization Table (Yet): The current schema does not have a top-level organization or tenant table linking to all data. In practice, this means different leagues’ data could sit side by side in these tables. For example, season\_settings might contain seasons for “Spring 2026 – League A” and “Spring 2026 – League B” as separate rows. There isn’t a foreign key that groups those under an organization. We rely on logical separation by Season or Division names, and on user roles, to manage access.  
* Operational Model: Because one entity (us) runs the system, we are taking a somewhat centralized approach initially:  
  * Admin Role: The admin users are presumably employees of the SquadLogic operator. An admin can see and manage *all* data (all organizations’ seasons, players, teams, etc.). This is acceptable since those admins are internal. We are not yet giving each external organization an “admin” account within the app.  
  * Coach Role: External users (like coaches or volunteers from each league) will typically have the role coach and be tied to specific teams. The RLS policies for coaches ensure they can only see information for their own team(s)  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L570-L578)  
  * . This naturally prevents a coach from one organization from viewing data in another, because they have no team assignments there. In other words, coaches only see players on their roster, which inherently partitions data by team/division/season. This provides a layer of tenant isolation without having an explicit org ID.  
* Future Multi-Tenant Enhancements: As we onboard more organizations, we might introduce a formal organization identifier in the data model to strengthen multi-tenant separation. A common best practice is to add a tenant\_id (or organization\_id) column to key tables (such as season\_settings, teams, etc.) and include that in RLS policies  
* [antstack.com](https://www.antstack.com/blog/multi-tenant-applications-with-rls-on-supabase-postgress/#:~:text=The%20first%20step%20in%20setting,the%20order%20belongs%20to)  
* . For example:  
  * We could have an organizations table (listing each client league) and add organization\_id as a foreign key in season\_settings (and cascade it to divisions, players, etc., via the season link).  
  * RLS policies for coaches and other roles could then also require players.organization\_id \= auth.jwt().organization\_id (assuming the JWT carries the user’s org). This would ensure even an admin role scoped to an org would only see their org’s data.  
  * *However,* since for now *our* admins manage everything, and coaches are naturally limited to their teams, the system is effectively safe for multiple org usage. We just need to be cautious if we ever introduce organization-specific admin/logins.  
* Data Segmentation by Season: Another way we are managing multiple organizations’ data is through the season abstraction. Each league runs its own seasons, which don’t overlap in the season\_settings table. By naming seasons uniquely (e.g. including the org name or an org code in season\_label), we can distinctly identify each organization’s data. This is not a security measure per se, but it helps operationally (so we don’t mix up teams from Spring 2025 – Soccer Club A with Spring 2025 – Soccer Club B).  
* Shared Resources: All organizations share the same schema structure and the application logic. If we update a feature (like the scheduling algorithm or a report format), it benefits all tenants. But it also means changes must be carefully considered across all orgs. Our RLS and role system will be the primary means to ensure one org’s users don’t inadvertently access another’s data. As the platform grows, introducing a formal tenant ID will become important for clarity and security, aligning with common multi-tenant practices (introducing a tenant column and using it in all RLS checks).

In summary, multiple leagues can use SquadLogic concurrently on the single deployed system. Right now the separation is achieved through user roles and team assignments. Since one company owns the data and external users have limited scopes, this is manageable. Going forward, we will likely implement a more explicit multi-tenant model to scale to many organizations safely (for example, adding an organization\_id field to relevant tables and including it in JWT claims and RLS policies for strict data partitioning).

## **Timezone Configuration and School-Hours Practice Times**

One new requirement is to make the system timezone-aware and enforce “school hours” constraints for scheduling practices:

* Timezone Selection: We need to allow each organization (or each season/league) to select a timezone. This is important because leagues may operate in different regions, and all scheduling (practice and game times) should be relative to the local time of that league. Currently, all timestamps in the database are stored in UTC and we haven’t explicitly recorded a league’s timezone (players and coaches have individual timezone fields, but those are optional and not yet used in scheduling). We plan to:  
  * Add a Timezone Field: Introduce a timezone setting at the season or organization level. For example, adding a column season\_settings.timezone TEXT to store the IANA timezone identifier (e.g. "America/Los\_Angeles"). This way, a season’s start/end dates and all related scheduling can be interpreted in that zone.  
  * Use UTC Internally: Continue storing timestamps and times in UTC (as we do with timestamptz fields) but convert to the chosen timezone for any user-facing outputs. This ensures consistency in storage while displaying context-correct local times. When generating practice or game schedules, the algorithm can consider the offset of the timezone to enforce local hour constraints (especially important if the server is running in a different zone).  
  * JWT Claim or Session Var: We might include the user’s organization or timezone in the auth token or use a session variable so that database functions (like RLS policies or stored procedures) know which timezone to use when necessary.  
* School Hours Constraint: By default, practices should not start before 4:00 PM local time on school days. This invariant reflects that players are in school during weekdays:  
  * The consolidated schema’s practice slot definition already restricts days to Monday–Thursday for practices  
  * [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L141-L148)  
  *  (assuming games happen on weekends). Now we will enforce start times. We propose adding a configurable “earliest practice start” setting. This could be a column like season\_settings.school\_day\_end TIME DEFAULT '16:00' (4 PM) or as part of a JSONB config. Since this might vary (some organizations might say 5 PM or 3:30 PM), making it configurable per season is ideal.  
  * Enforcement: The scheduling logic (in our backend code that generates practice assignments) will use this setting to filter out any practice\_slots that start earlier than the allowed time. We might also enforce it at data entry:  
    * If an admin tries to create a practice\_slot with start\_time earlier than the configured school\_day\_end, we can either prevent it or flag a warning. A CHECK constraint in SQL could enforce start\_time \>= school\_day\_end for weekday slots, but since this is configurable per season, implementing it purely in SQL is tricky (because a check constraint cannot easily compare two columns across tables). Instead, we’ll likely enforce in application logic or via a trigger function that looks up the season’s rule.  
  * By default, if a season doesn’t customize it, we’ll assume 4:00 PM as the safe earliest practice time on Mon–Thu. This default aligns with typical school schedules. Each league can adjust this if, for example, they have access to fields earlier or later.  
  * Field Availability: Our practice\_slots already reflect field availability. Some fields might only be available later in the evening due to permits or shared use. The “school hours” rule will work in conjunction with that. Essentially:  
    * The system will take the intersection of “field available times” and “after school hours” to choose valid practice slots.  
    * For example, if a field has a slot from 3–4 PM but school\_hours is 4 PM, that slot would be disqualified for use (or truncated to start at 4, though likely we just won’t use it).  
    * Conversely, if lights are available and a field slot goes late (say 7–9 PM), that’s fine as long as it’s after 4 PM.  
* User Interface: We will add options in the admin UI for selecting the timezone (probably via a dropdown of common timezones or via location detection) and for setting the “Earliest Practice Start” time. These settings would tie into the season\_settings for that league.  
  * When an admin creates a new season, they would specify the timezone (default could be our org’s timezone, but changeable) and the default school day cutoff (default 4:00 PM, but they can override if, say, their schools get out later).  
  * All displayed times in the application for that season’s schedule will be shown in the chosen timezone (e.g., if a coach in another timezone views it, we might still show the league’s local time to avoid confusion).  
* Daylight Savings & Adjustments: We already have a daylight\_adjustments JSONB in season\_settings  
* [GitHub](https://github.com/JoelA510/SquadLogic/blob/54e5d61519cac08fc0d00f37da33ae32673c8b20/supabase/migrations/20251208000000_consolidated_schema.sql#L41-L43)  
* . This is likely used to handle shifts in schedule after daylight savings changes (for example, moving practice earlier or to fields with lights when days get shorter). With an explicit timezone, we can detect the DST change dates for that locale and potentially automate some adjustments:  
  * For instance, if the league is in "America/New\_York", we know DST typically ends in early November. We could use daylight\_adjustments to pre-store rules like "after DST ends, any practice slot at 6 PM moves to 5 PM or moves indoor," etc.  
  * Making the system timezone-aware will allow these adjustments to be calculated correctly (since UTC times will shift by an hour relative to local time on those dates).  
* Testing and Verification: After implementing timezone and hour constraints, we will thoroughly test:  
  * Creating practice slots around the boundary (e.g. at 3:30 PM vs 4:00 PM) to ensure the system correctly includes/excludes them.  
  * Switching the timezone setting to see that all schedule outputs convert appropriately (for example, a 5 PM UTC slot should show as 12 PM Eastern if timezone is America/New\_York, which would clearly violate the rule – so it should have been stored differently or not allowed in the first place).  
  * Ensuring that coaches in different timezones viewing the schedule don’t get misled – likely we will normalize that all times are shown in the league’s local time consistently.

In summary, we will make timezone a configurable attribute for each league/season and enforce a default no-practice-before-4PM rule on weekdays, unless overridden. These invariants will be built into the scheduling algorithm and possibly reinforced with database constraints or triggers for data integrity. This approach respects school hours, ensuring kids are not scheduled for practices during typical school times, and it allows leagues in different regions to use SquadLogic with correct local timings.

## **Next Steps and Implementation Plan**

With the above clarifications and decisions, our immediate next steps are clear:

1. Apply the Consolidated Migration: **DONE**. The consolidated schema has been applied and verified.
2. Remove Redundant Migrations/Docs: **DONE**. Old migrations are archived/superseded.
3. Implement Timezone & School Hour Settings: **IN PROGRESS**.
   * Add a timezone column to season\_settings: **DONE**.
   * Update the front-end forms: **DONE**. 
   * Update the scheduling logic: **DONE** (Practice scheduler respects school hours).
   * Ensure all times are converted to UTC/Local: **ONGOING** (Formatters standardized).
4. Multi-Org Data Partitioning (Long Term): Pending.
5. Testing & Feedback: Pending.

Following this plan will ensure SquadLogic’s schema is up-to-date and robust, and the platform is ready to serve multiple organizations with proper constraints and configurations. We have merged all development into a unified path, captured all enhancements in the schema, and set the stage for configurable timezone support – all steps that improve the system’s clarity and usability for us and our users.