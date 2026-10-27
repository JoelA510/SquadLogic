Feature: No contact surfaces
  As a league admin
  I want coaches' contact emails where I manage coaches, and no family contact details anywhere
  So that SquadLogic stores and shows no more about people than scheduling needs

  # R4 (20261025010000; docs/changes/2026-10-22-admin-focus.md): guardian
  # contacts, the contact card and the coach directory are gone. Admins see a
  # coach's email on the Coaches page (the import's key and their contact;
  # no coach signs in, docs/changes/2026-10-27-admin-only.md).

  Scenario: An admin sees a coach's email on the Coaches page and no guardian on a player record
    Given I am logged into SquadLogic as an "Admin"
    And I am on the "Coaches" page
    Then I should see the text "coach@example.com"
    When I open the player record "player-1"
    Then the player record offers no guardians

  Scenario: An admin is offered no contact card and no coach directory
    Given I am logged into SquadLogic as an "Admin"
    When I open my account settings
    Then I should be offered no contact card
    When I open my home page
    Then I should see no coach directory
