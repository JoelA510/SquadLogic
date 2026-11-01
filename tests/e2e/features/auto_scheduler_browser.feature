Feature: The auto-scheduler's search runs in the browser (Phase D PR D)
  As a League Administrator
  I want a big league's search to run on my computer for as long as it needs
  So that it is not cut short at the server's time limit, and I still get a schedule the server has checked

  The practice route is answered by the Edge function's own solver and its own check
  (`tests/e2e/steps/edgeAutoSchedulerRoute.ts`): `prepare` hands the page the solver's input and a
  digest, the page's Web Worker (the real one, in Chromium) searches it, and `verify` seats the
  worker's placements through the server's admissibility check. The function's HTTP and database
  wrapper is not exercised here; the real-backend project covers it.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And 24 players are imported into the "U10 Girls" program
    And these teams and coaches in "U10 Girls":
      | team  | coach        |
      | Hawks | Coach Rivera |
      | Bears | Coach Chen   |
    And a Tuesday and a Thursday practice slot of 90 minutes with room for 2 teams each

  Scenario: A browser that can run a worker searches there and the server checks the result
    When I run the auto-scheduler on the Practice Scheduling page
    Then the auto-scheduler places 2 teams and leaves 0 unplaced
    And the page asked the function to prepare and then to verify
    And the panel says the search ran in the browser

  Scenario: A browser that cannot run a worker gets the server's own search
    Given this browser cannot run web workers
    When I run the auto-scheduler on the Practice Scheduling page
    Then the auto-scheduler places 2 teams and leaves 0 unplaced
    And the page asked the function to solve and nothing else
    And the panel says the search ran on the server because this browser cannot run the optimizer

  Scenario: Cancel ends a run that is still loading the season's data
    Given the function is slow to answer the run's first request
    When I start the auto-scheduler on the Practice Scheduling page
    Then the panel says it is loading the season's data
    When I cancel the run
    Then the run has ended without a schedule
    And the page asked the function to prepare and nothing else
