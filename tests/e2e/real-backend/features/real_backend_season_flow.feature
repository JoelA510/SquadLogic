Feature: From a registration export to a published practice schedule, on the real backend
  The core flow against the real stack: the import through import-validation
  and finalize_import_job, teams generated on the page and written by the
  team-persistence Edge Function, practices placed by the auto-scheduler and
  written by practice-persistence, the export built from what the database
  then returns, and its upload to the exports bucket (migration
  20261017000000), under the organization's folder. A publish is all or
  nothing: when one file is refused, the ones that uploaded are removed.

  Background:
    Given I am signed in as the seeded administrator

  Scenario: An administrator imports, generates teams, schedules practices and exports
    When I import the "full" registration export
    And I generate teams from the import and sync them to Supabase
    Then the teams page lists the synced teams after a reload
    When I auto-generate the practice schedule and apply it
    Then the master schedule export lists a practice for every synced team
    When an upload to Storage is refused for one team's file
    Then none of those files is left in the exports bucket
    When I upload the exports to Storage
    Then the exports bucket holds the master schedule and a file per synced team, under the organization's folder
