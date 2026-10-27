Feature: Ingestion Hardening for CSV Imports
  As a system administrator
  I want a robust CSV import-to-profile pipeline
  So that I can safely load external GotSport data without crashing the system

  Background:
    Given I am logged into SquadLogic as an "admin"
    And I have navigated to the Data Import page
    And a valid GotSport player CSV file exists

  Scenario: Validating required fields during import
    Given I upload the GotSport player CSV file
    When the file is missing a required column such as 'first_name' or 'last_name'
    Then the system should reject the file completely
    And present a clear validation error to the user in the UI

  Scenario: Graceful error recovery for row-level issues
    Given I upload the GotSport player CSV file with valid headers
    When a specific row has malformed data (e.g. invalid date of birth)
    Then the system should flag the row as an error
    And load the remaining valid rows into the staging table
    And present an interface to manually correct the malformed row

  Scenario: Materializing reciprocal buddy requests during player import
    Given I upload a GotSport player CSV file with reciprocal buddy requests
    When I apply the player CSV import
    Then the player import should materialize reciprocal buddy pairs

  Scenario: Continuing from an applied player import keeps it for teaming
    Given the season has no team run yet
    And I upload a GotSport player CSV file with reciprocal buddy requests
    When I apply the player CSV import
    And I continue from the applied import
    Then the Teams page offers to generate teams for the imported "U8 Coed" program

  Scenario: Applying and rolling back a coach CSV import
    Given I upload a valid GotSport coach CSV file
    When I apply the coach CSV import
    Then the coach CSV import should update the coach database
    When I roll back the coach CSV import
    Then the imported coach should be removed from the coach database

  # S7 of docs/changes/2026-10-27-admin-only.md: players first, then the coaches, whose file names
  # their children by registration id. Only such a link anchors a team (owner decision 8a).
  Scenario: A coach import links the coach to their children and the child anchors the coach's team
    Given the season has no team run yet
    And I upload a GotSport player CSV file of four children with registration ids
    When I apply the player CSV import
    And I upload a coach CSV file that names one of those children and one unknown id
    And I apply the coach CSV import
    Then the import log reports 1 child link written and the unknown registration id
    When I continue from the applied import
    And I press "Generate Teams" on the Teams page
    Then the Teams page reports that the one team has a coach

  Scenario: The coach import says players are imported before coaches
    When I choose the coach import
    Then the page says to import players first

  Scenario: Applying and rolling back a field slot CSV import
    Given I upload a valid field slot CSV file
    When I apply the field slot CSV import
    Then the field slot CSV import should update the facilities database
    When I roll back the field slot CSV import
    Then the imported field slot should be removed from the facilities database

  Scenario: Deferring and then applying a field slot CSV import
    Given I upload a valid field slot CSV file
    When I validate the field slot CSV import for later review
    Then the field slot CSV import should be ready to apply without changing facilities
    When I apply the reviewed field slot CSV import
    Then the field slot CSV import should update the facilities database
