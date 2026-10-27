import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';
import {
  PermitFileSchema,
  PermitInputSchema,
  PERMIT_MAGIC_BYTES,
  permitObjectPath,
  permitWarnings,
} from '@squadlogic/core/facility/permits.js';

const PERMIT_BUCKET = 'facility-permits';

/** A signed URL lives this long: made on tap, used at once. */
const SIGNED_URL_SECONDS = 120;

const unreadable = (rpc) => new Error(`${rpc} returned no readable result`);

/** The first bytes of a file, for the magic-byte check (the bucket trusts the declared type). */
async function headBytesOf(file) {
  return new Uint8Array(await file.slice(0, PERMIT_MAGIC_BYTES).arrayBuffer());
}

/** Removes an object; a failure is logged with its path (an orphan only an admin could read). */
async function removeQuietly(storage, path, what) {
  const { error } = await storage.remove([path]);
  if (error) {
    logger.error(`[useFacilityPermits] could not remove ${what}`, { path, message: error.message });
  }
}

/** One read of the permits, as the state the hook holds (never throws). */
async function readPermits(orgId) {
  const empty = { orgId, permits: [], today: null, loading: false };
  if (!orgId) return { ...empty, error: null };
  let result;
  try {
    result = await supabase.rpc('get_facility_permits', { p_organization_id: orgId });
  } catch (err) {
    // A permit blocks nothing: a read that cannot complete is said, never thrown into the page.
    logger.error('[useFacilityPermits] read failed', { message: err?.message });
    return {
      ...empty,
      error: `Permits could not be read: ${err?.message ?? 'the request failed'}`,
    };
  }
  const { data, error } = result ?? {};
  if (error) {
    logger.error('[useFacilityPermits] read failed', { code: error.code, message: error.message });
    // 42501 is the server's refusal, not an empty list: say so.
    return {
      ...empty,
      error:
        error.code === '42501'
          ? 'Permits are not available to your role.'
          : `Permits could not be read: ${error.message}`,
    };
  }
  if (!data || !Array.isArray(data.permits) || typeof data.today !== 'string') {
    return { ...empty, error: 'Permits could not be read: the answer was unreadable.' };
  }
  return { orgId, permits: data.permits, today: data.today, loading: false, error: null };
}

/**
 * The permits of the active organization, and the writes.
 *
 * **A permit never blocks anything** (owner, 2026-10-26): nothing here is read by an import, a
 * scheduling run, a publish or an export.
 *
 * Upload order, so a failure leaves nothing half-done and nothing hidden: create the row, upload the
 * object, attach it. A failed upload leaves the permit without a file and says so; a failed attach
 * removes the upload (the exports all-or-nothing pattern); after a replace or a delete commits, the
 * old object is removed, and a failure to remove it is logged with its path (an orphan the admin
 * cannot see, which only an admin could ever read).
 */
