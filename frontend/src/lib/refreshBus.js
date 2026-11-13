/**
 * Minimal pub/sub for cross-cutting refresh signals — e.g. the side-nav
 * count badges re-fetching after a player is added or deleted from a page
 * that doesn't share state with the nav. Emitters fire and forget;
 * subscribers decide how to refresh.
 */
const topics = new Map();

export const REFRESH_TOPICS = {
  NAV_BADGES: 'nav-badges',
  // A season's programs changed (a program made, renamed, deleted or merged, a division moved): the scoped settings
  // panel reads its levels again (F11-4b).
  PROGRAMS: 'programs',
};

export function subscribeRefresh(topic, listener) {
  if (!topics.has(topic)) topics.set(topic, new Set());
  const listeners = topics.get(topic);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitRefresh(topic) {
  topics.get(topic)?.forEach((listener) => listener());
}
