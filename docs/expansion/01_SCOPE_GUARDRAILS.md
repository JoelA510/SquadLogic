# Scope & Guardrails

## In-Scope Summary
Implementation of a production-grade sports management platform focusing on:
-   **Core Administration:** Organizations, Users, Roles, Permissions.
-   **Scheduling:** Advanced game/practice scheduling, conflict detection, facility management, calendar sync.
-   **Team Management:** Rostering, Team formation (manual + auto-draft), Availability tracking.
-   **Communication:** Email/SMS notifications (via providers), In-app alerts, Chat.
-   **Registration (Data Only):** Ingestion of registration data, custom forms (NO PAYMENTS).
-   **Reporting:** Standings, Stats, Usage analytics.

## Explicit Exclusions (Hard Constraints)
The following are **STRICTLY OUT OF SCOPE** and must not be implemented:
1.  **Website Offerings:** No hosting, CMS, website builders, or "public club site" generation.
2.  **Billing/Collection:** No collection of money from players/families/teams.
    *   *Allowed:* "My Usage/Billing" for the app customer (SaaS billing) and cost calculators.
3.  **Compliance Documents:** No storage/upload of sensitive documents (waivers, IDs, birth certs).
    *   *Allowed:* Boolean toggles (e.g., "Waiver Signed? [x]") and timestamp tracking.
4.  **Online Store/Merch:** No e-commerce or merchandise sales.
5.  **Sponsor Management:** No specific sponsor CRM or tracking tools.
6.  **AI Assistants:** No integrated chatbots or "AI copilots" (simple algorithmic automation for scheduling is allowed).
7.  **Payment References:** No code or UI related to processing payments for end-users.

## Privacy & Compliance Guardrails
-   **Data Minimization:** Only import/store PII strictly necessary for scheduling and communication (Name, Email, Role, Team).
-   **No File Storage for Sensitive Data:** Do not create buckets or tables for storing user-uploaded documents containing PII.
-   **Role-Based Access Control (RBAC):** All data access must be gated by RLS (Row Level Security) policies in Supabase.
-   **Sanitization:** Ensure no "test data" with real PII is committed to the repo.
