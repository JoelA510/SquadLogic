Feature: Published games on the Game Scheduling page (schedule expansion, PR 3)
  As a League Administrator
  I want to mark the games families have been told about as Published
  So that a regeneration, a drag or a cancel cannot move them by accident, and allowing a change is a deliberate, recorded act

  A Published game is held where it is: it has no grip and no "Move to", regeneration carries it unchanged, and the
  database refuses to move or delete it. Turning Published ON needs nothing. Turning it OFF is "Allow changes": a reason
  from a short list, an optional note, and a tick.

  What this feature does NOT assert, because it is not true: that a game's Published state, its date or its history
  follows it to another slot or week. The save keys a game on (home, away, slot, week) and writes no id, so a game moved
  to another slot or week is saved as a new game that starts not Published, and the page says so. The save is answered
  by a stand-in here (the mock client has no arm for `persist_game_schedule`), so these scenarios read what the page
  SENDS and what it SAYS; the database's side is held by supabase/tests/game_published.sql in CI.

  The league: U10 Boys (Lions, Wolves, Comets, Bulls) with four saved games, U12 Girls (Hawks, Owls) with one, on two
  fields at two venues; two slots are empty (week 3).

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a club with a saved game schedule in two divisions

  Scenario: Publishing a division holds its games where they are, and leaves the other division movable
    When I open the Game Scheduling page and wait for its saved games
    Then the Published line reads "0 of 5 saved games Published, 0 with changes allowed"
    When I publish the "U10 Boys" division from the bulk bar
    Then the Published line reads "4 of 5 saved games Published, 0 with changes allowed"
    And the notice says "Published 4 games."
    And the game "Lions" vs "Wolves" is shown as "Published" in the list
    And the game "Hawks" vs "Owls" is shown as "Not published" in the list
    When I enter manual override on the Game Scheduling page
    Then the card of "Lions" vs "Wolves" is Published and cannot be dragged or moved
    And the card of "Hawks" vs "Owls" can still be moved
    When I try to drag the card of "Lions" vs "Wolves" onto an empty slot
    Then the card of "Lions" vs "Wolves" is still in its cell and nothing is staged

  Scenario: Allowing changes needs a reason and a tick, and the history shows it
    Given the "U10 Boys" division is Published
    When I allow changes to the game "Lions" vs "Wolves" for "Coach request" with the note "The coach asked for a later start"
    Then the Published line reads "3 of 5 saved games Published, 1 with changes allowed"
    And the game "Lions" vs "Wolves" is shown as "Changes allowed" in the list
    When I open the history of the game "Lions" vs "Wolves"
    Then the history shows "Changes allowed" with the reason "Coach request" and the note "The coach asked for a later start"
    And the history says a moved game is a new record

  Scenario: A game moved to another slot is saved as a new game that starts not Published
    Given the "U10 Boys" division is Published
    When I allow changes to the game "Lions" vs "Wolves" for "Field change" with the note ""
    And I enter manual override on the Game Scheduling page
    Then the card of "Lions" vs "Wolves" can still be moved
    When I move the game "Lions" vs "Wolves" to the empty slot on "North Field" with its Move to list
    Then the Games page says "will be saved as a new game, which starts not Published"
    When I apply the staged game schedule
    Then the Games page says "1 moved game was saved as a new game: it starts not Published, so publish it again."
    And the save carried "Lions" vs "Wolves" in the empty slot
    And the save carried the Published games exactly where they were

  Scenario: Regenerating keeps the Published games where they are
    Given the "U10 Boys" division is Published
    When I note where the Published games are in the list
    And I generate a new game schedule
    Then the Games page says "4 Published games kept as they are."
    And the Published games are where they were

  Scenario: The Games page with Published and released games passes axe in both themes
    Given the "U10 Boys" division is Published
    And changes are allowed to the game "Lions" vs "Wolves"
    When I open "/schedule/game" and see its "Game Scheduling" heading
    Then the scan sees "1 with changes allowed" on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "1 with changes allowed" on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "dark" theme

  Scenario: The Allow changes dialog passes axe in both themes
    Given the "U10 Boys" division is Published
    When I open "/schedule/game" and see its "Game Scheduling" heading
    And I open the "Allow changes to Published games" dialog with "Allow changes: Lions versus Wolves"
    Then axe finds no serious or critical violations on "/schedule/game" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "Allow changes to Published games" on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "dark" theme

  Scenario: The grid with Published cards passes axe in both themes
    Given the "U10 Boys" division is Published
    When I open "/schedule/game" and see its "Game Scheduling" heading
    And I enter manual override on the Game Scheduling page
    Then the scan sees "Published: allow changes to move it." on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Published: allow changes to move it." on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "dark" theme
