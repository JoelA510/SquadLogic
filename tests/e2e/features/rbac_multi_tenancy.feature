Feature: RBAC and Multi-Tenancy Enforcement
  As a system administrator
  I want strict role-based access control and multi-tenancy isolation
  So that users can only access data belonging to their organization and role

  Background:
    Given the following organizations exist: "Org A", "Org B"
    And "Coach Alice" belongs to "Org A" with role "Coach"
    And "Admin Bob" belongs to "Org B" with role "Admin"

  # As Org B's admin: since Phase A3 a coach no longer lists the league's teams
  # (VIEW_ALL_TEAMS is an admin's), so the isolation is checked by a role that does.
  Scenario: Multi-Tenancy Data Isolation (RLS)
    Given I am logged into the SquadLogic dashboard as "Admin Bob"
    When I request the list of teams, players, or schedules
    Then I should only receive records associated with "Org B"
    And any direct query for "Org A" records should return empty or unauthorized

  Scenario: Route Protection via usePermission
    Given I am logged into the SquadLogic dashboard as "Coach Alice"
    When I attempt to navigate to full Admin routes such as Data Import or Settings
    Then I should see an "Unauthorized access" warning
    And I should be redirected to the Dashboard

  Scenario: Admin Access Verification
    Given I am logged into the SquadLogic dashboard as "Admin Bob"
    When I navigate to the Admin routes
    Then I should successfully load the page
    And I should be able to view and manage data specifically for "Org B"

  # The read-only scenario (a parent until R3, 20261024010000) is the coach's
  # since R6 (20261028010000) takes MANAGE_SCHEDULE and the admin scheduling
  # pages from coaches: their schedule is on their home.
  Scenario: A coach cannot enter team or schedule edit flows
    Given I am logged into SquadLogic as a "coach"
    When I open the guarded team and schedule routes as a coach
    Then Team Management, Practice Scheduling and Game Scheduling each redirect the coach to the Dashboard
    Given the league has turned on score entry and standings
    Then the lighting, scores and standings pages redirect the coach too
