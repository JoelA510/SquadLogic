-- Revert for 20261021010000_server_side_reads.sql
--
-- Drops the server-side reads, the identity helpers, the guardian link
-- function, the contact card writer, and the three contact card columns on
-- profiles. The migration changed no policy and no existing function, so
-- nothing is restored.
--
-- What it keeps: every `profile_players` link `link_my_guardian_records()`
-- made, and the `guardian.linked` and `profile.contact_card_updated` audit
-- rows (and so the actions' registrations, if any exist). They are correct links that in-app
-- registration would also have made; unlinking is a separate decision.
--
-- What it loses: every saved contact card (the columns are dropped), and the
-- address each guardian link was matched on (`profile_players.matched_email`).
--
-- Verified: the harness checks every function and column is gone.

BEGIN;

DROP FUNCTION IF EXISTS public.get_coach_directory(uuid);
DROP FUNCTION IF EXISTS public.get_team_staff(uuid);
DROP FUNCTION IF EXISTS public.get_team_roster(uuid);
DROP FUNCTION IF EXISTS public.link_my_guardian_records();
DROP FUNCTION IF EXISTS public.guardian_contacts_view(uuid, jsonb, boolean);
DROP FUNCTION IF EXISTS public.org_flag(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.admin_get_coached_team_ids(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_my_coached_team_ids(uuid);
DROP FUNCTION IF EXISTS public.coached_team_ids_of(uuid, uuid);
DROP FUNCTION IF EXISTS public.is_team_guardian(uuid);
DROP FUNCTION IF EXISTS public.is_current_team_coach(uuid);
DROP FUNCTION IF EXISTS public.team_local_today(uuid);
DROP FUNCTION IF EXISTS public.set_my_contact_card(text, text, boolean);

ALTER TABLE public.profile_players DROP COLUMN IF EXISTS matched_email;

ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_contact_phone_check,
    DROP CONSTRAINT IF EXISTS profiles_contact_email_check,
    DROP COLUMN IF EXISTS contact_phone,
    DROP COLUMN IF EXISTS contact_email,
    DROP COLUMN IF EXISTS share_contact;

-- The action stays registered while any audit row names it (the foreign key
-- would refuse the delete); otherwise it goes.
DELETE FROM public.audit_actions a
 WHERE a.action IN ('guardian.linked', 'profile.contact_card_updated')
   AND NOT EXISTS (SELECT 1 FROM public.audit_log l WHERE l.action = a.action);

COMMIT;
