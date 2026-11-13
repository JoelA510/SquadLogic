Feature: Importing a practice schedule that already exists (schedule expansion, PR 11)
  As a League Administrator
  I want to bring in a practice schedule I already made, map its names to my records and see what it will do before it does it
  So that my practices arrive as they are, conflicts and all, saved and locked, and I can take the import back

  The file is the shipped placeholder fixture (fixtures/practice-schedule-2026/practice-schedule.csv): several hundred
  timed cells over the weekdays, with open slots, a held cell, double-placed teams, a team on both halves and two slots
  that claim one ground. The league is the fixture's own (its divisions with their practice settings, teams, coaches,
  locations, fields and halves), seeded as records, with no saved practice; some of the file's names are spelled as
  the fixture's alias file spells them, so they map only once the admin reads that file and takes its proposals.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a league with the practice fixture's divisions, teams, coaches and grounds and no practices

  Scenario: The fixture is imported with its alias file, its conflicts flagged, confirmed, and rolled back
    Given I have navigated to the Data Import page
    When I choose the practices import and upload the fixture's practice schedule
    Then the practice file is read whole and its dropped column is named
    When I read the fixture's alias file and use every proposal nothing disagrees with
    Then no name of the practice file is left undecided
    When I preview the practice import
    Then the preview refuses the slot that overlaps another and flags the double-placed teams
    And the preview lists the teams short of their division's practices and says what it did not check
    And nothing is imported until I tick the list of what the practice import will create
    And axe finds no serious or critical violations on "/import" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/import" in the "dark" theme
    When I tick the list and confirm the practice import
    Then the practice import is applied and says its practices are saved and locked
    When I roll back this practice import
    Then the practice import is rolled back
