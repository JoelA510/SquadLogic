Feature: Field heat-stress (WBGT) forecast
  As a club admin planning a hot game day
  I want the forecast WBGT, alert band and Red/Black air-temperature triggers per venue
  So that I can plan before on-site readings are taken, knowing on-site readings govern

  The NWS API is stubbed with the Python reference's offline fixture (MTR forecast
  for 2026-10-03, issued 2026-10-02 01:31 PDT), and the browser clock is fixed, so
  every number is the reference's golden value. Every check is a DOM assertion.

  Scenario: An admin reads the forecast for a game day with no games scheduled
    Given I am logged into SquadLogic as an "admin"
    And the heat forecast is enabled with the reference venues seeded
    And the NWS API is stubbed with the reference forecast
    And the browser clock reads "2026-10-02T16:00:00Z"
    When I open the Heat Forecast page
    Then the on-site WBGT disclaimer is shown
    And the game day picker shows "2026-10-03"
    And "Canyon MS" at "11:00" reads WBGT "77.3" in band "Yellow"
    And "Canyon MS" at "14:00" reads WBGT "80.9" in band "Yellow"
    And "Vannoy ES" at "08:00" reads WBGT "62.0" in band "Green"
    And "Vannoy ES" at "14:00" reads WBGT "80.0" in band "Yellow"
    And "Canyon MS" at "13:00" has a Black trigger of "94.6"
    And the NWS forecast update and retrieval times are shown
    And no stale-forecast warning is shown
    And "Parking Lot Pitch" is listed as not computed because it has no coordinates
    And the sources panel cites the NWS API, Liljegren 2008 and the U.S. Soccer heat guidelines

  Scenario: A forecast older than the NWS refresh window is flagged stale
    Given I am logged into SquadLogic as an "admin"
    And the heat forecast is enabled with the reference venues seeded
    And the NWS API is stubbed with the reference forecast
    And the browser clock reads "2026-10-02T22:00:00Z"
    When I open the Heat Forecast page
    Then the stale-forecast warning is shown

  Scenario: An NWS refusal for one venue is shown in its rows, not hidden
    Given I am logged into SquadLogic as an "admin"
    And the heat forecast is enabled with the reference venues seeded
    And the NWS API is stubbed with the reference forecast
    And the NWS API refuses the point for "Vannoy ES" with a 404
    And the browser clock reads "2026-10-02T16:00:00Z"
    When I open the Heat Forecast page
    Then every "Vannoy ES" row is not computed, citing NWS 404
    And "Canyon MS" at "11:00" reads WBGT "77.3" in band "Yellow"

  Scenario: The heat forecast stays out of the way until an admin turns it on
    Given I am logged into SquadLogic as an "admin"
    When I open the Heat Forecast page
    Then the heat forecast says it is turned off
    And the side navigation has no Heat Forecast link
