Feature: Sidebar Context Switching
  As a League Administrator
  I want to switch the active organization and season from the sidebar
  So that I can manage multiple leagues without navigating away from my current workflow

  Background:
    Given I am logged into SquadLogic as an "Admin"
    And I belong to organizations "SquadLogic FC" and "Metro City United"

  Scenario: Switching the active organization updates available seasons
    Given I am on the Dashboard page
    And the sidebar shows "SquadLogic FC" as the active organization
    When I click the "Active Organization" selector in the sidebar
    Then I should see a dropdown with "SquadLogic FC" and "Metro City United"
    When I select "Metro City United"
    Then the sidebar header should display "Metro City United"
    And the "Active Season" dropdown should update to show seasons for "Metro City United"
    And the dashboard data should refresh to show Metro City United data

  Scenario: Switching the active season
    Given I am on the Dashboard page
    When I click the "Active Season" selector in the sidebar
    Then I should see a dropdown with valid seasons for the current organization
    When I select a different season
    Then the season selector should display the selected season
    And the dashboard data should refresh to show data for the selected season

  Scenario: A stored season that is not the organization's falls back to its active season
    Given the localStorage contains a season ID that does not exist for "Metro City United"
    When I switch the active organization to "Metro City United"
    Then the active season should automatically select the active season for "Metro City United"
    And the stored season that names none of its seasons is not adopted

  Scenario: Context persists across navigation
    Given I have selected "Metro City United" as the active organization
    And a valid season is selected
    When I navigate to the "Team Management" page
    Then the sidebar should still show "Metro City United" as the active organization
    And the sidebar should still show the selected season
