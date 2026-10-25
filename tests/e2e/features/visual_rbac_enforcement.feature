Feature: Visual Role-Based Access Control
  As a restricted user (a Coach)
  I want the UI to hide administrative controls
  So that I am not confused by actions I cannot perform

  Scenario: Coach Visual UI Restrictions in Sidebar
    Given I am logged into SquadLogic as a "Coach"
    When I view the main navigation Sidebar
    Then I should see links for "My Dashboard", "My Team", and "Practices"
    But I should NOT see links for "Import", "Settings", or "Players"

  Scenario: Admin Coach Review Page
    Given I am logged into SquadLogic as an "Admin"
    And I am on the "Coaches" page
    Then I should see the text "registered"
    And I should see the text "Mock Coach"
    And I should see the text "Morgan Reyes"

  Scenario: Admin Coach Lead Promotion and Assignment
    Given I am logged into SquadLogic as an "Admin"
    And I am on the "Coaches" page
    When I promote "Morgan Reyes" from the Coaches page
    And I assign "Morgan Reyes" to "Tigers" from the Coaches page
    Then the coach row for "Morgan Reyes" should show team "Tigers"

  # A coach of neither team in the game (the parent persona until R3,
  # 20261024010000, removed the role).
  Scenario: Score Entry Restrictions in League Standings
    Given I am logged into SquadLogic as a "Coach"
    And I navigate to the "League Standings" page
    When I view the "Recent Games" section
    Then I should see the final scores of past games
    But the score inputs and "Save" buttons should be hidden on the game I do not coach