export function useFacilityPermits() {
  const { currentOrganization } = useOrganization();
  const orgId = currentOrganization?.id ?? null;
  const [state, setState] = useState({
    orgId: /** @type {string|null} */ (null),
    permits: [],
    today: null,
    loading: true,
    error: null,
  });
  // The newest read wins, and a read for an organization that is no longer the active one never
  // lands: the page stays mounted across an organization switch, so an older read (or a mutation's
  // refresh started for the previous organization) must not replace the new one's list.
  const generation = useRef(0);
  const activeOrg = useRef(orgId);

  const refresh = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const next = await readPermits(orgId);
    if (mine === generation.current && activeOrg.current === orgId) setState(next);
  }, [orgId]);

  useEffect(() => {
    activeOrg.current = orgId;
    generation.current += 1;
    const mine = generation.current;
    (async () => {
      const next = await readPermits(orgId);
      if (mine === generation.current) setState(next);
    })();
    return () => {
      // A superseded or unmounted read is dropped.
      generation.current += 1;
    };
  }, [orgId]);

  const requireOrg = () => {
    if (!orgId) throw new Error('No active organization');
    return orgId;
  };

  /** Validates a chosen file; returns what {@link attachFile} needs. Throws a readable message. */
  const checkFile = async (file) => {
    const head = await headBytesOf(file);
    const parsed = PermitFileSchema.safeParse({
      name: file.name,
      type: file.type,
      size: file.size,
      headBytes: head,
    });
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    return parsed.data;
  };

  const rpcInput = (input) => {
    const parsed = PermitInputSchema.safeParse(input);
    if (!parsed.success) {
      const error = new Error(parsed.error.issues[0].message);
      /** @type {any} */ (error).issues = parsed.error.issues;
      throw error;
    }
    return parsed.data;
  };

  const attachFile = async (permit, file) => {
    const org = requireOrg();
    const checked = await checkFile(file);
    const path = permitObjectPath(org, permit.id, checked.extension);
    const storage = supabase.storage.from(PERMIT_BUCKET);
    const { error: uploadError } = await storage.upload(path, file, {
      contentType: checked.type,
      upsert: false,
    });
    if (uploadError) {
      // The bucket's policy refuses an upload to a demo league (its files could not be cleaned up) and
      // to anyone who is not an administrator of the organization: say which, not the policy's words.
      const refused = String(uploadError.statusCode) === '403';
      throw new Error(
        refused
          ? 'The file could not be uploaded: storage refused it. A demo league keeps no files, and only an administrator of the organization can add one.'
          : `The file could not be uploaded: ${uploadError.message}`
      );
    }
    let result;
    let thrown = null;
    try {
      result = await supabase.rpc('admin_set_facility_permit_file', {
        p_organization_id: org,
        p_permit_id: permit.id,
        p_object_path: path,
        p_file_name: checked.name,
      });
    } catch (err) {
      thrown = err;
    }
    const { data, error } = result ?? {};
    const attached = !thrown && !error && data?.permit ? data : null;

    if (!attached) {
      // A refusal the server confirmed (a Postgres or PostgREST error code) means nothing was
      // attached: take the upload back so no orphan stays. Anything else (a fetch error, an unreadable
      // answer) is UNCERTAIN: the attach may have committed with its response lost, and deleting the
      // object then would leave the permit pointing at a file that is gone. Read the stored file
      // path first, and delete only on proof that this object is not it.
      const confirmedRefusal = !thrown && Boolean(error?.code);
      if (confirmedRefusal) {
        await removeQuietly(storage, path, 'an upload after a refused attach');
        throw new Error(`The file could not be attached: ${error.message}`);
      }
      const stored = await readPermits(org);
      const found = stored.error ? undefined : stored.permits.find((p) => p.id === permit.id);
      if (!found) {
        // Could not be determined: keep the upload (an unreferenced object is harmless; a dangling
        // reference is not) and say what is known.
        logger.error('[useFacilityPermits] an attach could not be confirmed; the upload was kept', {
          path,
        });
        throw new Error(
          'The file was uploaded, but it could not be confirmed that it was attached to the permit (the connection failed). Reload the page and check the permit: if it shows no file, add it again.'
        );
      }
      if (found.file?.path !== path) {
        await removeQuietly(storage, path, 'an upload after a failed attach');
        throw new Error(
          `The file could not be attached: ${thrown?.message ?? error?.message ?? 'the answer was unreadable'}`
        );
      }
      // It did commit. The response is lost, so the replaced file is whatever the permit showed before.
      const replaced = permit.file?.path ?? null;
      if (replaced && replaced !== path)
        await removeQuietly(storage, replaced, 'the replaced file');
      return found;
    }
    if (data.previous_path) await removeQuietly(storage, data.previous_path, 'the replaced file');
    return attached.permit;
  };

  /**
   * Creates a permit and, when a file is given, uploads and attaches it. If the file fails the
   * permit stays, and the error says the permit was saved.
   * @returns {Promise<{ permit: any, fileError: string|null }>}
   */
  const createPermit = async (input, file = null) => {
    const org = requireOrg();
    const v = rpcInput(input);
    if (file) await checkFile(file); // refuse a bad file before anything is created
    const { data, error } = await supabase.rpc('admin_create_facility_permit', {
      p_organization_id: org,
      p_issuer: v.issuer,
      p_permit_number: v.permitNumber,
      p_valid_from: v.validFrom,
      p_valid_to: v.validTo,
      p_notes: v.notes,
      p_location_ids: v.locationIds,
      p_field_ids: v.fieldIds,
    });
    if (error) throw error;
    if (!data?.id) throw unreadable('admin_create_facility_permit');
    let fileError = null;
    if (file) {
      try {
        await attachFile(data, file);
      } catch (err) {
        fileError = err.message;
      }
    }
    await refresh();
    return { permit: data, fileError };
  };

  const updatePermit = async (permitId, input) => {
    const org = requireOrg();
    const v = rpcInput(input);
    const { data, error } = await supabase.rpc('admin_update_facility_permit', {
      p_organization_id: org,
      p_permit_id: permitId,
      p_issuer: v.issuer,
      p_permit_number: v.permitNumber,
      p_valid_from: v.validFrom,
      p_valid_to: v.validTo,
      p_notes: v.notes,
      p_location_ids: v.locationIds,
      p_field_ids: v.fieldIds,
    });
    if (error) throw error;
    if (!data?.id) throw unreadable('admin_update_facility_permit');
    await refresh();
    return data;
  };

  const replaceFile = async (permit, file) => {
    const updated = await attachFile(permit, file);
    await refresh();
    return updated;
  };

  const deletePermit = async (permit) => {
    const org = requireOrg();
    const { data, error } = await supabase.rpc('admin_delete_facility_permit', {
      p_organization_id: org,
      p_permit_id: permit.id,
    });
    if (error) throw error;
    if (!data || data.deleted !== true) throw unreadable('admin_delete_facility_permit');
    if (data.file_path) {
      const { error: removeError } = await supabase.storage
        .from(PERMIT_BUCKET)
        .remove([data.file_path]);
      if (removeError) {
        logger.error("[useFacilityPermits] could not remove a deleted permit's file", {
          path: data.file_path,
          message: removeError.message,
        });
      }
    }
    await refresh();
  };

  /** A signed URL for a permit's file, made on tap and good for two minutes; `downloadAs` names a saved copy. */
  const signedUrl = async (path, downloadAs = undefined) => {
    const { data, error } = await supabase.storage
      .from(PERMIT_BUCKET)
      .createSignedUrl(path, SIGNED_URL_SECONDS, downloadAs ? { download: downloadAs } : undefined);
    if (error || !data?.signedUrl)
      throw new Error(`The file could not be opened: ${error?.message ?? 'no link was made'}`);
    return data.signedUrl;
  };

  // State read for another organization is not this one's: it reads as loading until its own arrives.
  const current =
    state.orgId === orgId ? state : { orgId, permits: [], today: null, loading: true, error: null };

  return {
    ...current,
    refresh,
    checkFile,
    createPermit,
    updatePermit,
    replaceFile,
    deletePermit,
    signedUrl,
  };
}

