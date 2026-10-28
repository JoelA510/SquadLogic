Feature: Practices per division (Phase D PR B)
  As a League Administrator
  I want each division to say how many practices a week its teams get, and how long each is
  So that the auto-scheduler gives every team that many, on different days, and tells me what it could not place

  Each scenario sets the count through the Teams page's own rules form and then presses the
  practice page's Run control. The practice route is answered by the Edge function's own solver
  (`tests/e2e/steps/edgeAutoSchedulerRoute.ts`), which reads the division's settings from the
  page's store as the function reads them from the database, never from the request. The
  function's HTTP and database wrapper is not exercised here; the real-backend project covers it.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: A division set to two practices a week gives each team two, on different days
    Given 24 players are imported into the "U10 Girls" program
    When I set the "U10 Girls" division to 2 practices a week on the Teams page
    And these teams and coaches in "U10 Girls":
      | team  | coach        |
      | Hawks | Coach Rivera |
      | Bears | Coach Chen   |
    And a Tuesday and a Thursday practice slot of 90 minutes with room for 2 teams each
    And I run the auto-scheduler on the Practice Scheduling page
    Then the auto-scheduler places 4 practices and leaves 0 unplaced
    And "Hawks" has a Tuesday and a Thursday practice in the review
    And "Bears" has a Tuesday and a Thursday practice in the review
    And the panel says "Hawks" has 2 of 2 practices

  Scenario: Fewer weekdays than practices a week: each team keeps the one it got and the report says why
    Given 24 players are imported into the "U10 Girls" program
    When I set the "U10 Girls" division to 2 practices a week on the Teams page
    And these teams and coaches in "U10 Girls":
      | team  | coach        |
      | Hawks | Coach Rivera |
      | Bears | Coach Chen   |
    And a Thursday practice slot of 90 minutes with room for 2 teams
    And I run the auto-scheduler on the Practice Scheduling page
    Then the auto-scheduler places 2 practices and leaves 2 unplaced
    And the panel says "Hawks" has 1 of 2 practices because the division's slots fall on fewer weekdays
    And the panel says "Bears" has 1 of 2 practices because the division's slots fall on fewer weekdays

  Scenario: A practice length no slot matches leaves the practice unplaced with that reason
    Given 24 players are imported into the "U10 Girls" program
    When I set the "U10 Girls" division to 1 practices a week and 60 minutes long on the Teams page
    And these teams and coaches in "U10 Girls":
      | team  | coach        |
      | Hawks | Coach Rivera |
    And a Thursday practice slot of 90 minutes with room for 2 teams
    And I run the auto-scheduler on the Practice Scheduling page
    Then the auto-scheduler places 0 practices and leaves 1 unplaced
    And the panel says "Hawks" has 0 of 1 practices because no practice slot is exactly as long as the division's practice
