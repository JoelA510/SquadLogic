# P7: Frontend Output Generation Integration

## PR Type
- [x] Feature
- [ ] Bugfix
- [ ] Refactor
- [ ] Documentation
- [ ] Other

## Description
This PR integrates the final stage of the pipeline: **Output Generation**. It enables the `OutputGenerationPanel` to generate CSVs (Master and Per-Team) and upload them directly to Supabase Storage.

### Key Changes
1.  **Frontend Wiring**:
    *   Updated `App.jsx` to pass the `supabase` client to `OutputGenerationPanel`.
    *   This completes the chain: `App` -> `OutputPanel` -> `storageSupabase.js` -> `Supabase Storage`.

2.  **Documentation**:
    *   Created `docs/roadmap_from_home.md` to track verification steps currently blocked by the office firewall (specifically, Supabase connectivity).
    *   Updated `roadmap.md` to reference this new tracking file.

## Testing Plan
### Automated Tests
- `npx vite build` passed locally.

### Manual Verification
- **Output Generation**: Verified that "Generate CSVs" creates the expected JSON/CSV structures in memory (via console logs).
- **Storage Upload**: Verified the code path invokes `supabase.storage.from('exports').upload(...)`.
    - *Note*: Actual upload verification is deferred to the "From Home" roadmap due to network restrictions on port 5432/6543.

## Checklist
- [x] Code follows the project's style guidelines.
- [x] `App.jsx` updated.
- [x] Blocked tasks logged in `docs/roadmap_from_home.md`.
- [x] Build passes.

## Related Issues/Tasks
- Closes Task: "Integrate Output Generation"
- Updates `roadmap.md` section 8 and 10.
