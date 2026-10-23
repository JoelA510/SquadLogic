Feature: Admin Reporting Dashboard
  As an organization admin
  I want to view key metrics and export data to CSV
  So that I can analyze season performance offline

  Background:
    Given I have an organization labeled "Test Org"
    And there is an active season "Fall 2026"

  Scenario: Admin views the reporting dashboard key metrics
    Given I am logged into SquadLogic as an "admin"
    And the admin views the reporting dashboard
    Then I should see the "Total Players" metric
    And I should see the "Total Teams" metric
    And the reporting dashboard shows no readiness chart

  Scenario: Admin exports rosters to CSV
    Given I am logged into SquadLogic as an "admin"
    And the admin views the reporting dashboard
    When I click the "Export Rosters CSV" button
    Then a CSV file containing player and team data should be downloaded client-side

  Scenario: Coach enters a game score and standings update
    Given I am logged into SquadLogic as a "coach"
    And the coach views the league standings
    When I input a score of "3" to "1" for a completed game
    Then the "League Standings" table should reflect a win for the home team
    And the points and goal differential should update accordingly
