-- A scored legacy row with no saved game exercises the historical migration refusal.
INSERT INTO public.games (id, organization_id, home_team_id, away_team_id, score_home, score_away) VALUES
            ('2a000000-0000-4000-8000-0000000000f4','2a000000-0000-4000-8000-00000000000a','2a000000-0000-4000-8000-0000000000b2','2a000000-0000-4000-8000-0000000000b3',1,1);
