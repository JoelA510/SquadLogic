Feature: Field permits for league admins, on the real backend
  Phase C3 (docs/changes/2026-10-22-phase-c-permits.md; migration 20261102010000), as
  docs/changes/2026-10-27-admin-only.md made it the admins': no coach signs in. The mock suite holds
  what the admin is shown (permits_page.feature); this holds what the real Storage and the real
  policies do, which a mock cannot: the signed link an administrator or a staff member asks for
  returns the file, an account with no membership is refused one, and the bucket refuses a file
  declared as text/html. It runs in a second organization the seed creates (the permit league), so
  the scenarios that import and schedule are untouched.

  Scenario: An admin's signed link returns the permit, and nobody outside the league gets one
    Given the permit league's administrator has recorded a permit with a PDF for a field
    Then the administrator and the staff member can make a signed link to the file, and the link returns the PDF
    And an account with no membership cannot make a signed link to it
    And the bucket refuses a file declared as text/html
    When the administrator signs in
    Then the permits page lists the permit, and opens its file through a signed link
