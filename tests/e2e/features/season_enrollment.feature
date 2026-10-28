Feature: Players belong to one season
  As a league admin
  I want each season's Players page to list that season's players only
  So that last season's registrations never appear in this season's lists, counts or teams

  Phase E3a (docs/changes/2026-10-27-season-enrollment.md; migration 20261108010000): a player is
  enrolled per season, and nothing carries over. The header's season switcher chooses the season
  the Players page is about; a season filter is not an authorization boundary (RLS stays
  organization-scoped), so the filter only chooses which of the organization's seasons is shown.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: The Players page lists only the selected season's players
    Given the league has a draft season "Winter 2027" with the player "Zoe Nextseason"
    When I open the players page
    Then the players grid lists "Alex Smith" and not "Zoe Nextseason"
    And the players page counts 2 registered
    When I switch the season to "Winter 2027 (draft)"
    Then the players grid lists "Zoe Nextseason" and not "Alex Smith"
    And the players page counts 1 registered
