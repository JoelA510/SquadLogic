# Feature: Supabase Auth, Dashboard Polish & Data Ingestion

## Summary
This PR introduces Supabase Authentication, significantly polishes the Admin Dashboard UI, and adds a new Data Ingestion feature for importing GotSport registration data.

## Changes

### 🔐 Supabase Authentication
- **Dependencies**: Added `@supabase/supabase-js`.
- **Auth Context**: Implemented `AuthContext` to manage global session state.
- **Login UI**: Created a "Deep Space Glass" styled `Login` component with:
  - Email/Password authentication.
  - Registration toggle.
  - Graceful error handling for missing configuration.
- **Route Protection**: Refactored `App.jsx` to gate the entire dashboard behind the login screen.

### 🎨 Dashboard UI Polish
- **Header**: Removed redundant "SquadLogic" branding for a cleaner look.
- **Persistence Panels**:
  - Refactored `TeamPersistencePanel` to fix layout, button placement, and casing inconsistencies.
  - Standardized `PersistencePanel` to handle empty states gracefully.
- **General**: Improved spacing and visual hierarchy across the dashboard.

### 📂 Data Ingestion
- **New Component**: Added `ImportPanel` for handling CSV uploads.
- **Functionality**:
  - Drag-and-drop support.
  - Client-side CSV parsing with preview table.
  - Integrated into the main dashboard layout.

### ⚙️ Configuration
- **Environment**: Added `.env.example` to document required Supabase variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
- **Vite**: Updated `vite.config.js` to correctly load `.env` files from the project root.

## Verification
- **Build**: `npm run frontend:build` passes successfully.
- **Runtime**:
  - Verified login flow (success/error states).
  - Verified dashboard rendering with and without data.
  - Verified CSV file selection and preview generation.

## Screenshots
*(Screenshots of the new Login screen and Dashboard can be added here)*
