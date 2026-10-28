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
    Then Pia is on a U12 Boys team and Quinn is on no U12 Boys team
    And the Play-up section lists Pia as a requested play-up that plays in U12 Boys
    And the Play-up section lists Quinn as registered in U12 Boys but playing in U10 Boys with no request
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme
