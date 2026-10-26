Feature: Programs, the optional groups of divisions
  As a league admin
  I want to group divisions into programs when that helps, and not be asked to when it does not
  So that a league that runs on divisions alone is never blocked, nagged or cluttered

  Phase E2 (docs/changes/2026-10-22-phase-e-seasons.md; migration 20261101020000; owner rules
  2026-10-26): programs are optional, the season's default program is "No program", and the
  Programs section of Settings > Season & Calendar is where programs live.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: A league that runs on divisions alone is never asked for a program
    When I open the Season and Calendar settings
    Then the Programs section says programs are optional
    And no program of the league's own is listed
    And the division "U8 Coed" is in the program "No program"

  Scenario: An admin makes a program, puts a division in it, and takes it out again
    When I open the Season and Calendar settings
    And I add the program "Junior"
    And I put the division "U8 Coed" in the program "Junior"
    And I reload the page
    And I open the Season and Calendar settings
    Then the division "U8 Coed" is in the program "Junior"
    When I delete the program "Junior" after reading that "U8 Coed" moves
    Then the division "U8 Coed" is in the program "No program"
    And no program of the league's own is listed
