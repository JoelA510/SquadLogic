Feature: Visual Role-Based Access Control
  As a league admin
  I want the UI to offer the admin pages and nothing built for a coach
  So that I am not confused by screens that no longer exist

  Only league admins sign in (docs/changes/2026-10-27-admin-only.md): there is no coach sidebar, home
  or sign-in, and a membership still carrying the old role is sent home from the admin pages.

  Scenario: The admin sidebar offers the admin pages and no coach pages
    Given I am logged into SquadLogic as an "Admin"
    When I view the main navigation Sidebar
    Then I should see links for "Players", "Field Permits", and "Practice Preferences"
    And I should see links for "Import", "Settings", and "Fields & Venues"
    But I should NOT see links for "My Dashboard", "My Team", or "Coach Schedule"

  Scenario: Admin Coach Review Page
    Given I am logged into SquadLogic as an "Admin"
    And I am on the "Coaches" page
    Then I should see the text "registered"
    And I should see the text "Mock Coach"
    And I should see the text "Morgan Reyes"

  Scenario: Admin Coach Lead Promotion and Assignment
    Given I am logged into SquadLogic as an "Admin"
    And I am on the "Coaches" page
    When I promote "Morgan Reyes" from the Coaches page
    And I assign "Morgan Reyes" to "Tigers" from the Coaches page
    Then the coach row for "Morgan Reyes" should show team "Tigers"

  # Score entry and standings are admin functions the league turns on (R6,
  # 20261028010000): a member whose role the league no longer has (a stale
  # `coach`) is sent home from both, even with the settings on.
  Scenario: Score Entry Restrictions in League Standings
    Given I am logged into SquadLogic as an "Admin"
    And the league has turned on score entry and standings
    And my membership carries the removed role "coach"
    When I navigate to the "League Standings" page
    Then I should be redirected to the Dashboard
    When I go to "/scores"
    Then I should be redirected to the Dashboard
