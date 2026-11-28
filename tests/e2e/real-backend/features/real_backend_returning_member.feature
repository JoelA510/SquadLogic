Feature: Returning to a club after signing out
  Scenario: An existing administrator signs back in from the dashboard
    Given I am signed in as the seeded administrator
    When I sign out and sign back in without reloading
    Then I am back on my club dashboard
