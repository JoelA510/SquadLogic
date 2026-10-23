Feature: Pillar 2 - Coach Daily Loop
  As a volunteer coach
  I want to easily manage my team's roster, schedule, and communications
  So that I can focus on coaching rather than administration

  Background:
    Given I am logged into SquadLogic as a "coach"
    And I have been assigned to the "U12 Tigers"

  Scenario: Viewing Team Roster
    Given my team has 12 players assigned
    When I view my Team Portal
    Then I should see a list of all players and their contact information
    And the roster shows no medical clearance status

  Scenario: Accessing Integrated Calendar
    Given my team has practices on Tuesdays and games on Saturdays
    When I access my personalized calendar feed URL
    Then I should see all my team events in my external calendar application
    And the feed should only contain data for my authorized team (no data leakage)

  Scenario: Communicating with Parents
    Given I need to announce a practice cancellation
    When I use the Team Communication tool
    Then a notification should be sent to all parents of players on my roster
    And I should be able to see a history of all sent messages
