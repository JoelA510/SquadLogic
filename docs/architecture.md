# Architecture & Technology Selection

## Modular Agentic Architecture
- **Data Ingestion Agent**: Imports GotSport registration exports and field availability spreadsheets. Normalizes player, coach, and facility data, validates buddy pairs, and forwards clean records to storage.
- **Team Formation Agent**: Generates balanced rosters per division using roster formulas, mutual buddy handling, and coach-child constraints. Surfaces adjustments back to the admin UI.
- **Schedule Orchestration Agent**: Assigns weekly practices and Saturday games while evaluating conflicts, daylight adjustments, and fairness metrics. Integrates an evaluator loop to refine assignments.
- **Evaluation & Export Agent**: Audits schedules, produces reports, and generates CSV/Excel exports for TeamSnap along with draft coach communications.
- **Coordinator (UI/API Layer)**: Create React App (CRA) front end backed by Supabase auth and APIs, orchestrating user interactions, persisting state, and delegating tasks to agents.

## Technology Stack Decisions
- **Front End**: Create React App built with `react-scripts`, deployed as a static bundle (e.g., Vercel or Netlify) with environment variables scoped as `REACT_APP_*`.
- **State & Data Access**: React Query or SWR for client data fetching; Supabase JavaScript client for Auth + Postgres.
- **Back End / APIs**: Supabase Edge Functions (TypeScript) or lightweight serverless handlers (e.g., Vercel/Netlify functions) for ingestion, scheduling jobs, and export preparation.
- **Database**: Supabase Postgres with Row Level Security, Storage for file uploads, and Functions for complex SQL views if needed.
- **Task Automation**: Background scheduling via the hosting provider's cron/scheduled functions (e.g., Vercel Cron or Netlify Scheduled Functions) or Supabase Edge Functions for periodic evaluations or notifications.

## Free-Tier Constraints & Mitigations
- **Hosting Platform**: Deploy on a provider with a generous free plan (e.g., Vercel or Netlify). Evaluate their free-tier allowances for build minutes, serverless function hours, cron support, bandwidth, and analytics to confirm they cover early-season needs; cache heavy results and batch schedule generation to stay within limits.
- **Supabase**: 500 MB Postgres, 50K monthly active users, and project pause after 1 week inactivity. Mitigation—archive historical seasons, prune uploads, and schedule heartbeat jobs or manual logins.
- **Client Performance**: Optimize bundle size with code splitting, avoid unnecessary re-renders, and lean on incremental static regeneration for read-heavy pages.

## Integration Points
- **TeamSnap**: Export CSV/Excel templates aligned with TeamSnap import schema; manual upload flow in MVP, with future API exploration.
- **Email Workflows**: Generate mailto links or integrate with a transactional email API (e.g., Resend) once auth is in place.
- **Authentication**: Initially single-admin with environment guard; design for optional Supabase Auth roles later.
- **Observability**: Use Supabase logs and the hosting platform's analytics; consider Logflare for aggregated monitoring if limits permit.
