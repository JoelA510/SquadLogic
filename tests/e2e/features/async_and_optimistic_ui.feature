Feature: Async States and Optimistic UI Updates
  As a League Administrator
  I want clear indicators for background processes and immediate UI feedback
  So that I have a responsive and predictable experience

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: Teaming Configuration Rules
    Given I am on the "Team Management" page
    When I change the "Max Roster" input to "10"
    And I enter a "Random Seed" of "12345"
    And I click "Generate Teams"
    Then the resulting teams summary should reflect the new constraints

  Scenario: Persistence Sync Timeout Handling
    Given I am on the "Team Management" page
    And I have generated a new set of teams
    When the network connection stalls
    And I click "Sync to Supabase" on the Team Persistence Panel
    Then the panel status should change to "Supabase sync timed out, so it is not known whether the teams were saved. Reload the page to see the saved teams before syncing again."

  Scenario: A synced team review keeps its success line
    Given 100 players are imported into the "U12 Boys" program
    When I ask the Teams page for 5 teams of at most 10 players
    And I press "Generate Teams" on the Teams page
    And the team-persistence function accepts the sync
    And I click "Sync to Supabase" on the Team Persistence Panel
    Then the Teams page still says the team review was applied, with what was synced

  Scenario: Output Generation Async Pipeline
    Given I am on the "Outcome" workflow step on Dashboard
    When I click "Generate CSVs"
    Then the button should disable and show "Generating..."
    When the generation completes, I click "Upload to Storage"
    Then the status text should pulse orange saying "Uploading to Storage..."
    And eventually display a green success message confirming completion

  Scenario: Recharts Tooltip Rendering
    Given I am on the "Reporting Dashboard"
    When I hover my mouse over the "Fluid Attributes Distribution" chart
    Then a dark-themed tooltip should appear showing exact counts
