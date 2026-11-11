Feature: Importing a game schedule that already exists (schedule expansion, PR 6)
  As a League Administrator
  I want to bring in a schedule I already made, map its names to my records and see what it will do before it does it
  So that my games arrive as they are, conflicts and all, and I can take the import back

  The file is the shipped placeholder fixture (fixtures/schedule-2026/schedule.csv): several hundred games over nine
  Saturdays, with outside clubs as visitors, planted clashes and one game with no time. The league is the fixture's
  own (its teams, venues and fields), seeded as records; the season's dates are the fixture's. Nothing of the file is
  taken on trust: the outside clubs are not teams until the admin says they are outside clubs, the preview is the
  import with its writes off, and the clashes are imported and flagged, never refused.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a league with the fixture's divisions, teams, venues and fields and no games

  Scenario: The fixture is imported, its outside clubs mapped, its conflicts flagged, its games Published, and rolled back
    Given I have navigated to the Data Import page
    When I choose the games import and upload the fixture's schedule
    Then the file is read and its outside clubs are not decided yet
    And a team the league has opens on "use existing"
    When I mark every undecided team an outside club
    And I preview the schedule import
    Then the preview adds the fixture's games and lists the outside clubs it will create
    And the preview flags a field with two games at once and says what it did not check
    And nothing is imported until I tick the list of what will be created
    And axe finds no serious or critical violations on "/import" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/import" in the "dark" theme
    When I tick the list and confirm the schedule import
    Then the schedule import is applied and its games are Published
    When I open the Games page after the import
    Then the Games page counts every imported game as Published
    And the Games page lists the game with no time as TIME TBD on its date
    When I return to the Data Import page and roll back the last import
    Then the import is rolled back and no longer offered
    When I open the Games page after the import
    Then the Games page has no Published game
