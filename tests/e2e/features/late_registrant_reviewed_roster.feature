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

  Background:
    Given I am logged into SquadLogic as an "admin"
    And the "U12 Boys" roster was saved as the teams "Falcons" and "Herons" with three players each
    And a late registrant appears in the latest import

  Scenario: A late registrant is seated on a saved team and nobody else moves
    When I re-run teaming from the dashboard workflow
    Then the page reports 2 saved teams kept and 1 late player seated
    And all 7 players are assigned and none is left for manual review
    And the saved teams keep their ids and original players
    And the late registrant is on exactly one of them

  Scenario: A late registrant is not forced onto locked teams
    Given every saved team is locked
    When I re-run teaming from the dashboard workflow
    Then the page reports 2 saved teams kept and 0 late players seated
    And 6 players are assigned and 1 is left for manual review
    And the saved teams keep their ids and original players
    And the late registrant is on none of them
