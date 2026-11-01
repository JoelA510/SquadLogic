/**
 * The skill tiers a player can hold (`players.skill_tier`, CHECK novice, developing, advanced),
 * lowest first. Shown wherever the Skill Tier feature is on (the Players grid, the player and
 * team record pages, the roster editor).
 */
const SKILL_TIER_LABELS = Object.freeze({
  novice: 'Novice',
  developing: 'Developing',
  advanced: 'Advanced',
});

/** @type {string[]} */
const SKILL_TIER_ORDER = Object.values(SKILL_TIER_LABELS);

/**
 * A tier as the table stores it (lower case), or null for none (a blank, or a word that is not a
 * tier). What counts as a stored tier wherever one is read over a file's.
 * @param {unknown} value
 * @returns {string | null}
 */
export function skillTierKey(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  return Object.hasOwn(SKILL_TIER_LABELS, key) ? key : null;
}

/**
 * A tier as the pages print it, or null for none (a blank, or a word that is not a tier).
 * @param {unknown} value
 * @returns {string | null}
 */
export function skillTierLabel(value) {
  const key = skillTierKey(value);
  return key === null ? null : SKILL_TIER_LABELS[key];
}

/**
 * A tier's place in the order, for sorting: novice 0, developing 1, advanced 2, none -1.
 * @param {unknown} value
 * @returns {number}
 */
export function skillTierRank(value) {
  const label = skillTierLabel(value);
  return label === null ? -1 : SKILL_TIER_ORDER.indexOf(label);
}
