Feature: Who sees whose contact details
  As a coach on a team
  I want my team's player names
  So that the team can organize without the league exposing anyone's contact details

  # Phase A3a (docs/changes/2026-10-20-phase-a-privacy.md): the roster comes
  # through get_team_roster. Since R3 (20261024010000;
  # docs/changes/2026-10-22-admin-focus.md) there is no guardian view: a
  # coach reads their own team's player names only, and no guardian contact.
  # Since R4 (20261025010000) there is no contact card either (its scenario
  # retired with it; contact_surfaces.feature checks the account page offers
  # none). The teammate below still carries guardian contacts, as a row does
  # until the migration deploys (CI applies it after the frontend ships).

  Background:
    Given I am logged into SquadLogic as a "coach"
    And I have an organization labeled "Test Org"
    And I coach the "Tigers" team, which has the player "Alex"
    And the "Tigers" have a teammate "Rowan" with two guardian contacts

  Scenario: A coach sees their players' names and no guardian contact
    When I open the roster of the "Tigers"
    Then I should see the player "Rowan Test" on the roster
    And I should not see the guardian contact "rowan.primary@example.test"
    And I should not see the guardian contact "rowan.second@example.test"
    And I should see no phone or email link
