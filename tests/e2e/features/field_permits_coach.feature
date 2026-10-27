Feature: A coach produces a field permit at the field
  As a coach
  I want the permits for the fields my teams use on my phone, with the document one tap away
  So that when I am asked to show a permit, I can

  Phase C3 (docs/changes/2026-10-22-phase-c-permits.md; admin focus R6): the server narrows a coach's
  read to the permits for the fields where their teams have a game or a practice, and this feature
  holds what the coach is shown of it. A permit blocks nothing (owner, 2026-10-26); a guardian has
  no access (owner decision 2). The mock's Open link is a data: URL, so the scenario proves the
  link was made for the coach; the real-backend feature proves what the server then returns.

  Scenario: A coach sees the warning on their home and opens the permit on a phone
    Given I am logged into SquadLogic as a "coach"
    And Team A has an upcoming game and a weekly practice
    And a permit from "City Recreation" numbered "0042" expires in 12 days, has a file and covers "Field 1"
    And I am using a phone
    When I go to "/"
    Then my Field permits card shows "City Recreation #0042" as "Expires in 12 days"
    When I open the permits page from the Field permits card
    Then the permit from "City Recreation" lists number "0042", the dates and the field "Central Park, Field 1"
    And the Open and Download buttons of the permit from "City Recreation" are at least 44 pixels square
    And the page does not scroll sideways
    When I open the file of the permit from "City Recreation"
    Then the file opens in a new tab through a signed link

  Scenario: A coach whose teams use no field with a permit sees a clear empty state
    Given I am logged into SquadLogic as a "coach"
    And Team A has an upcoming game and a weekly practice
    And a permit from "Elsewhere Authority" numbered "0007" expires in 90 days, has a file and covers "Field 2"
    When I go to "/"
    Then my Field permits card says no permit is on record for my fields
    When I go to "/permits"
    Then the permits page says no permit is on record for my fields

  Scenario: A member whose role the league no longer has is sent home from the permits page
    Given I am logged into SquadLogic as a "coach"
    And Team A has an upcoming game and a weekly practice
    And a permit from "City Recreation" numbered "0042" expires in 12 days, has a file and covers "Field 1"
    And my membership carries the removed role "parent"
    When I go to "/permits"
    Then I am sent home with the message "Unauthorized access"
    And no permit is shown
