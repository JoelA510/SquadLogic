Feature: Player import against the real backend
  The import goes through the real Edge Function (import-validation) and the
  real finalize_import_job RPC, the path the July audit found the mock
  imitating wrongly (TG-6). A narrower re-import, the shape of a corrected
  GotSport export, must update the players it matches (migration
  20260726000300). No import stores a guardian's name or contact details: they
  stay on the league's registration platform (R0 of
  docs/changes/2026-10-22-admin-focus.md). Each import leaves its audit rows,
  written as the administrator: import-validation's (refused on every call
  until #577) and finalize_import_job's.

  Background:
    Given I am signed in as the seeded administrator

  Scenario: A narrower re-import updates the players it matches, and no import stores a guardian
    When I import the "full" registration export
    Then the import log reports 24 players inserted and 0 updated
    And the audit log records the import as the administrator
    When I import the "narrow" registration export
    Then the import log reports 0 players inserted and 24 updated
    And the audit log records the import as the administrator
    And no player row stores a guardian the full export named

  Scenario: Sensitive registration columns are never stored, through the app or around it
    When I import the "sensitive" registration export
    Then the app sent import-validation no sensitive column
    And no player or staged import row stores a sensitive column
    When I send the sensitive registration export straight to import-validation and apply it
    Then no player or staged import row stores a sensitive column
