Feature: Enacting a practice repair recommendation (retirements only)
  As an admin of a youth sports league
  I want to move one displaced practice once its field's retirement is saved
  So that the team keeps a practice, and the move is locked and audited

  8.6 3b PR 11c. Enact is disabled in the retirement dialog's dry-run
  preview (operator answer Q3). Once the retirement is saved, the retired
  field's card opens the panel over the STORED date, and one recommendation
  is enacted through the override prompt. Every check is a DOM assertion;
  the mock is touched only by the seeding step.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a fresh organization is active for the practice repair
    And I have an organization labeled "Test Org"
    And "Repair Pitch 1" holds two practice series, one of a length nothing else offers

  Scenario: Enact waits for the saved retirement, then moves one practice and locks it
    Given I am on the "Field Management" page
    When I click the "Retire" button for "Repair Pitch 1"
    And I set the retirement end date to "2026-09-30"
    And I click "Check and retire"
    And I open the practice repair recommendations
    Then every Enact button should be disabled because the retirement is not saved
    When I click "Retire anyway"
    Then the card of "Repair Pitch 1" should offer to repair practices after "2026-09-30"
    When I open the practice repair from the card of "Repair Pitch 1"
    And I enact the recommendation for "Repair Team A", accepting the override
    Then the practice of "Repair Team A" should be shown enacted and locked
