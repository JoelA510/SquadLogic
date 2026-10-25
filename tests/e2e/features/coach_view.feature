Feature: The coach view
  As a coach
  I want my own schedule, my team, and the teams and coaches of my division on my home
  So that I can run my team without the league's admin tools

  Admin focus R6 (docs/changes/2026-10-22-admin-focus.md; migration 20261028010000):
  scheduling, score entry, standings and lighting are an admin's; a coach keeps
  practice preferences, and sees team and coach names only, never a contact.

  Scenario: A coach's home shows their team, their schedule and their division
    Given I am logged into SquadLogic as a "coach"
    And Team A has an upcoming game and a weekly practice
    When I go to "/"
    Then my dashboard lists my team "Team A"
    And my schedule lists the game "vs Team B" and the practices of "Team A"
    And my division lists "Team B" coached by "Casey Rivera" and "Tigers" with no coach
    And my dashboard shows no email address or phone number
    And my dashboard offers no schedule editing, score entry or standings

  Scenario: My Team opens the coach's team, and practice preferences stay
    Given I am logged into SquadLogic as a "coach"
    When I follow "My Team" in the coach navigation
    Then I am on the team page of "Team A"
    And the coach navigation offers "Practice Preferences"
    And the coach navigation offers no "Practices"
    And the coach navigation offers no "Game Schedule"
    And the coach navigation offers no "Standings"
    And the coach navigation offers no "Practice Lighting"
