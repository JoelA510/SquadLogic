Feature: Roster Conflict Detection
  As a League Administrator
  I want to see real-time conflict warnings when roster assignments violate rules
  So that I can fix buddy separations and gender mismatches, and see who plays up or down, before finalizing

  Background:
    Given I am logged into SquadLogic as an "Admin"
    And teams have been generated for the current season

  Scenario: No conflicts shows no banner
    Given all players are correctly assigned to eligible teams
    When I view the Roster Manager
    Then no conflict banner should be displayed

  Scenario: Buddy pair separation
    Given a buddy pair "Alice" and "Bob" are in the same division
    When I view the Roster Manager
    Then I should see a conflict banner with message "Buddy pair separated: Alice & Bob"

  Scenario: Gender mismatch
    Given a player "Sara" is assigned to a "Boys" team
    When I view the Roster Manager
    Then I should see a conflict banner with message containing "Gender mismatch"

  Scenario: Playing down is a flag in a list of its own, not a conflict
    Given a player "Jake" of natural age 11 is on a team in the "U8 Boys" division, a division for ages 7 to 8
    When I view the Roster Manager
    Then the play-up and play-down list says "Playing down: Jake (natural age 11) is on Team A in U8 Boys, a division for ages 7 to 8."
    And no conflict banner should be displayed

  Scenario: Direct quick draft writes are not exposed
    Given there are 20 players in the "U10" division
    When I view the Roster Manager
    Then the "Quick Draft" button should not be displayed on the Roster Manager
