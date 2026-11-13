Feature: Published games on the Game Scheduling page (schedule expansion, PR 3)
  As a League Administrator
  I want to mark the games families have been told about as Published
  So that a regeneration, a drag or a cancel cannot move them by accident, and allowing a change is a deliberate, recorded act

  A Published game is held where it is: it has no grip and no "Move to", regeneration carries it unchanged, and the
  database refuses to move or delete it. Turning Published ON needs nothing. Turning it OFF is "Allow changes": a reason
  from a short list, an optional note, and a tick.

  What a move does: since the save updates a game in place when the page names it by its id (F11-1), a game moved to
  another slot or week is still the same game. It keeps its id, its history and its place in the Published count (not
  Published until it is published again), and the page says so. A game that drops out of a regenerated schedule is the
  one case that leaves its history behind, and the page says that too. The mock client has no arm for the save over the
  Edge function, so a stand-in answers it the way the database does (a new run; a game named by its id updated in place,
  one without an id upserted on its matchup tuple, the rows the save does not name left in their older run), and the
  scenarios assert only what the page RENDERS after it reads the saved schedule again. What the page sends is held by
  tests/gameGridPublishedGuards.test.jsx and tests/gameSchedulingIdentity.test.jsx; the database's side by
  supabase/tests/game_published.sql and game_identity.sql in CI.

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
    And the history says a moved game keeps its history

  Scenario: Publishing a game again holds it again
    Given the "U10 Boys" division is Published
    And changes are allowed to the game "Lions" vs "Wolves"
    When I turn on the Published switch of the game "Lions" vs "Wolves" in the list
    Then the notice says "Published 1 game."
    And the Published line reads "4 of 5 saved games Published, 0 with changes allowed"
    And the game "Lions" vs "Wolves" is shown as "Published" in the list
    When I enter manual override on the Game Scheduling page
    Then the card of "Lions" vs "Wolves" is Published and cannot be dragged or moved

  Scenario: A game moved to another slot is the same game: it keeps its history and stays not Published
    Given the "U10 Boys" division is Published
    When I allow changes to the game "Lions" vs "Wolves" for "Field change" with the note ""
    And I enter manual override on the Game Scheduling page
    Then the card of "Lions" vs "Wolves" can still be moved
    When I move the game "Lions" vs "Wolves" to the empty slot on "North Field" with its Move to list
    Then the Games page says "keeps its history and stays not Published until you publish it again"
    When I apply the staged game schedule
    Then the Games page says "Game schedule applied through the persistence workflow."
    And the Published line reads "3 of 5 saved games Published, 1 with changes allowed"
    And the game "Lions" vs "Wolves" is now in the empty slot on "North Field" as the same game that is "Changes allowed"
    And the place where "Lions" vs "Wolves" was saved is empty
    And the other Published games are still Published in their own places

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

  # PR 8: one game added by hand. A dialog takes a division, two teams, and an open slot or a new time; it stages a game
  # placed by hand into the review, and Apply saves it like a move (a new time's slot is found or made first, by the
  # mock's own ensure_game_slot). A double booking is flagged, not blocked; a Published game's slot is refused; the new
  # game starts not Published. What the page sends, and the plants, are held by tests/gameAddByHand.test.jsx.

  Scenario: A game added by hand in an open slot is staged, applied, and saved not Published
    When I open the Game Scheduling page and wait for its saved games
    And I add the game "Lions" vs "Bulls" in "U10 Boys" in the open slot on "North Field"
    Then the Games page says "Lions vs Bulls added to the review as a game placed by hand. It starts not Published."
    When I apply the staged game schedule
    Then the Published line reads "0 of 6 saved games Published, 0 with changes allowed"
    And the game "Lions" vs "Bulls" is shown as "Not published" in the list

  Scenario: A game added by hand at a new time that double-books is flagged, not blocked, and its slot is made on Apply
    When I open the Game Scheduling page and wait for its saved games
    And I fill in the game "Lions" vs "Bulls" in "U10 Boys" at "South Field" on "2026-10-03" from "09:30" to "10:30"
    Then the Add a game dialog flags "Lions already plays Lions vs Wolves at that time."
    And the Add a game dialog flags "South Field already has Comets vs Bulls at that time."
    When I add the game to the review
    Then the conflict banner lists a double booking
    When I apply the staged game schedule
    Then the Published line reads "0 of 6 saved games Published, 0 with changes allowed"
    And the game "Lions" vs "Bulls" is shown as "Not published" in the list

  Scenario: A game cannot be added in the slot of a Published game
    Given the "U10 Boys" division is Published
    When I fill in the game "Hawks" vs "Owls" in "U12 Girls" at "North Field" on "2026-10-03" from "09:00" to "10:00"
    Then the Add a game dialog refuses with "Lions vs Wolves is Published in that slot"
    And the game cannot be added to the review

  Scenario: The Add a game dialog passes axe in both themes
    When I open "/schedule/game" and see its "Game Scheduling" heading
    And I fill in the game "Lions" vs "Bulls" in "U10 Boys" at "South Field" on "2026-10-03" from "09:30" to "10:30"
    Then axe finds no serious or critical violations on "/schedule/game" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "Add a game to the review" on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "dark" theme

  Scenario: In Manual Override, a game added at a new time is on the grid in its pending slot, and the grid passes axe in both themes
    When I open "/schedule/game" and see its "Game Scheduling" heading
    And I enter manual override on the Game Scheduling page
    And I fill in the game "Lions" vs "Bulls" in "U10 Boys" at "North Field" on "2026-10-24" from "09:00" to "10:00"
    And I add the game to the review
    Then the added game has a card on the grid in its new time on "North Field"
    And axe finds no serious or critical violations on "/schedule/game" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "(new time, made on Apply)" on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "dark" theme
