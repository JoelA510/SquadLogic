Feature: App Shell Visuals and Responsiveness
  As a user on various devices
  I want the application shell to adapt to my screen and preferences
  So that I can navigate easily and recover from errors

  Scenario Outline: Mobile Sidebar Navigation at <width> pixels
    Given I am logged into SquadLogic as "admin"
    And I am using a <width>-pixel-wide viewport
    When I view the Dashboard
    Then the sidebar should be hidden by default
    When I click the "Hamburger Menu" icon
    Then the sidebar overlay should slide into view
    When I click a navigation link like "Teams & Rosters"
    Then the sidebar overlay should automatically close
    When I switch to the dark theme on this page
    Then the sidebar should be hidden by default
    When I click the "Hamburger Menu" icon
    Then the sidebar overlay should slide into view

    Examples:
      | width |
      | 375   |
      | 900   |

  Scenario: Desktop sidebar remains available for keyboard navigation
    Given I am logged into SquadLogic as "admin"
    And I am using a 901-pixel-wide viewport
    When I view the Dashboard
    Then the desktop navigation is available from the account menu by keyboard

  Scenario: Global Error Boundary Fallback
    Given I am logged into SquadLogic as "admin"
    And I navigate to the Dashboard
    When a React component throws an unexpected rendering error
    Then the application should not show a blank white screen
    And I should see the "Something went wrong" glassmorphism error panel
    And I reset error flags and click "Return Home"
    Then I should be safely redirected to the Dashboard