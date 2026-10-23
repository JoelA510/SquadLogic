Feature: Pillar 2 - Coach Daily Loop
  As a volunteer coach
  I want to easily manage my team's roster and schedule
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

  # R2 (docs/changes/2026-10-22-admin-focus.md): availability marking (RSVP)
  # and team chat are removed; the team page shows the schedule without them.
  Scenario: The team page shows the schedule without RSVP or team chat
    Given my team has a practice series on Tuesdays
    When I view my Team Portal
    Then I should see the Tuesday practices on the team schedule
    And I should see no RSVP controls and no team chat
