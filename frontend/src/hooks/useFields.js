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
          field_subunits ( id, label ),
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
    refresh: fetchLocationsAndFields,
  };
}
