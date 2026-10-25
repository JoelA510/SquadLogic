Feature: Pillar 1 - The Engine (Scheduling & Team Generation)
  As a league coordinator
  I want the engines to build teams, practices and games from what I give them
  So that I can minimize manual effort and ensure fair allocations

  Each scenario presses the page's own engine control on seeded inputs and reads
  what the page then shows; no step writes an engine's result (plan item M4.6).
  Team generation and game scheduling run in the browser. Practice scheduling
  runs in the auto-scheduler Edge Function, which mock mode cannot reach, so its
  route is answered by the function's own solver, given the page's request body
  unchanged: the solver's decisions are real, but the function's HTTP and
  database wrapper (auth, the season lock read, coach preferences, daylight,
  persistence) is not exercised here. The real-backend project (plan item M4.1)
  covers that.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: Automated Team Generation
    Given 100 players are imported into the "U12 Boys" program
    When I ask the Teams page for 5 teams of at most 10 players
    And I press "Generate Teams" on the Teams page
    Then the engine forms 10 teams, the fewest that hold 100 players at 10 each
    And all 100 players are assigned and none is left for manual review
    And the review says every team of "U12 Boys" is within the roster limits

  # Phase B4: before generation, the overview gives each program the recommended count and a
  # status from the settings panel's advice, and each program is a button in its row. The
  # overview is scanned with axe here, where it renders (the accessibility feature's "/teams"
  # row scans the seeded run's view).
  Scenario: The program overview recommends a count and warns, and is operable from the keyboard
    Given 100 players are imported into the "U12 Boys" program and 24 into the "U10 Girls" program
    When I ask the Teams page for 5 teams of at most 10 players
    Then the program overview recommends the fewest teams that hold 100 players at 10 each for "U12 Boys"
    And the program overview's status for "U12 Boys" is "Override not used"
    And "U10 Girls" is chosen in the program overview with the Enter key
    And the program overview's status for "U12 Boys" is "Override not used"
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme

  Scenario: Practice Scheduling
    Given these teams and coaches in "U10 Boys":
      | team  | coach        |
      | Hawks | Coach Rivera |
      | Owls  | Coach Rivera |
      | Bears | Coach Chen   |
      | Foxes | Coach Okafor |
    And two practice slots on Thursday at 17:00 with room for one team each
    And a Tuesday practice slot that a locked practice already fills
    When I run the auto-scheduler on the Practice Scheduling page
    Then the auto-scheduler places 2 teams and leaves 2 unplaced
    And "Hawks" and "Owls" are not both placed, since they share a coach
    And nothing new is placed in the full Tuesday slot

  Scenario: A saved practice that has ended no longer holds its slot
    Given these teams and coaches in "U10 Boys":
      | team  | coach        |
      | Hawks | Coach Rivera |
    And a Tuesday practice slot whose saved practice ended last week
    When I run the auto-scheduler on the Practice Scheduling page
    Then the auto-scheduler places 1 teams and leaves 0 unplaced
    And the page says 1 saved practice has ended and its slot was offered

  Scenario: Game Schedule Generation
    Given a club whose organization id is a UUID, as in production
    And these teams and coaches in "U10 Boys":
      | team   | coach       |
      | Lions  | Coach Patel |
      | Wolves | Coach Patel |
      | Comets | Coach Novak |
      | Bulls  | Coach Diaz  |
    And the club's game slots are:
      | slot     | field       | week | date       | start | end   |
      | w1-north | North Field | 1    | 2026-04-04 | 16:00 | 17:00 |
      | w1-south | South Field | 1    | 2026-04-04 | 16:00 | 17:00 |
      | w2-north | North Field | 2    | 2026-04-11 | 16:00 | 17:00 |
      | w3-south | South Field | 3    | 2026-04-18 | 16:00 | 17:00 |
    When I press "Generate Schedule" on the Game Scheduling page
    Then 3 of the 6 round-robin matchups are scheduled
    And the "Lions" vs "Wolves" matchup is refused because one coach coaches both teams
    And a week 1 matchup with "Lions" or "Wolves" is refused for a coach scheduling conflict
    And a week 2 matchup is refused because its one slot is already taken

  Scenario: Game Schedule Generation on the mock seed's own organization
    # The mock seed's organization and season ids are UUIDs (MOCK_ORG_ID,
    # MOCK_SEASON_ID), as core's slot schema requires; with non-UUID ids every
    # seeded game slot was refused and this run never succeeded.
    When I press "Generate Schedule" on the Game Scheduling page
    Then the game "Team A" vs "Team B" is staged for review on "Field 1"
    And 1 of the 1 round-robin matchups are scheduled

  # TG-3 (DST boundary), the scheduling page. The page and the solver place a
  # weekly slot by its FIRST occurrence only, so what this covers is a slot
  # whose first occurrence falls in the gap: it is not guessed at, the page
  # names it and its cause as TIME TBD, and the slots around it are still
  # scheduled. A series that starts earlier and crosses the gap is NOT judged
  # per date here (see the remediation plan, "Discovered during execution",
  # B5): the calendar feed's per-date handling is held by
  # tests/calendarFeed.test.js. 2026-03-08 is the spring-forward Sunday in the
  # seeded season's zone (America/Los_Angeles): 02:00 becomes 03:00.
  Scenario: A practice slot that begins in the spring-forward gap is shown as TIME TBD, not scheduled
    Given these teams and coaches in "U10 Boys":
      | team  | coach        |
      | Hawks | Coach Rivera |
    And a Thursday practice slot at 17:00 with room for one team
    And a Sunday practice slot at 02:30 on the night the clocks go forward
    When I run the auto-scheduler on the Practice Scheduling page
    Then the page shows 1 practice slot as TIME TBD because daylight saving skips its hour
    And the TIME TBD slot is named as 2026-03-08 at 02:30
    And the auto-scheduler places 1 teams and leaves 0 unplaced
    And nothing is placed on the Sunday that has no 02:30
