/**
 * Whether a game slot can hold a game in a field's column of the game grid.
 *
 * The grid draws every game slot under every field, but a game slot is one
 * field's booking (`game_slots.field_id`), with room for `capacity` games. A
 * game placed in another field's column would carry a `fieldId` and a
 * `gameSlotId` that disagree, and two such games could share a capacity-1
 * booking. A slot with no field is offered under every field, as before.
 *
 * The one rule for the grid (plan item M4.3's follow-up, Wave 3): "Move to…"
 * offers only these cells, a drop or keyboard drop elsewhere is refused with a
 * reason, and the drop zones mark the other cells as not bookable.
 *
 * @param {{ fieldId?: string | number | null } | null | undefined} slot
 * @param {string | number} fieldId
 * @returns {boolean}
 */
export function isSlotOnField(slot, fieldId) {
  if (!slot) return false;
  return slot.fieldId == null || String(slot.fieldId) === String(fieldId);
}
