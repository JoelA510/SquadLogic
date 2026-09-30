Feature: Team portal shows saved practice changes
  As a parent
  I want the team portal to show a moved practice and a TIME TBD date
  So that I never go to a practice at the wrong time or place

  # 8.6 3b PR 12c (docs/PHASE_8_6_PR12_READERS_PLAN.md §6): the portal applies
  # saved practice exceptions. RSVP is hidden on TIME TBD dates (Q3).

  Background:
    Given I am logged into SquadLogic as a "parent"
    And I have an organization labeled "Test Org"
    And my child "Alex" is on the "Tigers" team

  Scenario: A parent sees a moved practice and a TIME TBD date
    Given the "Tigers" have a Monday practice with one week moved and one week TIME TBD
    And I am on the "Team Portal" page for the "Tigers"
    Then I should see the moved practice at its new time and place with one "Moved from" line
    And I should see the TIME TBD date with its reason
    And RSVP should be hidden on the TIME TBD date
    And RSVP should be open on an unchanged practice of the same series