/**
 * The permit warnings for the admin home: permits expiring within 30 days, expired ones, and live
 * fields with no current permit. A failure to read is logged and shows no warnings: the home does
 * not depend on permits (a permit blocks nothing).
 */
export function usePermitWarnings() {
  const { currentOrganization } = useOrganization();
  const orgId = currentOrganization?.id ?? null;
  const [warnings, setWarnings] = useState(
    /** @type {null | ReturnType<typeof permitWarnings>} */ (null)
  );

  useEffect(() => {
    let cancelled = false;
    if (!orgId) return undefined;
    (async () => {
      try {
        const [permitRead, locationRead, fieldRead] = await Promise.all([
          supabase.rpc('get_facility_permits', { p_organization_id: orgId }),
          supabase.from('locations').select('id, name, effective_to').eq('organization_id', orgId),
          supabase
            .from('fields')
            .select('id, name, location_id, active, effective_to')
            .eq('organization_id', orgId),
        ]);
        const failed = permitRead.error || locationRead.error || fieldRead.error;
        if (failed) throw failed;
        if (!permitRead.data || !Array.isArray(permitRead.data.permits))
          throw unreadable('get_facility_permits');
        if (cancelled) return;
        setWarnings(
          permitWarnings({
            permits: permitRead.data.permits,
            today: permitRead.data.today,
            locations: locationRead.data ?? [],
            fields: fieldRead.data ?? [],
          })
        );
      } catch (err) {
        logger.error('[usePermitWarnings] permit warnings not loaded', {
          message: err?.message,
          code: err?.code,
        });
        if (!cancelled) setWarnings(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return warnings;
}
