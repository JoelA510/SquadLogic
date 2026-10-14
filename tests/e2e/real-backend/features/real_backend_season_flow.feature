Feature: From a registration export to a published practice schedule, on the real backend
  The core flow against the real stack: the import through import-validation
  and finalize_import_job, teams generated on the page and written by the
  team-persistence Edge Function, practices placed by the auto-scheduler and
  written by practice-persistence, and the export built from what the
  database then returns.

  Background:
    Given I am signed in as the seeded administrator

  Scenario: An administrator imports, generates teams, schedules practices and exports
    When I import the "full" registration export
    And I generate teams from the import and sync them to Supabase
    Then the teams page lists the synced teams after a reload
    When I auto-generate the practice schedule and apply it
    Then the master schedule export lists a practice for every synced team
