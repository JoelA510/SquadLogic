Feature: Network Resilience and Offline Recovery
  As a coach or admin in the field
  I want the application to handle network drops gracefully
  So that I do not lose my roster or schedule edits when my connection drops

  Scenario: Graceful failure when persistence edge function times out
    Given the season "Fall 2025" is active and schedules are published
    And I am logged into the SquadLogic dashboard as an "Admin"
    And I navigate to the "Team Management" page
    Given the user has modified the "U10 Lightning" roster
    When the application attempts to sync the changes
    And the network connection drops or the API returns a 504 Timeout
    Then the user should see a "Sync Failed - Retrying..." banner
    And the "U10 Lightning" card should remain in its newly modified state locally