# Epic: Communication (COMMS)

**Summary**: Alerts, RSVP, and Messaging.

## 1. Requirements
*   **Notifications**: Email/SMS on triggers.
*   **RSVP**: Tracking attendance.
*   **Chat**: Team feed.

## 2. Execution Plan (PRs)

| PR # | Branch | Scope | Description | Tests |
| :--- | :--- | :--- | :--- | :--- |
| **PR-14** | `feat/comms-01-rsvp` | RSVP | Event attendance schema + UI. | Toggle RSVP status. |
| **PR-15** | `feat/comms-02-feed` | Chat | Simple message table per team. | Post message test. |
| **PR-16** | `feat/comms-03-notif` | Triggers | DB Trigger -> Edge Function -> Email Provider (Mock). | Manual verify log. |
