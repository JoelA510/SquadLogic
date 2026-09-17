import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';

export function useFields() {
  const [locations, setLocations] = useState([]);
  const [fields, setFields] = useState([]);
  const [availabilityProfiles, setAvailabilityProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { currentOrganization } = useOrganization();

  const fetchLocationsAndFields = useCallback(async () => {
    if (!currentOrganization?.id) {
      setLocations([]);
      setFields([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // 1. Fetch Locations
      const { data: locData, error: locError } = await supabase
        .from('locations')
        .select('*')
        .eq('organization_id', currentOrganization.id)
        .order('name');

      if (locError) throw locError;
      setLocations(locData || []);

      // 2. Fetch Fields, joined with subunits
      const { data: fieldData, error: fieldError } = await supabase
        .from('fields')
        .select(
          `
          *,
          field_subunits ( id, label, effective_to ),
          practice_slots ( id, day_of_week, start_time, end_time, capacity )
        `
        )
        .eq('organization_id', currentOrganization.id)
        .order('name');

      if (fieldError) throw fieldError;
      setFields(fieldData || []);

      const { data: availabilityData, error: availabilityError } = await supabase
        .from('field_availability_profiles')
        .select(
          `
          *,
          field_availability_profile_formats ( id, format_code, format_quantity, format_order ),
          field_blackout_windows ( id, blackout_from, blackout_until, reason ),
          field_equipment_requirements ( id, goal_equipment, requirement_status )
        `
        )
        .eq('organization_id', currentOrganization.id)
        .order('available_from');

      if (availabilityError) throw availabilityError;
      setAvailabilityProfiles(availabilityData || []);
    } catch (err) {
      logger.error('Error fetching field data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentOrganization?.id]);

  useEffect(() => {
    fetchLocationsAndFields();
  }, [fetchLocationsAndFields]);

  const addLocation = async (locationName) => {
    if (!currentOrganization?.id) throw new Error('No active organization');

    const { data, error: insertError } = await supabase.rpc('admin_create_location', {
      p_organization_id: currentOrganization.id,
      p_name: locationName,
    });

    if (insertError) throw insertError;
    await fetchLocationsAndFields();
    return data;
  };

  const addField = async (fieldData) => {
    if (!currentOrganization?.id) throw new Error('No active organization');

    const { data, error: insertError } = await supabase.rpc('admin_create_field', {
      p_organization_id: currentOrganization.id,
      p_location_id: fieldData.location_id,
      p_name: fieldData.name,
      p_surface_type: fieldData.surface_type,
      p_size: fieldData.size,
      p_supports_halves: fieldData.supports_halves,
      p_priority_rating: fieldData.priority_rating || 1,
      p_active: fieldData.active !== false,
    });

    if (insertError) throw insertError;
    // The trigger will create subunits, but insert might return before trigger fully commits to the select tree,
    // so we re-fetch to ensure we have the subunits in our local state.
    await fetchLocationsAndFields();
    return data;
  };

  const updateField = async (fieldId, updates) => {
    if (!currentOrganization?.id) throw new Error('No active organization');

    const { error: updateError } = await supabase.rpc('admin_update_field', {
      p_organization_id: currentOrganization.id,
      p_field_id: fieldId,
      p_location_id: updates.location_id,
      p_name: updates.name,
      p_surface_type: updates.surface_type,
      p_size: updates.size,
      p_supports_halves: updates.supports_halves,
      p_priority_rating: updates.priority_rating,
      p_active: updates.active,
    });

    if (updateError) throw updateError;
    await fetchLocationsAndFields();
  };

  /**
   * Delete a field, or find out what deleting it would cost.
   *
   * **A refusal is not an error, and this used to read it as success.**
   * `admin_delete_field` mirrors `admin_retire_field`: with bookings on the
   * ground and no confirmation it RETURNS `{deleted: false, reason,
   * affected_count, affected}` rather than raising. This function discarded
   * `data` entirely -- `const { error: deleteError } = ...` -- so a refusal
   * arrived with `error` null and the field was removed from the list it had
   * not deleted, until the next refresh put it back. A status a caller never
   * checks is the shape four separate tools had in PR 2.
   *
   * The result is RETURNED rather than thrown so the caller can show the
   * operator what is booked and offer to confirm.
   *
   * @param {string} fieldId
   * @param {{ confirm?: boolean }} [options] `confirm: true` deletes booked
   *   ground anyway. The refusal lives in the RPC, so this flag is the only
   *   way past it and it has to be passed deliberately.
   * @returns {Promise<{ deleted: boolean, reason?: string, affected_count?: number,
   *   affected?: Array<{ kind: string, id: string, on_date: string|null,
   *   disposition: string }> }>}
   */
  const deleteField = async (fieldId, { confirm = false } = {}) => {
    if (!currentOrganization?.id) throw new Error('No active organization');

    const { data, error: deleteError } = await supabase.rpc('admin_delete_field', {
      p_organization_id: currentOrganization.id,
      p_field_id: fieldId,
      p_confirm: confirm,
    });

    if (deleteError) throw deleteError;
    // **An unreadable response is an error, not a refusal.** Returning
    // `{deleted: false}` for it made the page show "0 booking(s). Deleting it
    // removes 0 slot(s)... Delete anyway?" -- a consequence preview that reads
    // as "nothing is booked" when the truth is that we do not know. Removing
    // the row on the strength of a response we cannot read would be worse, so
    // this raises instead of guessing in either direction.
    if (data === null || data === undefined || typeof data.deleted !== 'boolean') {
      throw new Error('admin_delete_field returned no readable result');
    }
    if (!data.deleted) return data;
    setFields((prev) => prev.filter((f) => f.id !== fieldId));
    return data;
  };

  /**
   * Retire a field, or find out what retiring it on a date would strand.
   *
   * **Retire is an END DATE, never a delete.** `admin_retire_field` writes
   * `fields.effective_to` and keeps `fields.active` in step; nothing is
   * removed. With bookings after the date and no confirmation it RETURNS
   * `{retired:false, reason:'bookings_after_effective_to', affected_count,
   * affected}` and writes a `refused` audit row, exactly as `admin_delete_field`
   * does with `reason:'bookings_exist'`.
   *
   * **The affected rows carry SIX keys and NO `disposition`**, which is not an
   * oversight and callers must not render one. A retirement destroys nothing,
   * so "what would happen to this row" has no answer to give; the delete arm
   * computes `deleted`/`unassigned` from the producer's `cascades` and this arm
   * deliberately drops it (see the comment above `admin_retire_field` in
   * `20260907000000_field_delete_booking_guard.sql`).
   *
   * The result is RETURNED rather than thrown so the caller can show the
   * operator the list and offer to confirm.
   *
   * @param {string} fieldId
   * @param {{ effectiveTo: string, confirm?: boolean }} options `effectiveTo`
   *   is the inclusive LAST DAY the ground is usable — the same reading
   *   `field_is_live_on` and `facility/lifecycle.js isLiveOn()` give, so a
   *   booking ON that date is left alone.
   * @returns {Promise<{ retired: boolean, reason?: string, affected_count?: number,
   *   affected?: Array<{ kind: string, id: string, on_date: string|null,
   *   week_index: number|null, undated: boolean, unbounded: boolean }> }>}
   */
  const retireField = async (fieldId, { effectiveTo, confirm = false }) => {
    if (!currentOrganization?.id) throw new Error('No active organization');
    if (!effectiveTo) {
      throw new Error('An end date is required; retiring with no end date is a deletion');
    }

    const { data, error: rpcError } = await supabase.rpc('admin_retire_field', {
      p_organization_id: currentOrganization.id,
      p_field_id: fieldId,
      p_effective_to: effectiveTo,
      p_confirm: confirm,
    });

    if (rpcError) throw rpcError;
    // Same guard as `deleteField`: a response we cannot read is an error, not a
    // refusal and not a success. Rendering "0 booking(s) affected" for it would
    // tell the operator the ground is clear when the truth is that we do not
    // know.
    if (data === null || data === undefined || typeof data.retired !== 'boolean') {
      throw new Error('admin_retire_field returned no readable result');
    }
    if (data.retired) await fetchLocationsAndFields();
    return data;
  };

  /**
   * Clear a field's end date.
   *
   * `admin_unretire_field` restores `effective_to` to NULL and leaves `active`
   * exactly as it found it — un-retiring an ordinarily deactivated field does
   * not reactivate it, which is a defect both arms carried once.
   *
   * @param {string} fieldId
   */
  const unretireField = async (fieldId) => {
    if (!currentOrganization?.id) throw new Error('No active organization');
    const { data, error: rpcError } = await supabase.rpc('admin_unretire_field', {
      p_organization_id: currentOrganization.id,
      p_field_id: fieldId,
    });
    if (rpcError) throw rpcError;
    if (!data || !data.field) {
      throw new Error('admin_unretire_field returned no readable result');
    }
    await fetchLocationsAndFields();
    return data;
  };

  /**
   * The two estate depths `admin_retire_field` does not cover, described once.
   *
   * **Four wrappers, one implementation, and that is the point.** The defects
   * this family keeps producing — LIVE-1, LIVE-2, LIVE-3 — are each one arm of
   * a guard corrected while its sibling was not. `admin_retire_location` and
   * `admin_retire_field_subunit` ship the SAME contract at two depths
   * (refusal object rather than raise, `retired` boolean, `affected` with no
   * per-row `disposition`), so the differences are named as data here and the
   * behaviour is written once. A correction to how a refusal is read reaches
   * both depths or neither.
   *
   * What genuinely differs is only: which parameter carries the id, which key
   * carries the row back, and whether the depth has anything BELOW it.
   *
   * **`contains` is READ, not decoration.** `retireEstateNode` asserts on it:
   * a depth declared not to contain anything must not come back with a
   * `contained` key. CLAUDE.md's rule is honour it or delete it, and a nine-line
   * comment claiming an invariant that nothing consults is the "declared is not
   * enforced" shape one layer below where it usually hides. `noun` was the
   * other half of that and is gone -- the dialog owns the vocabulary.
   *
   * @type {Record<string, { retireRpc: string, unretireRpc: string,
   *   idParam: string, rowKey: string, contains: boolean }>}
   */
  const ESTATE_DEPTHS = {
    location: {
      retireRpc: 'admin_retire_location',
      unretireRpc: 'admin_unretire_location',
      idParam: 'p_location_id',
      rowKey: 'location',
      // A venue HOLDS fields and sub-surfaces, and retiring it closes them by
      // containment rather than by writing a date onto each. `contained` is
      // the half of the consequence that is not a booking list.
      contains: true,
    },
    field_subunit: {
      retireRpc: 'admin_retire_field_subunit',
      unretireRpc: 'admin_unretire_field_subunit',
      idParam: 'p_field_subunit_id',
      rowKey: 'field_subunit',
      // **The leaf of the estate, and the absence is deliberate.**
      // `admin_retire_field_subunit` returns NO `contained` key —
      // 20260911000000 section 7 argues that an empty one would be "a promise
      // with no producer", and its smoke asserts the key is absent. So this
      // depth must not manufacture one either: "nothing below" and "nobody
      // looked" have to stay distinguishable in the UI as well as in the RPC.
      contains: false,
    },
  };

  /**
   * Retire a venue or a sub-surface, or find out what retiring it would strand.
   *
   * Mirrors {@link retireField} exactly, because the RPCs do: an unconfirmed
   * call IS the dry run, a refusal arrives with `error` null and
   * `{retired:false, reason:'bookings_after_effective_to', ...}`, and a
   * `refused` audit row is written for the world the operator decided against.
   *
   * **The affected rows carry no `disposition`** at either depth, for the same
   * reason the field arm drops it: a retirement writes a date and destroys
   * nothing, so "what would happen to this row" has no answer to give.
   *
   * **`contained` is returned untouched at venue depth and is absent at
   * sub-surface depth.** It is NOT a booking list: each entry is a field or a
   * sub-surface the venue holds, with `already_retired` true where that node's
   * own window already ends no later than this date. Rendering it as bookings,
   * or defaulting it to `[]` here so a caller can render it uniformly, would
   * both misreport what the operator is about to do.
   *
   * @param {'location'|'field_subunit'} depth
   * @param {string} nodeId
   * @param {{ effectiveTo: string, confirm?: boolean }} options `effectiveTo`
   *   is the inclusive LAST DAY the ground is usable.
   * @returns {Promise<Record<string, any>>}
   */
  const retireEstateNode = async (depth, nodeId, { effectiveTo, confirm = false }) => {
    const spec = ESTATE_DEPTHS[depth];
    if (!spec) throw new Error(`Unknown estate depth: ${depth}`);
    if (!currentOrganization?.id) throw new Error('No active organization');
    if (!effectiveTo) {
      throw new Error('An end date is required; retiring with no end date is a deletion');
    }

    const { data, error: rpcError } = await supabase.rpc(spec.retireRpc, {
      p_organization_id: currentOrganization.id,
      [spec.idParam]: nodeId,
      p_effective_to: effectiveTo,
      p_confirm: confirm,
    });

    if (rpcError) throw rpcError;
    // The same guard `retireField` carries: a response we cannot read is an
    // error, not a refusal and not a success. "0 bookings affected" for an
    // unreadable answer tells the operator the ground is clear when the truth
    // is that we do not know.
    if (data === null || data === undefined || typeof data.retired !== 'boolean') {
      throw new Error(`${spec.retireRpc} returned no readable result`);
    }
    // **The `contains` declaration, enforced.** A depth that says it contains
    // nothing must not return a containment set: 20260911000000 section 7
    // argues the absent key is the difference between "nothing below" and
    // "nobody looked", and a key appearing here would mean the SQL and this
    // table disagree about the shape of the estate.
    if (!spec.contains && data.contained !== undefined) {
      throw new Error(
        `${spec.retireRpc} returned a contained set at a depth that contains nothing`
      );
    }
    if (data.retired) await fetchLocationsAndFields();
    return data;
  };

  /**
   * Clear a venue's or a sub-surface's end date.
   *
   * **A venue unretire is the exact inverse of its retire, and a field's is
   * not.** `admin_unretire_field` cannot restore `fields.active` because it
   * cannot know whether the inactivity came from the retirement; a venue
   * retirement wrote one date on one row and copied nothing down, so clearing
   * it restores every child that has no date of its own and leaves alone every
   * child that has. `contained` comes back with `already_retired` false for
   * every row — no date is being applied, so this call claims to have restored
   * nobody's own window.
   *
   * @param {'location'|'field_subunit'} depth
   * @param {string} nodeId
   * @returns {Promise<Record<string, any>>}
   */
  const unretireEstateNode = async (depth, nodeId) => {
    const spec = ESTATE_DEPTHS[depth];
    if (!spec) throw new Error(`Unknown estate depth: ${depth}`);
    if (!currentOrganization?.id) throw new Error('No active organization');

    const { data, error: rpcError } = await supabase.rpc(spec.unretireRpc, {
      p_organization_id: currentOrganization.id,
      [spec.idParam]: nodeId,
    });

    if (rpcError) throw rpcError;
    // The unretire arms return `{retired:false, <rowKey>: <row>}`. The ROW is
    // what makes the answer readable — `retired:false` alone is also what a
    // refusal says — so this checks for the row, as `unretireField` checks for
    // `data.field`.
    if (!data || !data[spec.rowKey]) {
      throw new Error(`${spec.unretireRpc} returned no readable result`);
    }
    await fetchLocationsAndFields();
    return data;
  };

  /** @param {string} locationId @param {{ effectiveTo: string, confirm?: boolean }} options */
  const retireLocation = (locationId, options) => retireEstateNode('location', locationId, options);

  /** @param {string} locationId */
  const unretireLocation = (locationId) => unretireEstateNode('location', locationId);

  /** @param {string} subunitId @param {{ effectiveTo: string, confirm?: boolean }} options */
  const retireFieldSubunit = (subunitId, options) =>
    retireEstateNode('field_subunit', subunitId, options);

  /** @param {string} subunitId */
  const unretireFieldSubunit = (subunitId) => unretireEstateNode('field_subunit', subunitId);

  return {
    locations,
    fields,
    availabilityProfiles,
    loading,
    error,
    addLocation,
    addField,
    updateField,
    deleteField,
    retireField,
    unretireField,
    retireLocation,
    unretireLocation,
    retireFieldSubunit,
    unretireFieldSubunit,
    refresh: fetchLocationsAndFields,
  };
}
