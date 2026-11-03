Feature: Play-up by request, listed for admins
  As a league administrator
  I want players to play in their own age division unless a play-up was requested
  So that I see every play-up and play-down and decide each against my club's own rules

  docs/changes/2026-10-27-play-up-by-request.md. The import carries a play-up column; the Teams
  page seats a requested play-up in the older division the player registered for and an
  unrequested one in their own age division, and its Play-up section lists both with the facts an
  admin needs. The app approves or refuses nothing. Given steps seed the import (an input the
  page reads); every Then reads the DOM. Ages are counted in season 2026 by birth year: born in
  2016 is 10, in 2014 is 12. The unit and page tests cover the waitlist exception and the cases
  with a coach or a buddy; the seeded league has neither.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: A requested play-up plays up, an unrequested one plays in their own division, and both are listed
    Given the U12 Boys import lists Pia, who asked to play up, and Quinn, who did not, both aged 10, with 8 players aged 12
    And the U10 Boys import lists 8 players aged 10
    When I open the Teams page
    And I press "Generate Teams" on the Teams page
    Then the Play-up section lists Pia as a requested play-up that plays in U12 Boys
    And the Play-up section lists Quinn as registered in U12 Boys but playing in U10 Boys with no request
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme
    And Pia is on a U12 Boys team and Quinn is on no U12 Boys team

  Scenario: The overview, the Play-up section and the roster list count the same play-ups
    Given the U12 Boys import lists Pia, who asked to play up, and Quinn, who did not, both aged 10, with 8 players aged 12
    And the U10 Boys import lists 8 players aged 10
    And the season has the program "Junior" holding "U10 Boys", a division for ages 9 to 10
    And the season has the program "Senior" holding "U12 Boys", a division for ages 11 to 12
    And the import is stored as players, with the age and play-up request each row carries
    When I open the Teams page
    Then the Division Overview reads "1 playing up" for "U12 Boys"
    And the Division Overview reads "None" for "U10 Boys"
    And the Division Overview heading reads "Junior: 0 playing up, 0 playing down (1 moved in from another program)"
    And the Division Overview heading reads "Senior: 1 playing up, 0 playing down"
    And the Division Overview league line reads "League: 1 playing up, 0 playing down."
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme
    When I press "Generate Teams" on the Teams page
    Then the Play-up section reads "1 playing up (1 requested), 0 playing down, 1 moved to their own age division"
    And axe finds no serious or critical violations on "/teams" in the "dark" theme
    When I switch to the light theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "light" theme
    When I turn the Teams page to Edit Mode
    Then the play-up and play-down list says "Playing up: Pia Askedup (natural age 10) is on"
    And the play-up and play-down list says "in U12 Boys, a division for ages 11 to 12. A play-up was requested."
    And the Play-up section and the roster list count as many play-ups as the overview did
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme
