Feature: Schedule reports on the Exports page (schedule expansion, PR 7)
  As a League Administrator
  I want a Day Sheet, a coach's schedule and a list of what changed since a publication
  So that I can print a day, send a coach their games, and see what moved or was cancelled after the files went out

  Three read-only views over the saved game schedule, each with a CSV file. Names only: no email or phone is read or
  shown (the coaches' rows in the mock database carry both, and the page must not reach for them).

  What this feature does NOT assert, because it is not true: that a moved game is "the same game". A baseline records
  each game's teams, slot and week, not which game is which, so a game moved to another slot or week is compared by that
  tuple. The Changes view shows the old place as no longer in the saved schedule and the new place as new, and says it
  does not link them.

  The league: U10 Boys (Lions, Wolves, Comets, Bulls) and U12 Girls (Hawks, Owls) on two fields at two venues. A
  baseline was published with four games and one game on the TIME TBD list. Since then Comets v Bulls was cancelled,
  Lions v Comets was moved to an empty slot (a new game, with changes allowed to the old one for a coach's request) and
  Wolves v Bulls was added. Alex Sample coaches the Lions and, as assistant, the Hawks, whose games overlap on the 3rd;
  Blake Sample is flagged "multi" on the Coaches page and coaches one team.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a club with a saved game schedule, two coaches and a published baseline

  Scenario: The Day Sheet lists a date's games, narrows to a venue and keeps the TIME TBD game apart
    When I open the Exports page and its "Day Sheet" report
    And I choose the date "2026-10-03" on the Day Sheet
    Then the Day Sheet lists 2 games, the first at "09:00" between "Lions" and "Wolves"
    And the TIME TBD game "Wolves" v "Bulls" is listed apart with its reason
    When I choose the venue "North Park" on the Day Sheet
    Then the Day Sheet lists 1 game
    And the Day Sheet says 1 game on this date is at another venue
    When I download the Day Sheet
    Then the downloaded file "day-sheet-2026-10-03-north-park.csv" has 1 game and the TIME TBD game

  Scenario: The coach schedule marks a coach on two teams and shows the clash and the practices
    When I open the Exports page and its "Coach schedule" report
    And I choose the coach "Alex Sample (2 teams)"
    Then the coach is marked as on more than one team
    And the coach schedule shows the Lions and the Hawks, games and practices
    And the coach schedule marks the overlap of the two games on the 3rd and of the two Tuesday practices
    And the page shows no email address or phone number
    When I choose the coach "Blake Sample (1 team)"
    Then the coach is not marked as on more than one team

  Scenario: Changes since publication lists a cancelled game, a moved game as two, a new game and the reason
    When I open the Exports page and its "Changes since publication" report
    And I choose the published baseline "v1"
    Then the summary reads "4 games then, 4 now: 2 unchanged, 0 changed, 2 no longer saved, 2 new"
    And the changes list "Comets" v "Bulls" as no longer in the saved schedule
    And the changes list "Lions" v "Comets" as no longer in the saved schedule with the reason "Coach request"
    And the changes list "Lions" v "Comets" as new
    And the changes list "Wolves" v "Bulls" as new
    And the changes say a moved game appears twice and is not linked

  Scenario: The Day Sheet passes axe in both themes
    When I open the Exports page and its "Day Sheet" report
    And I choose the date "2026-10-03" on the Day Sheet
    Then the scan sees "Saturday 2026-10-03, at all venues: 2 games." on the page
    And axe finds no serious or critical violations on "/exports" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Saturday 2026-10-03, at all venues: 2 games." on the page
    And axe finds no serious or critical violations on "/exports" in the "dark" theme

  Scenario: The coach schedule passes axe in both themes
    When I open the Exports page and its "Coach schedule" report
    And I choose the coach "Alex Sample (2 teams)"
    Then the scan sees "On more than one team" on the page
    And axe finds no serious or critical violations on "/exports" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "On more than one team" on the page
    And axe finds no serious or critical violations on "/exports" in the "dark" theme

  Scenario: Changes since publication passes axe in both themes
    When I open the Exports page and its "Changes since publication" report
    And I choose the published baseline "v1"
    Then the scan sees "Compared with published baseline v1" on the page
    And axe finds no serious or critical violations on "/exports" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Compared with published baseline v1" on the page
    And axe finds no serious or critical violations on "/exports" in the "dark" theme
