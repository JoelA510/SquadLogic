Feature: Manual roster editor
  As a league administrator
  I want the Edit button on Teams & Rosters to open a readable, accessible roster editor
  So that I can see every player and coach by name and move players without dragging

  The demo league is a seeded team run: rosters and coaches are ids, and the names are in the
  players and coaches tables. The mock enforces the server's 1000-row cap (as PostgREST does), so a
  read that does not page, or a count that counts the rows it received, fails here too.

  Scenario: A league past the server row cap shows every player and coach by name
    Given I am in a demo league of 1100 players
    Then the sidebar badge for "Players" reads 1100
    When I open the roster editor
    Then the roster editor names the last player "Player1100 Demo1100"
    And no player in the roster editor is called "Unknown Player"
    And every coach line in the roster editor names its coach
    And no card in the roster editor has a scroll box of its own

  Scenario: A player moves to another team from the keyboard
    Given I am in a demo league of 40 players
    When I open the roster editor
    And I move "Player1 Demo1" from "U4 Team 1" to "U10 Team 3" with the keyboard
    Then "Player1 Demo1" is on the team "U10 Team 3" marked manual
    And "Player1 Demo1" is no longer on the team "U4 Team 1"
    And the keyboard focus is on the Move button of "Player1 Demo1"

  Scenario: The roster editor reflows at phone width without horizontal scrolling
    Given I am in a demo league of 40 players
    When I open the roster editor
    And the window is 400 pixels wide
    Then the page does not scroll sideways

  Scenario: The roster editor passes axe in the light and dark themes
    Given I am in a demo league of 40 players
    When I open the roster editor
    Then the scan sees "Manual Roster Management" on the page
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme

  Scenario: A demo league that has applied no schedule exports nothing and says why
    Given I am in a demo league of 40 players
    When I open the Exports page
    Then the Exports page says the demo data is placeholder data
    And the Exports page says no practices or games have been applied
    When I press "Generate CSVs"
    Then no export file is offered

  Scenario: The header's controls reflow at phone width instead of running off the edge
    Given I am in a demo league of 40 players
    When the window is 400 pixels wide
    And I open the Exports page
    Then every control in the header is on screen
    And the page does not scroll sideways
