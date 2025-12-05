# Remote/From-Home Roadmap

This document tracks tasks and verifications that are blocked by the local office network firewall (specifically port 5432/6543 access to Supabase). These tasks must be performed from a non-restricted network (e.g., "From Home").

## 1. Database Deployment
- [ ] **Run `npx supabase db push`**: Apply the local migrations to the remote Supabase instance.
    - *Blocker*: Cannot connect to the connection pooler or direct DB port.
- [ ] **Run Seed Script**: Execute `docs/sql/sample_seed_data.sql` against the remote instance.

## 2. Storage Setup
- [ ] **Create 'exports' Bucket**: Ensure the Supabase Storage bucket named `exports` exists and is public (or has appropriate RLS).
    - *Blocker*: Requires DB access or Dashboard access (if dashboard is also blocked/slow).

## 3. Integration Verification
- [ ] **Test "Sync to Supabase" (Teams)**: Click "Sync to Supabase" in the Team Persistence Panel and verify data appears in `teams` table.
- [ ] **Test "Sync to Supabase" (Practice)**: Click "Sync to Supabase" in Practice Persistence Panel.
- [ ] **Test "Sync to Supabase" (Games)**: Click "Sync to Supabase" in Game Persistence Panel.
- [ ] **Test "Save Snapshot" (Evaluation)**: Click "Save Snapshot" in Evaluation Panel.
- [ ] **Test "Upload to Storage" (Output)**: Click "Upload to Storage" in Output Generation Panel and verify files appear in the `exports` bucket.
