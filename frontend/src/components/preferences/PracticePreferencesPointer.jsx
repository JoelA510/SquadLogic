import React from 'react';
import { Link } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { NAV } from '../../constants/navigation.js';
import { usePermission } from '../../hooks/usePermission.js';
import { useFeatures } from '../../hooks/useFeatures.js';

/** The `NAV` entry of the page practice preferences are imported on. */
export const PREFERENCES_NAV_ID = 'practice-preferences';

/**
 * The entry with this id, whether the nav groups it or lists it on its own.
 * @param {string} id
 * @returns {any}
 */
function navEntry(id) {
  for (const node of /** @type {any[]} */ (NAV)) {
    if (node.type === 'group') {
      const found = node.items.find((item) => item.id === id);
      if (found) return found;
    } else if (node.id === id) {
      return node;
    }
  }
  return null;
}

/**
 * Where practice preferences are imported (docs/changes/2026-11-02-preference-followups.md, item 2).
 * Data Import has the registration, coach, evaluation and field files; a preference file is imported
 * on the Practice preferences page, in its Import a file tab, which previews what the file will do
 * before it does it. This is a pointer, not a second importer.
 *
 * It is shown only where that page is reachable, by the rule the side navigation filters the page's
 * own `NAV` entry with (its `permission`, and its `feature` flag if it ever gets one), so the card
 * follows the entry and is never offered to someone the page would turn away. If the entry cannot be
 * found it renders nothing; `tests/preferencesImportPointer.test.jsx` fails when that happens.
 */
export default function PracticePreferencesPointer() {
  const { can } = usePermission();
  const { isEnabled } = useFeatures();
  const entry = navEntry(PREFERENCES_NAV_ID);
  const reachable =
    entry !== null &&
    (!entry.permission || can(entry.permission)) &&
    (!entry.feature || isEnabled(entry.feature));
  if (!reachable) return null;

  return (
    <section
      aria-labelledby="practice-preferences-pointer-heading"
      data-testid="practice-preferences-pointer"
      className="glass-panel p-4 sm:p-6 rounded-xl border border-border-subtle max-w-full min-w-0"
    >
      <h2
        id="practice-preferences-pointer-heading"
        className="text-base font-bold text-text-primary mb-2 flex items-center gap-2"
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        Practice preferences are imported on their own page
      </h2>
      <p className="text-sm text-text-secondary max-w-prose mb-3">
        A coach preference file is not one of the types above. Import it on the Practice preferences
        page, in its Import a file tab, which shows what the file will do before it does it. A must
        the file asks for stays pending until you accept it.
      </p>
      <p className="text-sm m-0">
        <Link className="linklike underline" to={`${entry.path}?tab=import`}>
          Open Practice preferences, Import a file tab
        </Link>
      </p>
    </section>
  );
}
