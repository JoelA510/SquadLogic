# Requirements Analysis & Planning

## Stakeholder Interviews and Scope Definition
- **Primary contact**: League administrator (single scheduler for ~1500 participants).
- **Divisions**: Confirm list of age groups/divisions participating this season and whether any are co-ed.
- **Roster sizing**: Capture per-division roster formulas (e.g., 7v7 → max 12 players) and any overrides for smaller/larger groups.
- **Buddy policy**: Only mutual buddy requests honored; clarify how to surface one-sided requests for review.
- **Practice cadence**: One practice per team each week, held Monday–Thursday evenings.
- **Game cadence**: Saturday games across the season (August–October season window).
- **Coach preferences**: Document availability constraints and whether coaches manage multiple teams.
- **Season adjustments**: Note when practice durations shorten (e.g., daylight change) and any blackout dates.

### Interview Agenda & Questionnaire (Finalized)
Use this script when meeting the administrator so discovery conversations remain consistent and the responses are captured in the product backlog. Capture answers in meeting notes and transpose key decisions into the requirements tables. Record responses in the shared "Season Intake" form (Google Sheet tab per division) immediately after the call to avoid transcription drift.

1. **Season overview**
   - Which divisions are confirmed for the upcoming season?
   - How many teams per division do you anticipate based on prior years?
   - Are there age groups with shared fields or unique rule variations (e.g., build-out lines)?
2. **Registration data**
   - Which GotSport export fields are relied on today for scheduling?
   - Are there custom registration questions we must preserve in the data model?
   - How frequently do late registrations or drops occur after the initial import?
3. **Buddy & coach policies**
   - How do you currently validate that buddy requests are mutual?
   - Are there exceptions for sibling groups or carpool requests beyond the one-buddy limit?
   - What communication should go to families when a buddy request cannot be honored?
4. **Field availability**
   - Can you supply the master field spreadsheet and note which slots are flexible vs. locked?
   - Are there lighting constraints or municipal curfews that change mid-season?
   - Do certain divisions have priority for specific fields/times?
5. **Schedule approvals & adjustments**
   - Who signs off on practice and game schedules before they are published?
   - What is the current process for handling weather cancellations or field closures?
   - How quickly do you need to regenerate schedules after an unexpected change?
6. **Success metrics & reporting**
   - Which fairness or quality metrics matter most (e.g., even distribution of late slots)?
   - What exports or dashboards are required for board meetings or coach briefings?
   - How are TeamSnap imports currently prepared, and what pain points exist?
7. **Operational considerations**
   - Are there other stakeholders (registrar, board members) who need read-only access?
   - Do you foresee the need for multilingual communications or accessibility accommodations?
   - What is the preferred cadence for reviewing progress (weekly, every two weeks)?

### Interview Logistics & Follow-Up Checklist
- **Pre-meeting prep**: Distribute the agenda and link to the "Season Intake" form at least 24 hours in advance so the administrator can gather field and roster artifacts.
- **Recording**: Confirm whether the administrator approves a recording; if so, store it in the shared drive linked from the project hub with restricted access.
- **Live capture**: Assign a note-taker (if available) to log answers in the form while the interviewer facilitates conversation.
- **Post-meeting summary**: Within 24 hours, circulate a recap email that lists confirmed constraints, open questions, and next steps. File the summary in the `/docs/meeting-notes` folder for traceability.
- **Backlog updates**: Convert confirmed requirements and new follow-up items into GitHub issues tagged `requirements` so they can be prioritized in the next sprint planning session.

## Documented Constraints
### Hard Constraints
1. One practice per team per week within available Monday–Thursday slots.
2. Games scheduled on Saturdays only, avoiding field and coach conflicts.
3. Respect field capacities, sub-field splits, and daylight-driven slot durations.
4. Mutual buddy pairs must be placed on the same team; one buddy per player maximum.
5. Honor confirmed coach assignments with their associated players.

### Soft Preferences
1. Balanced team sizes and skill distributions across each division.
2. Even distribution of practice times (early vs. late) per division.
3. Prioritize coach availability preferences when assigning practice slots.
4. Maintain consistent Saturday game times for each team when feasible.

## Success Criteria
- **Scheduling validity**: No overlapping assignments for fields or coaches; all teams receive required practices and games.
- **Fairness metrics**: Track distribution of time slots and field usage to ensure equity.
- **Data outputs**: Ability to generate a master schedule spreadsheet plus per-team exports for TeamSnap import.
- **Operational efficiency**: Season schedule generation should be largely automated with minimal manual fixes.
- **Adjustment workflow**: Capability to rerun or tweak schedules when weather or field availability changes.

## Iteration Plan
1. **Phase 0 – Data readiness**: Import sample registration and field availability data; validate buddy pair identification.
2. **Phase 1 – Team formation**: Implement automated team generation, then expose manual adjustment tools.
3. **Phase 2 – Practice scheduling**: Develop assignment engine respecting constraints and evaluate fairness metrics.
4. **Phase 3 – Game scheduling**: Produce full-season Saturday game schedule with conflict checks.
5. **Phase 4 – Evaluation & exports**: Build reflection loop, reporting dashboards, and export tooling.
6. **Review cadence**: Hold bi-weekly check-ins with the administrator for feedback and acceptance testing.
