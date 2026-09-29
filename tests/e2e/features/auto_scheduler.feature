Feature: Intelligent Auto-Scheduler
  As a League Administrator
  I want an auto-generate button that optimizes practice assignments
  So that I can achieve the fairest possible schedule with minimal manual effort

  Background:
    Given I am logged into SquadLogic as an "Admin"
    And an organization and season are active

  Scenario: Auto-Scheduler panel is visible on Practice Scheduling page
    When I navigate to the Practice Scheduling page
    Then I should see the "Auto-Scheduler" panel
    And I should see an "Auto-Generate" button
    And the Auto-Generate button should be enabled

  Scenario: Auto-Scheduler panel shows progress during optimization
    Given I have imported player data
    And I have generated teams
    And I have generated a practice schedule
    When I navigate to the Practice Scheduling page
    And I click the "Auto-Generate" button
    Then I should see an optimization progress indicator
    And the progress indicator should show iteration count
    And the progress indicator should show a best score percentage
    And the Auto-Generate button should be disabled during optimization

  Scenario: Auto-Scheduler shows results on completion
    Given I have imported player data
    And I have generated teams
    And I have generated a practice schedule
    When I navigate to the Practice Scheduling page
    And I click the "Auto-Generate" button
    And the auto-scheduler completes
    Then I should see "Optimization Complete" in the auto-scheduler panel
    And I should see the number of assigned teams
    And I should see the optimization score
    And I should see a "Reset" button

  Scenario: Auto-Scheduler review can be applied through persistence
    Given I have imported player data
    And I have generated teams
    And I have generated a practice schedule
    When I navigate to the Practice Scheduling page
    And I click the "Auto-Generate" button
    And the auto-scheduler completes
    Then I should see the practice schedule review panel
    When I apply the practice schedule
    Then I should see "Practice Schedule Applied" in the practice schedule review panel

  Scenario: Practice Apply records a daylight TIME TBD remainder from the Auto-Scheduler
    Given I have imported player data
    And I have generated teams
    And I have generated a practice schedule
    And the auto-scheduler truncates a placement at sunset
    When I navigate to the Practice Scheduling page
    And I click the "Auto-Generate" button
    And the auto-scheduler completes
    Then I should see the practice schedule review panel
    When I apply the practice schedule
    Then I should see "Practice Schedule Applied" in the practice schedule review panel
    And the applied save records one daylight TIME TBD exception for the truncated placement

  Scenario: Manual practice override can be staged and applied through persistence
    Given I have imported player data
    And I have generated teams
    And I have generated a practice schedule
    When I navigate to the Practice Scheduling page
    And I enter manual override mode
    And I stage a manual practice override
    Then I should see a staged manual override
    When I apply the practice schedule
    Then I should see "Practice Schedule Applied" in the practice schedule review panel

  Scenario: Auto-Scheduler displays error on failure
    Given I have imported player data
    And the auto-scheduler service is unavailable
    When I navigate to the Practice Scheduling page
    And I click the "Auto-Generate" button
    Then I should see an error message in the auto-scheduler panel

  Scenario: Auto-Scheduler respects locked assignments
    Given I have imported player data
    And I have generated teams
    And I have generated a practice schedule
    And team "t1" has a locked assignment to slot "ps-1"
    When I navigate to the Practice Scheduling page
    And I click the "Auto-Generate" button
    And the auto-scheduler completes
    Then team "t1" should remain assigned to slot "ps-1"
    And team "t1" assignment should have source "manual"

  Scenario: Auto-Scheduler panel is accessible via keyboard
    When I navigate to the Practice Scheduling page
    Then the "Auto-Generate" button should be keyboard focusable
    And the "Auto-Generate" button should have an accessible label
    And the auto-scheduler panel should use proper ARIA landmarks
