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
    And I start the demo from the entry page
    Then the demo league is open
    And the header shows the demo timer counting down
    And the demo league lists 16 players

  # The season choice (docs/changes/2026-11-01-demo-season-selection.md): the same league dated in a
  # fall window or a spring window, chosen at entry, the date's own preselected.

  Scenario: The visitor is asked for a season first, with the one the date calls for chosen
    Given I am signed out on the sign-in page
    When I choose "Try the demo" on the sign-in page
    Then the demo entry page asks for a fall or a spring season
    And the season the date calls for is already chosen
    And no demo has started

  Scenario: A visitor can choose the season with the keyboard
    Given I am signed out on the sign-in page
    When I open the demo entry page
    And I move to the other season on the demo entry page with the arrow keys
    Then the other season is chosen
    And no demo has started

  Scenario: A visitor who chooses the fall gets a fall league
    Given I am signed out on the sign-in page
    When I open the demo entry page
    And I choose the "Fall season" on the demo entry page
    And I start the demo from the entry page
    Then the demo league is open
    And the header names the "Fall" season
    When I open the Season and Calendar settings
    Then the demo season is listed as the "fall" window with its dates

  Scenario: A visitor who chooses the spring gets a spring league
    Given I am signed out on the sign-in page
    When I open the demo entry page
    And I choose the "Spring season" on the demo entry page
    And I start the demo from the entry page
    Then the demo league is open
    And the header names the "Spring" season
    When I open the Season and Calendar settings
    Then the demo season is listed as the "spring" window with its dates

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
    And I start the demo from the entry page
    Then the demo league is open

  Scenario: Leaving the demo signs the visitor out
    Given I am in the demo league
    When I choose "Leave demo"
    Then I am back on the sign-in page, signed out

  Scenario: A full demo leaves the visitor on the entry page, signed out, with the reason announced
    Given the demo is full
    When I open the demo entry page
    And I start the demo from the entry page
    Then I stay on the entry page and it says the demo is busy
    And I am signed out

  Scenario: A demo's exports hold the league's practices, not just headers
    Given I am in the demo league
    When I download the master schedule CSV from the demo's exports page
    Then the master CSV holds one weekly practice for each of the demo's 2 scheduled teams
    And the U4 cohorts' practices are on Saturday morning, 30 minutes each, 15 minutes apart
