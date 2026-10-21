Feature: Who sees whose contact details
  As a parent on a team
  I want to reach my child's teammates' families, and to choose what they see of mine
  So that the team can organize without the league exposing more than it should

  # Phase A3a (docs/changes/2026-10-20-phase-a-privacy.md): the roster comes
  # through get_team_roster, which gives a guardian their own child's guardian
  # contacts in full and a teammate's primary contact only.

  Background:
    Given I am logged into SquadLogic as a "parent"
    And I have an organization labeled "Test Org"
    And my child "Alex" is on the "Tigers" team
    And the "Tigers" have a teammate "Rowan" with two guardian contacts

  Scenario: A parent sees a teammate's primary guardian contact and not the second
    When I open the roster of the "Tigers"
    Then I should see the guardian contact "rowan.primary@example.test"
    And I should not see the guardian contact "rowan.second@example.test"

  Scenario: A parent saves a contact card
    When I save a contact card with phone "555-0142" and choose to share it
    Then the contact card should be saved
