Feature: Schedule exports
  As a league admin
  I want a team's schedule as CSV, as XLSX and as a calendar file
  So that I can share it, print it and put it in a calendar app

  Admin focus R7 (docs/changes/2026-10-22-admin-focus.md): every event the
  schedule shows is in the files, a game with no slot as "Date and time TBD"
  with its reason, and no export carries a contact column. Admins only
  (docs/changes/2026-10-27-admin-only.md): no coach signs in.

  Scenario: An admin downloads a team's schedule from its team page
    Given I am logged into SquadLogic as an "admin"
    And Team A has an upcoming game and a weekly practice
    When I go to "/team/t1"
    And I download "Calendar (.ics)" from the team page
    Then the calendar "Team_A_Schedule.ics" holds the game and 4 practices of "Team A"
    When I download "CSV" from the team page
    Then the CSV "Team_A_Schedule.csv" lists the game against "Team B", 4 practices and the games with no slot
    And the CSV has no contact column
    When I download "Excel (.xlsx)" from the team page
    Then the workbook "Team_A_Schedule.xlsx" holds the CSV's rows

  Scenario: An admin downloads the master schedule as XLSX
    Given I am logged into SquadLogic as an "admin"
    When I click to export the team rosters or schedules
    Then the system should generate the CSV file
    When I download "Download Master XLSX" from the generated files
    Then the workbook "master-schedule.xlsx" has the master schedule's columns
