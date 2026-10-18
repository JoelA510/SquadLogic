Feature: Facility Management CRUD
  As an admin of a youth sports league
  I want to be able to manage locations, fields, and field subunits
  So that I can assign practices and games to valid facility configurations

  Background:
    Given I am logged into SquadLogic as an "admin"
    And I have an organization labeled "Test Org"
    And I am on the "Field Management" page

  Scenario: Adding a new Location and Field with no subunits
    When I click the "Add Field" button
    And I select "+ Add New Location" from the Location dropdown
    And I enter "Main Complex" into the new location input
    And I enter "Field 1" into the Field Name input
    And I select "Grass" for Type
    And I select "11v11" for Size
    And I set the Priority to 5
    And I ensure "Supports Halves/Sub-fields" is disabled
    And I click "Save Field"
    Then I should see "Field 1" listed under "Main Complex" on the Field Management grid
    And "Field 1" should display "Grass", "11v11", and Priority "5"
    And "Field 1" should not display a subunit indicator

  Scenario: Editing a field to support halves
    Given a field "Field 1" at "Main Complex" exists without subunits
    When I click the "Edit" button for "Field 1"
    And I toggle "Supports Halves/Sub-fields" to ON
    And I click "Save Field"
    Then "Field 1" should display a subunit indicator like "A/B Halves Enabled"
    And the database should automatically contain field subunits "A" and "B" for "Field 1"

  Scenario: Switching halves off keeps the field's sub-surfaces
    Given a field "Halves Pitch" at "North Park" exists with subunits
    When I click the "Edit" button for "Halves Pitch"
    And I toggle "Supports Halves/Sub-fields" to OFF
    And I click "Save Field"
    Then "Halves Pitch" should not display a subunit indicator
    And "Halves Pitch" should still list its sub-surfaces "A" and "B"

  Scenario: Deactivating a field
    Given a field "Field 3" at "South Base" exists and is active
    When I click the "Edit" button for "Field 3"
    And I toggle "Active" to OFF
    And I click "Save Field"
    Then "Field 3" should display an "INACTIVE" badge on the grid

  Scenario: Data isolation across organizations
    Given another organization "Rival League" exists
    And "Rival League" has a location "Rival Complex" with field "Rival Field A"
    When I load the Field Management page
    Then I should not see "Rival Complex" in the Location dropdown
    And I should not see "Rival Field A" on the grid
