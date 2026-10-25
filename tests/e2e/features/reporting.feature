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

  # Score entry and standings are admin functions the league turns on, off by
  # default (admin focus R6, 20261028010000, owner decision 4).
  Scenario: Admin enters a game score and standings update, once the league turns both on
    Given I am logged into SquadLogic as an "admin"
    And the admin's season is the mock season
    When the admin turns on "Score Entry" and "Standings" in the Settings features
    And I open "Standings" from the admin navigation
    Then the admin sees the league standings
    When I input a score of "3" to "1" for a completed game
    Then the "League Standings" table should reflect a win for the home team
    And the points and goal differential should update accordingly

  Scenario: Score entry and standings are off until the league turns them on
    Given I am logged into SquadLogic as an "admin"
    Then the admin navigation offers no "Standings"
    And the admin navigation offers no "Scores & Results"
    When I go to "/standings"
    Then I should be redirected to the Dashboard
    When I go to "/scores"
    Then I should be redirected to the Dashboard
    When the admin turns on "Score Entry" and "Standings" in the Settings features
    Then the admin navigation offers "Standings"
    And the admin navigation offers "Scores & Results"
