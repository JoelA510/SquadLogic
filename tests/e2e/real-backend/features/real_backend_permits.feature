Feature: Field permits for a coach, on the real backend
  Phase C3 (docs/changes/2026-10-22-phase-c-permits.md; migration 20261102010000). The mock suite
  holds what the coach is shown; this holds what the real Storage and the real policies do, which a
  mock cannot: the signed link a coach asks for returns the file, a member who coaches no team is
  refused one, and the bucket refuses a file declared as text/html. It runs in a second
  organization the seed creates (the permit league), so the scenarios that import and schedule are
  untouched.

  Scenario: A coach's signed link returns the permit, and nobody else gets one
    Given the permit league's administrator has recorded a permit with a PDF for the field the Falcons play on
    Then the coach can make a signed link to the file, and the link returns the PDF
    And a member who coaches no team cannot make a signed link to it
    And the bucket refuses a file declared as text/html
    When the coach signs in
    Then the coach's home shows the permit, and the permits page opens its file through a signed link
