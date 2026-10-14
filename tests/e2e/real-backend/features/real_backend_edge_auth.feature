Feature: The Edge Functions refuse a caller with no session, on the real backend
  What tests/integration/staging.test.js checked against production and could
  not fail (plan item M4.5), held here against the local stack this branch
  builds: every function supabase/config.toml marks verify_jwt refuses a
  request that carries only the anon key, and answers a CORS preflight.

  Scenario Outline: <function> refuses a request without a user's token
    When I post to the "<function>" Edge Function with only the anon key
    Then the Edge Function refuses it as unauthenticated

    Examples:
      | function             |
      | import-validation    |
      | team-persistence     |
      | practice-persistence |
      | game-persistence     |
      | auto-scheduler       |
      | fairness-scoring     |

  Scenario: team-persistence answers a CORS preflight from the app
    When I send a CORS preflight to the "team-persistence" Edge Function
    Then the preflight is allowed
