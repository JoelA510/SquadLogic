import { useCallback, useRef, useState } from 'react';
import { isHalfEntered, isNotAScore, typeScore } from '../utils/scoreEntry.js';

/**
 * The scores typed on a page and not saved yet, one game at a time (F11-3 review R4 and R10): the Scores page and the
 * Standings page's Recent Games both hold their drafts here, so the two cannot drift.
 *
 * - A box typed into a game whose save is in flight is ignored, and the page shows that game as saving and takes no
 *   edit for it (`saving`): nothing typed can be lost when the answer comes, and one game never has two saves that
 *   could answer out of order. Games are independent of each other.
 * - A half score or a box that is not a score is held and never sent (`utils/scoreEntry.js`).
 * - `save(game, entry)` sends; it resolves when the database took the score and throws when it refused. On an answer
 *   the draft goes (the page's `onSaved` puts the saved score on the game; `onRefused` says why, and the boxes show the
 *   saved score again).
 *
 * @param {{ save: (game: any, entry: { score_home: number | null, score_away: number | null }) => Promise<void>,
 *   onSaved: (game: any, entry: { score_home: number | null, score_away: number | null }) => void,
 *   onRefused: (err: any) => void }} handlers
 */
export function useScoreDrafts({ save, onSaved, onRefused }) {
  const [drafts, setDrafts] = useState(/** @type {Record<string, any>} */ ({}));
  const [saving, setSaving] = useState(/** @type {Set<string>} */ (new Set()));
  // Read synchronously by `type`: two boxes typed in one render must see each other, and a save started must be seen.
  const draftsRef = useRef(drafts);
  const savingRef = useRef(saving);
  const handlers = useRef({ save, onSaved, onRefused });
  handlers.current = { save, onSaved, onRefused };

  const setDraft = useCallback((id, entry) => {
    const next = { ...draftsRef.current };
    if (entry === null) delete next[id];
    else next[id] = entry;
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  const setSavingOf = useCallback((id, on) => {
    const next = new Set(savingRef.current);
    if (on) next.add(id);
    else next.delete(id);
    savingRef.current = next;
    setSaving(next);
  }, []);

  const type = useCallback(
    async (game, side, value) => {
      const id = String(game.id);
      if (savingRef.current.has(id)) return;
      const { entry, send, invalid } = typeScore(game, draftsRef.current[id], side, value);
      if (!send) {
        // Typed back to what is saved: nothing unsaved is left to hold.
        setDraft(id, invalid || isHalfEntered(entry) ? entry : null);
        return;
      }
      const whole = { score_home: entry.score_home, score_away: entry.score_away };
      setDraft(id, entry);
      setSavingOf(id, true);
      try {
        await handlers.current.save(game, whole);
        handlers.current.onSaved(game, whole);
      } catch (err) {
        handlers.current.onRefused(err);
      } finally {
        setDraft(id, null);
        setSavingOf(id, false);
      }
    },
    [setDraft, setSavingOf]
  );

  const reset = useCallback(() => {
    draftsRef.current = {};
    setDrafts({});
  }, []);

  /** What the boxes of a game hold, and its state. */
  const stateOf = useCallback(
    (game) => {
      const draft = drafts[String(game.id)];
      return {
        score_home: draft ? draft.score_home : (game.score_home ?? null),
        score_away: draft ? draft.score_away : (game.score_away ?? null),
        half: isHalfEntered(draft),
        notAScore: isNotAScore(draft),
        saving: saving.has(String(game.id)),
      };
    },
    [drafts, saving]
  );

  return { type, stateOf, reset, isSaving: (game) => saving.has(String(game.id)) };
}
