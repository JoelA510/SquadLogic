Feature: The admins' Field Permits page
  As a league admin
  I want every permit on record in one place, with the document one tap away
  So that when I am asked to show a permit at a field, I can

  Admin only (docs/changes/2026-10-27-admin-only.md, F3): no coach signs in, so the permits page
  that Phase C3 built for coaches is the admins' consolidated, quick access. Upload stays in Fields
  & Venues (field_permits.feature). A permit blocks nothing (owner, 2026-10-26). The mock's Open
  link is a data: URL, so the scenario proves the link was made; the real-backend feature proves
  what the server then returns.

  Scenario: An admin finds every permit under Scheduling and opens one on a phone
    Given I am logged into SquadLogic as an "admin"
    And a permit from "City Recreation" numbered "0042" expires in 12 days, has a file and covers "Field 1"
    When I go to "/"
    And I open Field Permits from the navigation
    Then the permit from "City Recreation" lists number "0042", the dates and the field "Central Park, Field 1"
    Given I am using a phone
    Then the Open and Download buttons of the permit from "City Recreation" are at least 44 pixels square
    And the page does not scroll sideways
    When I open the file of the permit from "City Recreation"
    Then the file opens in a new tab through a signed link

  Scenario: With no permit on record the page says so and points to Fields & Venues
    Given I am logged into SquadLogic as an "admin"
    When I go to "/permits"
    Then the permits page says no permit is on record and points to Fields & Venues

  Scenario: A member whose role the league no longer has is sent home from the permits page
    Given I am logged into SquadLogic as an "admin"
    And a permit from "City Recreation" numbered "0042" expires in 12 days, has a file and covers "Field 1"
    And my membership carries the removed role "coach"
    When I go to "/permits"
    Then I am sent home with the message "Unauthorized access"
    And no permit is shown
