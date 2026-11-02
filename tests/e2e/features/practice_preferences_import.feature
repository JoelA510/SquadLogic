Feature: Practice preferences import
  As a league administrator
  I want to import a file of practice preferences, see what it will do before it does it, and
  accept the musts it asked for together
  So that each team's rules reach the scheduler without me typing them in, and nothing becomes a
  hard rule until I say so

  Phase D C2 (docs/changes/2026-10-27-phase-d-scheduling.md, PR C2; no migration). Coaches never
  sign in: an admin collects preferences some other way (a Google Form exported to CSV, say) and
  imports the file on the Practice preferences page. One row is one rule, found by the coach's
  email and the team's name. The import runs in the mock client, whose finalizer is held to the SQL
  by its own tests; the page's words are read from the DOM.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a season with two teams, two coaches and no practice preferences

  Scenario: A file is previewed, imported, and its musts are accepted together
    When I open the practice preferences page
    And I open the "Import a file" tab of the practice preferences page
    And I choose a preference file named "spring-preferences.csv" with these rows:
      | Coach Email                | Team        | Request Level | Days     | Start Times | Venues     |
      | casey.prefs@example.test   | Prefs Hawks | must          | Tuesday  | 5:00 PM     |            |
      | casey.prefs@example.test   | Prefs Hawks | must          | Thursday |             |            |
      | casey.prefs@example.test   |             | prefer        | Monday   |             | Prefs Park |
      | nobody.prefs@example.test  | Prefs Hawks | prefer        | Monday   |             |            |
      | casey.prefs@example.test   | Prefs Ghosts| prefer        | Monday   |             |            |
      | robin.prefs@example.test   | Prefs Owls  | must          | Friday   |             |            |
    Then the preview says it will add 5 rules for 2 teams
    And the preview says 3 musts will wait for a decision
    And the preview lists the coach "nobody.prefs@example.test" as one it will not create
    And the preview lists the team "Prefs Ghosts" as one it will not create
    And the preview says row 3 makes a rule for each of "Prefs Hawks, Prefs Owls"
    When I import the file
    Then the import result says 5 rules were added for 2 teams
    When I review the pending musts
    Then 3 musts are pending
    When I open Accept all
    Then the confirmation names 3 rules
    And the confirmation lists 1 conflict before anything else
    When I confirm Accept all
    Then no musts are pending
    And the rules list shows 3 musts and 2 prefers

  Scenario: A file whose only team is unknown applies nothing
    When I open the practice preferences page
    And I open the "Import a file" tab of the practice preferences page
    And I choose a preference file named "ghosts.csv" with these rows:
      | Coach Email              | Team         | Days   |
      | casey.prefs@example.test | Prefs Ghosts | Monday |
    Then the preview says nothing in the file can be applied
    And the preview lists the team "Prefs Ghosts" as one it will not create
    And the import button says "Nothing to import" and is off

  Scenario: An empty file is refused in words
    When I open the practice preferences page
    And I open the "Import a file" tab of the practice preferences page
    And I choose an empty preference file
    Then the page says the file appears to be empty
    And no preview is shown

  Scenario: Importing again replaces only the imported rules of the teams the file names
    Given a file of practice preferences was imported with two musts that disagree
    And the admin added a rule for "Prefs Hawks" in the app
    When I open the practice preferences page
    And I open the "Import a file" tab of the practice preferences page
    And I choose a preference file named "replacement.csv" with these rows:
      | Coach Email              | Team        | Days   |
      | casey.prefs@example.test | Prefs Hawks | Friday |
    Then the preview says it will add 1 rule for 1 team
    And the preview says it replaces 2 imported rules
    When I import the file
    Then the import result says 1 rule was added for 1 team
    When I open the "Rules" tab of the practice preferences page
    Then the rules list shows a rule for "Prefs Hawks" on Friday, the admin's rule and the other team's rule
    And the rules list shows no rule for "Prefs Hawks" on Tuesday or Thursday

  Scenario: A completed season takes no preference import and no rule changes
    Given the season is completed
    When I open the practice preferences page
    Then the page says the season is read-only
    When I open the "Import a file" tab of the practice preferences page
    Then the file chooser is off
    When I open the "Rules" tab of the practice preferences page
    Then the Add a rule button is off

  Scenario: The import preview passes axe in the light and dark themes
    When I open "/coaches/practice-preferences" and see its "Practice preferences" heading
    And I open the "Import a file" tab of the practice preferences page
    And I choose a preference file named "spring-preferences.csv" with these rows:
      | Coach Email                | Team        | Request Level | Days     | Start Times | Venues     |
      | casey.prefs@example.test   | Prefs Hawks | must          | Tuesday  | 5:00 PM     |            |
      | casey.prefs@example.test   |             | prefer        | Monday   |             | Prefs Park |
      | nobody.prefs@example.test  | Prefs Hawks | prefer        | Monday   |             |            |
      | casey.prefs@example.test   | Prefs Ghosts| prefer        | Monday   |             |            |
    Then the scan sees "What spring-preferences.csv will do" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "What spring-preferences.csv will do" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "dark" theme

  Scenario: Pending musts grouped by file, and the Accept all confirmation, pass axe in both themes
    Given a file of practice preferences was imported with two musts that disagree
    When I open "/coaches/practice-preferences" and see its "Practice preferences" heading
    Then the scan sees "Pending musts (2)" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I open the "Accept all pending musts" dialog with "Accept all 2"
    Then axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "Conflicts (1)" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "dark" theme

  Scenario: The rules list, its editor and the conflicts view pass axe in both themes
    Given a file of practice preferences was imported with two musts that disagree
    And the admin added a rule for "Prefs Hawks" in the app
    When I open "/coaches/practice-preferences" and see its "Practice preferences" heading
    And I open the "Rules" tab of the practice preferences page
    Then the scan sees "Rules in force (4)" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I open the "Edit a rule" dialog with "Edit"
    Then axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "This rule reads:" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "dark" theme

  Scenario: The conflicts view lists musts no practice can meet and passes axe in both themes
    Given a file of practice preferences was imported with two musts that disagree
    And the admin accepted the file's musts
    When I open "/coaches/practice-preferences" and see its "Practice preferences" heading
    And I open the "Conflicts" tab of the practice preferences page
    Then the conflicts view lists 1 conflict on "Prefs Hawks"
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "these musts ask for values with nothing in common" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "dark" theme

  Scenario: Saving the days of a pending must leaves it pending, and the editor decides it only with its own buttons
    Given a file of practice preferences was imported with two musts that disagree
    When I open the practice preferences page
    And I open the "Rules" tab of the practice preferences page
    And I open the "Edit a rule" dialog with "Edit"
    Then the editor says the rule is still pending
    When I move the open rule's day from "Tuesday" to "Friday" and save it
    Then the page says the rule is still waiting for a decision
    When I open the "Pending musts" tab of the practice preferences page
    Then 2 musts are pending
    When I open the "Rules" tab of the practice preferences page
    And I open the "Edit a rule" dialog with "Edit"
    And I keep the open rule as prefer from its editor
    Then the page says the rule was kept as prefer
    When I open the "Pending musts" tab of the practice preferences page
    Then 1 must is pending

  Scenario: The editor on a pending must passes axe in the light and dark themes
    Given a file of practice preferences was imported with two musts that disagree
    When I open "/coaches/practice-preferences" and see its "Practice preferences" heading
    And I open the "Rules" tab of the practice preferences page
    And I open the "Edit a rule" dialog with "Edit"
    Then the scan sees "Still pending" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "Still pending" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "dark" theme
