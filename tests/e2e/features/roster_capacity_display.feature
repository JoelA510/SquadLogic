Feature: Capacity on saved rosters
  Scenario: Dashboard shows the selected division's saved team size
    Given I am logged into SquadLogic as an "Admin"
    And an organization and season are active
    And the season has two junior teams capped at fourteen with twenty-five assigned players
    When I open the admin home
    Then the junior division on the home page shows "25/28 · 89%"
    When I switch to the dark theme on this page
    Then the junior division on the home page shows "25/28 · 89%"

  Scenario: Workflow uses the capacity of the saved team run
    Given I am logged into SquadLogic as an "Admin"
    And an organization and season are active
    And the season has two junior teams capped at fourteen with twenty-five assigned players
    When I view the Dashboard page
    Then the junior division in the teaming overview shows "89%" utilization
    When I switch to the dark theme on this page
    Then the junior division in the teaming overview shows "89%" utilization
