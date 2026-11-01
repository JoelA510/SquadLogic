Feature: Evaluations add years played and skill to a season's players
  As a league admin
  I want to import my evaluations after registration
  So that players carry their experience and rating without anyone being added or overwritten

  Phase E3c (docs/changes/2026-10-27-season-enrollment.md, C2; migration 20261113010000): a file of
  registration ids with years played, a skill tier and/or a 1-5 rating only UPDATES the players
  already in the season. A row that names nobody is listed and creates no one; a blank cell leaves
  the stored value alone. The admin sees the server's counts before confirming, and again after.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And the league tracks the 1 to 5 player rating

  Scenario: An evaluations file updates two players, lists the id it cannot match and leaves a blank cell alone
    Given I have navigated to the Data Import page
    When I import a registration file of three players, two of them with years played
    And I choose the evaluations import and check a file that rates two players and names a stranger
    Then the evaluations preview counts 2 players to update, 1 already up to date and 1 row matching no player
    And the preview lists the unmatched registration id "NOBODY-9"
    And axe finds no serious or critical violations on "/import" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/import" in the "dark" theme
    When I apply the evaluations import
    Then the import is applied with warnings and the summary says 2 players were updated
    When I open the evaluations players page
    Then "Eva Evalson" shows 7 years played and the rating 4
    And "Finn Finlay" shows 3 years played and the rating 2
    And "Gus Gustavo" shows 5 years played
    And the players grid does not list "Nobody Nine"

  Scenario: A file with an out-of-range cell is flagged before anything is applied
    Given I have navigated to the Data Import page
    When I choose the evaluations import and check a file whose second row has 31 years played
    Then the evaluations preview marks the cell and counts 1 row not valid
