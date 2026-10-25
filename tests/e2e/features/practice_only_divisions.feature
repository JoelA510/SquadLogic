Feature: Practice-only divisions and reserved practice slots
  As a league admin
  I want a division that only practises, and practice slots kept for one division
  So that my youngest cohorts get their own sessions and no games

  Demo mode D2 (docs/changes/2026-10-22-demo-mode.md; migration 20261029010000):
  a division with plays_games off gets no fixtures and is listed as practice
  only; a reserved practice slot is its division's only.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: The game page lists a practice-only division instead of scheduling it
    Given the team run's division "U8 Boys" plays no games
    When I open the game scheduling page
    Then the game page lists "U8 Boys" as practice only with 2 teams
    And the game page says every generated team is practice only

  Scenario: An admin reserves a practice slot to a division in Field Management
    Given I am on the "Field Management" page
    When I reserve the "Tue 18:00" practice slot on "Field 1" to "U8 Coed"
    And I reload the page
    Then the "Tue 18:00" practice slot on "Field 1" is reserved to "U8 Coed"
    When I reserve the "Tue 18:00" practice slot on "Field 1" to "Any division"
    And I reload the page
    Then the "Tue 18:00" practice slot on "Field 1" is reserved to "Any division"
