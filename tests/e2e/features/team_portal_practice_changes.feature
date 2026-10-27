Feature: Team portal shows saved practice changes
  As a league admin
  I want the team portal to show a moved practice and a TIME TBD date
  So that I never go to a practice at the wrong time or place

  # 8.6 3b PR 12c (docs/PHASE_8_6_PR12_READERS_PLAN.md §6): the portal applies
  # saved practice exceptions. The RSVP checks (Q3, Q4) went with RSVP itself
  # (20261022030000; docs/changes/2026-10-22-admin-focus.md, R2). The persona
  # is an admin: no coach signs in (docs/changes/2026-10-27-admin-only.md).

  Background:
    Given I am logged into SquadLogic as an "admin"
    And I have an organization labeled "Test Org"
    And the "Tigers" team has the player "Alex"

  Scenario: An admin sees a moved practice and a TIME TBD date
    Given the "Tigers" have a Monday practice with one week moved and one week TIME TBD
    And I am on the "Team Portal" page for the "Tigers"
    Then I should see the moved practice at its new time and place with one "Moved from" line
    And I should see the TIME TBD date with its reason

  # A weekly 02:30 series across the spring-forward date: the date has no 02:30,
  # and the portal says so as the calendar feed does (it showed 02:30 before).
  Scenario: An admin sees the spring-forward date as TIME TBD
    Given the "Tigers" have a Sunday 02:30 practice series across the spring-forward date
    And I am on the "Team Portal" page for the "Tigers"
    Then I should see the spring-forward date as TIME TBD with its reason
    And I should see an ordinary Sunday of the series at 02:30

  # R2 (docs/changes/2026-10-22-admin-focus.md): availability marking (RSVP)
  # and team chat are removed; the team page shows the schedule without them.
  Scenario: The team page shows the schedule without RSVP or team chat
    Given the team has a practice series on Tuesdays
    And I am on the "Team Portal" page for the "Tigers"
    Then I should see the Tuesday practices on the team schedule
    And I should see no RSVP controls and no team chat
