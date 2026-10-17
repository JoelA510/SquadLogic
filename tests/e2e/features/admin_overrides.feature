Feature: Admin Overrides
  As a system administrator
  I want to manually override automated assignments for rosters and practice slots
  So that I can accommodate special requests and resolve scheduling conflicts

  Background:
    Given I am logged into SquadLogic as "admin"

  Scenario: Drag-and-drop roster adjustments
    Given I am viewing the Team Roster page
    When I move a player from "Team A" to "Team B" using drag-and-drop
    Then the system should save the new player assignment
    And designate the source of this assignment as "manual"
    And instantly recalculate the skill balance and capacity metrics for both teams

  Scenario: Manual practice slot adjustments
    Given the automated schedule has been generated
    And I am on the Practice Scheduling page
    When I manually assign a team to an alternative practice slot
    Then the new practice assignment is saved with the "manual" source flag
    And any new coach or field capacity conflicts are immediately flagged in the UI

  Scenario: Resolving game schedule conflicts
    Given I am on the Game Scheduling page viewing an identified conflict
    When I drag a game to a new time slot to resolve the conflict
    Then the system validates the new slot against field availability and coach schedules
    And updates the game schedule if the selected slot is valid
