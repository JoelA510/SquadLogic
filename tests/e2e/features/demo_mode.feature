Feature: Try the demo
  As a league administrator deciding whether SquadLogic fits my league
  I want a private copy of a ready-made league
  So that I can try it without an account or my own data

  Demo mode D4 (docs/changes/2026-10-22-demo-mode.md): on the mock, "Try the demo" signs the visitor
  in anonymously and starts a small slice of the league (two divisions, 16 players); the real
  backend's own scenario, with the full 128 teams, is real_backend_demo.feature. The expiry is
  shortened to a few seconds where a scenario needs to wait it out.

  Scenario: A visitor tries the demo from the sign-in page
    Given I am signed out on the sign-in page
    When I choose "Try the demo" on the sign-in page
    Then the demo league is open
    And the header shows the demo timer counting down
    And the demo league lists 16 players

  Scenario: A demo's people are read-only, but where they play and how they are rated can change
    Given I am in the demo league
    When I open the demo's players page
    Then a player's name cannot be edited and a player's status can
    And the players page offers no way to add or delete a player
    When I open the demo's coaches page
    Then no coach can be given a status or deleted

  Scenario: Trying to import a file opens a notice instead of the file picker
    Given I am in the demo league
    When I open the demo's import page and try to browse for a file
    Then no file picker opens
    And the import notice offers an account here and a SquadLogic of my own

  Scenario: The demo ends when its time is up
    Given I am in a demo league that lasts 8 seconds
    Then I land on the demo-ended page
    And I am signed out
    When I open the demo-ended page
    And I choose "Start again" on the demo-ended page
    Then the demo league is open

  Scenario: Leaving the demo signs the visitor out
    Given I am in the demo league
    When I choose "Leave demo"
    Then I am back on the sign-in page, signed out

  Scenario: A full demo leaves the visitor on the entry page, signed out, with the reason announced
    Given the demo is full
    When I open the demo entry page
    Then I stay on the entry page and it says the demo is busy
    And I am signed out

  Scenario: A demo's exports hold the league's practices, not just headers
    Given I am in the demo league
    When I download the master schedule CSV from the demo's exports page
    Then the master CSV holds one weekly practice for each of the demo's 4 teams
    And the U4 cohorts' practices are on Saturday morning, 30 minutes each, 15 minutes apart
