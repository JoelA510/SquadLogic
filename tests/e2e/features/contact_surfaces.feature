Feature: No contact surfaces
  As a league admin
  I want coaches' sign-in emails where I manage coaches, and no family contact details anywhere
  So that SquadLogic stores and shows no more about people than scheduling needs

  # R4 (20261025010000; docs/changes/2026-10-22-admin-focus.md): guardian
  # contacts, the contact card and the coach directory are gone, and no read a
  # coach can call returns an email or phone. Admins see a coach's sign-in
  # email on the Coaches page.

  Scenario: An admin sees a coach's sign-in email on the Coaches page and no guardian on a player record
    Given I am logged into SquadLogic as an "Admin"
    And I am on the "Coaches" page
    Then I should see the text "coach@example.com"
    When I open the player record "player-1"
    Then the player record offers no guardians

  Scenario: A coach is offered no contact card and no coach directory
    Given I am logged into SquadLogic as a "coach"
    And I have an organization labeled "Test Org"
    And I coach the "Tigers" team, which has the player "Alex"
    When I open my account settings
    Then I should be offered no contact card
    When I open my home page
    Then I should see no coach directory
