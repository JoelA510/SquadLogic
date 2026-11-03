Feature: Data Import points to where practice preferences are imported
  As a league administrator
  I want Data Import to tell me where a coach preference file is imported
  So that I do not look for a file type that is not there, and land on the right tab

  docs/changes/2026-11-02-preference-followups.md, item 2 (no migration). Practice preferences have
  their own importer, the Import a file tab of the Practice preferences page (C2): Data Import does not
  gain a second one, it carries a card that says where it is and links to that tab. The card is shown
  only where the page it points to is reachable (an admin; the unit tests cover the roles and the
  feature flag that cannot be signed in as here). The words are read from the DOM.

  Background:
    Given I am logged into SquadLogic as an "admin"

  Scenario: Data Import says where preferences are imported and the link opens that tab
    When I open "/import" and see its "Data Import" heading
    Then Data Import points to the Import a file tab of Practice preferences
    When I follow the pointer to the Practice preferences import
    Then the practice preferences page is open on its "Import a file" tab

  Scenario: The pointer works from the keyboard
    When I open "/import" and see its "Data Import" heading
    And I reach the pointer with the keyboard and press Enter
    Then the practice preferences page is open on its "Import a file" tab

  Scenario: The pointer passes axe in the light and dark themes
    When I open "/import" and see its "Data Import" heading
    Then the scan sees "Practice preferences are imported on their own page" on the page
    And axe finds no serious or critical violations on "/import" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Practice preferences are imported on their own page" on the page
    And axe finds no serious or critical violations on "/import" in the "dark" theme
