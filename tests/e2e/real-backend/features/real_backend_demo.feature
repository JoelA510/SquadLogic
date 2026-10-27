Feature: The demo league, on the real backend
  Demo mode D4 (docs/changes/2026-10-22-demo-mode.md; migrations 20261030010000 and
  20261031010000). The real product on the real stack: a visitor with no account is signed in
  anonymously (the local stack has anonymous sign-ins on and CAPTCHA off), gets a private copy of the
  full league, with the practice schedule of U4 and U5 to U8 already applied (migration 20261103010000;
  U9 and older are left for the auto-scheduler), schedules the rest, reads the whole schedule in its
  exports, changes where a player plays, is stopped from changing who a player is and from importing,
  and the purge then removes the copy and the visitor.

  Scenario: A visitor starts the demo, works in it, and the purge removes it
    Given I am signed out on the real-backend sign-in page
    When I try the demo
    Then the demo league is open with its timer
    And the visitor can read 128 teams, 1259 players and 251 coaches in it
    Then the demo starts with a practice for each U4 and U5 to U8 team and none for U9 and older
    When I auto-generate the practice schedule and apply it
    Then the U4 teams practise only in the four reserved Saturday sessions
    And the demo's master schedule export lists a practice for all 128 teams
    And the game page lists U4 as practice only
    When I change a demo player's status on the players page
    Then the server has the new status
    And the server refuses to rename a demo player
    When I try to browse for an import file in the demo
    Then the import notice opens instead of the file picker
    When the demo's time is up and the purge runs
    Then the demo league and its visitor are gone
