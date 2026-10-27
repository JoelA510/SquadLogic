Feature: Calendar Sync
  As a league admin
  I want a unique calendar subscription link for a team
  So that I can hand it to the team's coach or families to sync its events to their calendar

  Background:
    Given I am logged into SquadLogic as an "admin"
    And I have an organization labeled "Test Org"
    And the "Tigers" team has the player "Alex"
    And I am on the "Team Portal" page for the "Tigers"
    
  Scenario: Copying the Calendar Sync Link
    When I click the "Subscribe to Calendar" button
    Then a modal should appear displaying a subscription link
    And the link should contain "calendar-feed"
    And the link should contain a secure "token" query parameter
    And I should be able to click a button to copy the link to my clipboard
