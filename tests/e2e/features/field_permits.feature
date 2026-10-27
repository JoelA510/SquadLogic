Feature: Field and venue permits
  As a league admin
  I want to keep each field's permit on record, with its document, and be reminded before it lapses
  So that a coach asked to show a permit can, and nothing is scheduled blind

  Phase C2 (docs/changes/2026-10-22-phase-c-permits.md; migration 20261102010000; owner rules
  2026-10-26): a permit is a record with one file, it warns and never blocks, and a field with no
  current permit is warned about beside the expiring and expired ones.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And I have an organization labeled "Test Org"
    And a field "Field 1" at "Main Complex" exists without subunits
    And I am on the "Field Management" page

  Scenario: An admin records a permit with its file, replaces the file, and is warned when it nears its end
    Then the field "Field 1" at "Main Complex" says it has no current permit
    When I add a permit from "City Parks" numbered "0042" covering "Main Complex, Field 1" that expires in 12 days with the file "permit.pdf"
    Then the permit from "City Parks" says "Expires in 12 days"
    And the permit from "City Parks" lists the file "permit.pdf"
    And the field "Field 1" at "Main Complex" shows "Permit: Expires in 12 days"
    And the Permits section warns that 1 permit expires within 30 days
    When I replace the file of the permit from "City Parks" with "renewal.pdf"
    Then the permit from "City Parks" lists the file "renewal.pdf"
    And the permit from "City Parks" keeps its number "0042" with its leading zero

  Scenario: The admin home lists the permit reminders
    When I add a permit from "City Parks" numbered "0042" covering "Main Complex, Field 1" that expires in 12 days with the file "permit.pdf"
    And I open the admin home
    Then the admin home needs attention for "1 permit expires within 30 days"

  Scenario: A field with no permit is warned about on the admin home, and a refused file is not sent
    When I open the admin home
    Then the admin home needs attention for fields with no current permit
    When I am on the "Field Management" page
    And I try to add a permit with a file that is not a PDF
    Then the permit dialog says the file is not a real PDF
    And no permit is recorded

  Scenario: Deleting a permit asks first and leaves the field warned
    Given I add a permit from "City Parks" numbered "0042" covering "Main Complex, Field 1" that expires in 12 days with the file "permit.pdf"
    When I delete the permit from "City Parks" after reading the confirmation
    Then no permit is recorded
    And the field "Field 1" at "Main Complex" says it has no current permit
