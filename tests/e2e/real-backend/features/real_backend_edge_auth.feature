Feature: The Edge Functions refuse a caller with no session, on the real backend
  What tests/integration/staging.test.js checked against production and could
  not fail (plan item M4.5), held here against the local stack this branch
  builds. The functions are read from supabase/config.toml, so one added there
  is covered without being listed here. Its CORS preflight check is not held
  here: the local stack answers a preflight with the headers allowed even when
  a function's own CORS headers drop them (run 38518016051), so it could not
  fail.

  Scenario: Every gated function refuses a caller with no session, and the public feed answers
    When I call, as a caller with no session, every function the Supabase config marks verify_jwt
    Then each one refuses it itself, as unauthorized
    And calendar-feed, which config.toml leaves open, answers an unknown token with a 404
