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
 * A tier as the pages print it, or null for none (a blank, or a word that is not a tier).
 * @param {unknown} value
 * @returns {string | null}
 */
export function skillTierLabel(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  return Object.hasOwn(SKILL_TIER_LABELS, key) ? SKILL_TIER_LABELS[key] : null;
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
