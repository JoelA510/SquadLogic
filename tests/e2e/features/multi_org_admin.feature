Feature: An admin of more than one organization
  As a league admin who runs two organizations
  I want to switch between them and see only the active one's records
  So that nothing from the other league appears while I work in this one

  docs/changes/2026-10-27-admin-only.md, F5: the server has no "active organization"; every read
  names the organization the app is working in, so after a switch each page's read must carry the
  new one. Membership in both is allowed (PRIMARY KEY (organization_id, profile_id)).

  Background:
    Given the following organizations exist: "Org A", "Org B"
    And "Admin Casey" belongs to "Org A" with role "Admin"
    And "Admin Casey" belongs to "Org B" with role "Admin"

  Scenario: Switching organizations shows each one's teams and none of the other's
    Given I am logged into the SquadLogic dashboard as "Admin Casey"
    When I request the list of teams, players, or schedules
    Then I should only receive records associated with "Org A"
    And any direct query for "Org B" records should return empty or unauthorized
    When I switch the active organization to "Org B"
    And I open Teams & Rosters from the navigation
    Then I should only receive records associated with "Org B"
    And any direct query for "Org A" records should return empty or unauthorized
    When I switch the active organization to "Org A"
    And I open Teams & Rosters from the navigation
    Then I should only receive records associated with "Org A"
    And any direct query for "Org B" records should return empty or unauthorized
