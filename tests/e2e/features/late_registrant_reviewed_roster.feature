Feature: A late registrant and a roster that has already been reviewed
  As a league administrator
  I want a registrant who signs up after teams were reviewed to be added without
  reshuffling the teams I already built
  So that coaches and families keep the roster they were told

  TG-3. The admin reaches this from the dashboard's "Re-run Teaming" (the Teams
  page offers its Generate control only while no team run exists). The re-run
  reads the saved teams back as a snapshot, so a reviewed roster keeps its team
  ids and players (docs/architecture/incremental-teaming-hardening.md). Given
  steps seed the saved teams and the import (inputs); every Then reads the DOM.

  Not covered, on purpose: a LOCKED team. The engine honours `team.locked`, but
  nothing in the product writes it (no `locked` column on `teams` or
  `team_players`, no RPC, Edge Function or page sets it; the remediation plan,
  "Discovered during execution", B5), so a scenario would test a state no user
  can create.

  Phase B3: a late registrant whose play-down is blocked (U12 in 2027 is born
  in 2015; one born in 2011 is 16) is never seated, and the review lists them
  under "Not placed" with the reason; the reviewed teams do not change. The
  review's lists are scanned with axe where they are rendered: the first
  scenario's season has no year, so every player is flagged "Eligibility not
  checked" there; the second lists a player not placed, in both themes.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And the U12 Boys roster was saved as the teams Falcons and Herons with three players each
    And a late registrant appears in the latest import

  Scenario: A late registrant is seated on a saved team and nobody else moves
    When I re-run teaming from the dashboard workflow
    Then the page reports 2 saved teams kept and 1 late player seated
    And all 7 players are assigned and none is left for manual review
    And all 7 players are flagged "Eligibility not checked" and none is held off a team
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme
    And the saved teams keep their ids and original players
    And the late registrant is on exactly one of them

  Scenario: A late registrant too old for the division is listed as not placed and nobody moves
    Given the season is 2027 and the late registrant was born in 2011
    When I re-run teaming from the dashboard workflow
    Then the page reports 2 saved teams kept and 0 late players seated
    And the late registrant is listed under "Not placed" as too old for the division
    And axe finds no serious or critical violations on "/teams" in the "light" theme
    When I switch to the dark theme on this page
    Then axe finds no serious or critical violations on "/teams" in the "dark" theme
    And the saved teams keep their ids and original players
    And the late registrant is on none of them
