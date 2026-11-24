-- Run immediately after applying the historical score-copy migration to its fixture.
DO $check$
DECLARE v_result text;
BEGIN
    SELECT (SELECT count(*) FROM public.game_scores) || ':' ||
                 COALESCE((SELECT score_home || '-' || score_away FROM public.game_scores WHERE game_id = '2a000000-0000-4000-8000-0000000000c1'), 'none') || ':' ||
                 (SELECT count(*) FROM public.games WHERE organization_id = '2a000000-0000-4000-8000-00000000000a') INTO v_result;
    IF v_result IS DISTINCT FROM '1:4-2:3' THEN
        RAISE EXCEPTION 'Unexpected legacy score copy result: %', v_result;
    END IF;
END
$check$;
