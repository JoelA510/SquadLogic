Feature: Visual Role-Based Access Control
  As a restricted user (a Coach)
  I want the UI to hide administrative controls
  So that I am not confused by actions I cannot perform

  Scenario: Coach Visual UI Restrictions in Sidebar
    Given I am logged into SquadLogic as a "Coach"
    When I view the main navigation Sidebar
    Then I should see links for "My Dashboard", "My Team", and "Practice Preferences"
    But I should NOT see links for "Import", "Settings", or "Players"
    # R6 (20261028010000): scheduling, standings and lighting are an admin's.
    And I should NOT see links for "Game Schedule", "Standings", or "Practice Lighting"

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

  # Score entry and standings are admin functions the league turns on (R6,
  # 20261028010000): a coach is sent home from both, their own team's games
  # included, even with the settings on.
  Scenario: Score Entry Restrictions in League Standings
    Given I am logged into SquadLogic as a "Coach"
    And the league has turned on score entry and standings
    When I navigate to the "League Standings" page
    Then I should be redirected to the Dashboard
    When I go to "/scores"
    Then I should be redirected to the Dashboard
