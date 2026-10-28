Feature: Start next season from this one
  As a league admin
  I want to prepare next season while this one is still running
  So that I can import next season's registrations without disturbing this season's players

  Phase E3b (docs/changes/2026-10-27-season-enrollment.md; migration 20261109010000): an admin
  starts a draft season from the active one (its divisions and programs are copied, no people),
  sets the draft's age cutoff, imports a registration file into it, and activates it. The active
  season's Players page does not change until then, and the draft's shows the new rows.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: A draft takes its own registration import and is then activated
    Given the active season's player "Alex Smith" has the registration id "GS-E3B-ALEX"
    When I open the Season and Calendar settings
    And I start the next season "Winter 2027" from "Fall 2026" for the year 2027, running "2027-01-10" to "2027-06-30"
    Then the season "Winter 2027" is listed as "Draft"
    When I set the draft "Winter 2027" to cut off ages on "September" 1
    Then the season "Winter 2027" is listed with the age cutoff "Custom: September 1"
    When I switch the season to "Winter 2027 (draft)"
    And I import the player file with "Zoe Nextseason" and the renewed "Alex Renewed"
    And I open the players page
    Then the players grid lists "Zoe Nextseason" and not "Jamie Jones"
    And the players page counts 2 registered
    When I switch the season to "Fall 2026"
    Then the players grid lists "Alex Smith" and not "Zoe Nextseason"
    And the players grid lists "Jamie Jones" and not "Alex Renewed"
    And the players page counts 2 registered
    When I open the Season and Calendar settings
    And I activate the season "Winter 2027"
    Then the season "Winter 2027" is listed as "Active"
    And the season "Fall 2026" is listed as "Completed"
