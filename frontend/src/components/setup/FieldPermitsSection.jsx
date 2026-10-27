import React, { useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import Button from '../ui/Button.jsx';
import Modal from '../ui/Modal.jsx';
import PermitDialog from './PermitDialog.jsx';
import {
  formatPermitDate,
  permitScopeText,
  permitStatusText,
  permitStatusTone,
} from '../../utils/permitText.js';
import { logger } from '../../lib/logger.js';

const STATUS_ICON = {
  expired: AlertTriangle,
  expiring: Clock,
  not_yet_valid: Clock,
  valid: CheckCircle2,
};

const sizeText = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The Permits section of Field Management: the warnings, the list, and add / edit / replace file /
 * delete. A permit blocks nothing (owner, 2026-10-26): the warnings are reminders an admin reads.
 *
 * Errors are announced in a `role="alert"` region; a delete is confirmed in a dialog that returns
 * focus to the page; opening a file makes a signed link on tap (two minutes) in a new tab.
 *
 * @param {object} props
 * @param {ReturnType<import('../../hooks/useFacilityPermits.js').useFacilityPermits>} props.permitState
 * @param {ReturnType<import('@squadlogic/core/facility/permits.js').permitWarnings> | null} props.warnings
 * @param {Array<{ id: string, name: string }>} props.locations
 * @param {Array<{ id: string, name: string, location_id: string }>} props.fields
 */
export default function FieldPermitsSection({ permitState, warnings, locations, fields }) {
  const {
    permits,
    loading,
    error,
    checkFile,
    createPermit,
    updatePermit,
    replaceFile,
    deletePermit,
    signedUrl,
  } = permitState;
  const [dialog, setDialog] = useState(/** @type {null | { permit?: any }} */ (null));
  const [deleting, setDeleting] = useState(/** @type {any} */ (null));
  const [busyId, setBusyId] = useState(/** @type {string|null} */ (null));
  const [notice, setNotice] = useState(
    /** @type {null | { kind: 'error' | 'info', text: string }} */ (null)
  );
  const addRef = useRef(null);
  const fileInputs = useRef(/** @type {Record<string, HTMLInputElement|null>} */ ({}));

  const sorted = useMemo(
    () =>
      [...permits].sort((a, b) => (a.valid_to < b.valid_to ? -1 : a.valid_to > b.valid_to ? 1 : 0)),
    [permits]
  );

  const fail = (err, what) => {
    logger.error(`[FieldPermitsSection] ${what}`, { message: err?.message });
    setNotice({ kind: 'error', text: err?.message || `${what} failed.` });
  };

  const save = async (input, file) => {
    setNotice(null);
    if (dialog?.permit) {
      await updatePermit(dialog.permit.id, input);
      setNotice({ kind: 'info', text: `Saved the permit from ${input.issuer.trim()}.` });
      return;
    }
    const { fileError } = await createPermit(input, file);
    if (fileError) {
      setNotice({
        kind: 'error',
        text: `The permit was saved, but its file was not: ${fileError} Add the file again from the permit.`,
      });
    } else {
      setNotice({ kind: 'info', text: `Added the permit from ${input.issuer.trim()}.` });
    }
  };

  const chooseReplacement = async (permit, event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    setBusyId(permit.id);
    try {
      await replaceFile(permit, file);
      setNotice({
        kind: 'info',
        text: `${permit.file ? 'Replaced' : 'Added'} the file for the permit from ${permit.issuer}.`,
      });
    } catch (err) {
      fail(err, 'The file could not be saved');
    } finally {
      setBusyId(null);
    }
  };

  const open = async (permit) => {
    setNotice(null);
    // The tab is opened on the tap itself so the browser does not take it for a popup; the link is
    // made once the answer comes (a signed link lives two minutes).
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const url = await signedUrl(permit.file.path);
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch (err) {
      tab?.close();
      fail(err, 'The file could not be opened');
    }
  };

  const download = async (permit) => {
    setNotice(null);
    try {
      const url = await signedUrl(permit.file.path, permit.file.name);
      const link = document.createElement('a');
      link.href = url;
      link.download = permit.file.name;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      fail(err, 'The file could not be downloaded');
    }
  };

  const confirmDelete = async () => {
    const permit = deleting;
    setBusyId(permit.id);
    try {
      await deletePermit(permit);
      setDeleting(null);
      setNotice({ kind: 'info', text: `Deleted the permit from ${permit.issuer}.` });
      // The row that held focus is gone: put it on the control that adds the next one.
      setTimeout(() => addRef.current?.focus(), 0);
    } catch (err) {
      setDeleting(null);
      fail(err, 'The permit could not be deleted');
    } finally {
      setBusyId(null);
    }
  };

  const hasWarnings = warnings && warnings.count > 0;

  return (
    <section
      className="bg-bg-surface border border-border-subtle rounded-xl p-5"
      aria-labelledby="permits-heading"
      data-testid="permits-section"
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 id="permits-heading" className="text-lg font-semibold text-text-primary">
          Permits
        </h2>
        <Button
          ref={addRef}
          variant="primary"
          size="sm"
          icon={Plus}
          onClick={() => setDialog({})}
          disabled={locations.length === 0}
        >
          Add permit
        </Button>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Keep each venue&rsquo;s and field&rsquo;s permit here so a coach can produce it when asked.
        A permit never stops an import, a schedule, a publish or an export; the warnings are
        reminders.
      </p>

      {error && (
        // A failed read is said politely, not as an alert: a permit blocks nothing and the page
        // beside it works; an action the person took that fails is the alert.
        <p className="badge danger" role="status" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}

      {warnings && (
        <div data-testid="permit-warnings" className="mb-4" role="status">
          {!hasWarnings ? (
            <p className="text-sm text-text-secondary">
              <CheckCircle2
                size={14}
                aria-hidden="true"
                style={{ display: 'inline', marginRight: 6 }}
              />
              Every live field has a current permit, and none is expiring or expired.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {warnings.fieldsWithout.length > 0 && (
                <li data-testid="permit-warning-missing">
                  <AlertTriangle
                    size={14}
                    aria-hidden="true"
                    style={{ display: 'inline', marginRight: 6 }}
                  />
                  {warnings.fieldsWithout.length}{' '}
                  {warnings.fieldsWithout.length === 1 ? 'field has' : 'fields have'} no current
                  permit:{' '}
                  {warnings.fieldsWithout
                    .map((f) => `${f.locationName ? `${f.locationName}, ` : ''}${f.name}`)
                    .join('; ')}
                </li>
              )}
              {warnings.expiring.length > 0 && (
                <li data-testid="permit-warning-expiring">
                  <Clock
                    size={14}
                    aria-hidden="true"
                    style={{ display: 'inline', marginRight: 6 }}
                  />
                  {warnings.expiring.length}{' '}
                  {warnings.expiring.length === 1 ? 'permit expires' : 'permits expire'} within 30
                  days:{' '}
                  {warnings.expiring
                    .map((p) => `${p.issuer} (${permitStatusText(p).toLowerCase()})`)
                    .join('; ')}
                </li>
              )}
              {warnings.expired.length > 0 && (
                <li data-testid="permit-warning-expired">
                  <AlertTriangle
                    size={14}
                    aria-hidden="true"
                    style={{ display: 'inline', marginRight: 6 }}
                  />
                  {warnings.expired.length}{' '}
                  {warnings.expired.length === 1 ? 'permit has' : 'permits have'} expired:{' '}
                  {warnings.expired
                    .map((p) => `${p.issuer} (${permitStatusText(p).toLowerCase()})`)
                    .join('; ')}
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      <div aria-live="polite">
        {notice && (
          <p
            className={`badge ${notice.kind === 'error' ? 'danger' : 'success'}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
            style={{ marginBottom: 12 }}
          >
            {notice.text}
          </p>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading permits…
        </p>
      ) : error ? null : sorted.length === 0 ? (
        <p className="text-sm text-text-muted" role="status">
          No permits recorded yet.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="permit-list">
          {sorted.map((permit) => {
            const Icon = STATUS_ICON[permit.status] ?? Clock;
            const busy = busyId === permit.id;
            return (
              <li
                key={permit.id}
                className="border border-border-subtle rounded-lg p-3"
                data-testid={`permit-${permit.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-text-primary">
                      {permit.issuer}
                      {permit.permit_number ? ` #${permit.permit_number}` : ''}
                    </div>
                    <div className="text-xs text-text-secondary">
                      {formatPermitDate(permit.valid_from)} to {formatPermitDate(permit.valid_to)}
                    </div>
                  </div>
                  <Badge tone={permitStatusTone(permit.status)}>
                    <Icon size={13} aria-hidden="true" /> {permitStatusText(permit)}
                  </Badge>
                </div>

                <div className="text-sm text-text-secondary mt-2">
                  Covers:{' '}
                  {permit.scopes.length === 0 ? (
                    <span>no field (the ground it covered was deleted)</span>
                  ) : (
                    permit.scopes.map(permitScopeText).join('; ')
                  )}
                </div>
                {permit.notes && <p className="text-sm text-text-secondary mt-1">{permit.notes}</p>}

                <div className="flex flex-wrap items-center gap-2 mt-3">
                  {permit.file ? (
                    <>
                      <span className="text-sm text-text-primary">
                        <FileText
                          size={14}
                          aria-hidden="true"
                          style={{ display: 'inline', marginRight: 4 }}
                        />
                        {permit.file.name} ({sizeText(permit.file.size)})
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={ExternalLink}
                        onClick={() => open(permit)}
                        aria-label={`Open the file for the permit from ${permit.issuer}`}
                      >
                        Open
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={Download}
                        onClick={() => download(permit)}
                        aria-label={`Download the file for the permit from ${permit.issuer}`}
                      >
                        Download
                      </Button>
                    </>
                  ) : (
                    <span className="text-sm text-text-secondary">No file yet.</span>
                  )}
                  <input
                    type="file"
                    hidden
                    ref={(node) => {
                      fileInputs.current[permit.id] = node;
                    }}
                    accept="application/pdf,image/jpeg,image/png"
                    aria-label={`${permit.file ? 'Replacement file' : 'File'} for the permit from ${permit.issuer}`}
                    onChange={(event) => chooseReplacement(permit, event)}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={Upload}
                    disabled={busy}
                    onClick={() => fileInputs.current[permit.id]?.click()}
                    aria-label={`${permit.file ? 'Replace' : 'Add'} the file for the permit from ${permit.issuer}`}
                  >
                    {permit.file ? 'Replace file' : 'Add file'}
                  </Button>
                  <span style={{ marginLeft: 'auto' }} className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Pencil}
                      onClick={() => setDialog({ permit })}
                      aria-label={`Edit the permit from ${permit.issuer}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost-danger"
                      size="sm"
                      icon={Trash2}
                      onClick={() => setDeleting(permit)}
                      aria-label={`Delete the permit from ${permit.issuer}`}
                    >
                      Delete
                    </Button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog && (
        <PermitDialog
          permit={dialog.permit}
          locations={locations}
          fields={fields}
          checkFile={checkFile}
          onSave={save}
          onClose={() => setDialog(null)}
        />
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title="Delete permit"
          icon={<Trash2 size={18} aria-hidden="true" />}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={confirmDelete} disabled={busyId === deleting.id}>
                Delete permit
              </Button>
            </>
          }
        >
          <p>
            Delete the permit from <strong>{deleting.issuer}</strong>
            {deleting.permit_number ? ` (#${deleting.permit_number})` : ''}
            {deleting.file ? ' and its file' : ''}? Coaches will no longer be able to open it. The
            settings history keeps a record of what it said.
          </p>
        </Modal>
      )}
    </section>
  );
}

FieldPermitsSection.propTypes = {
  permitState: PropTypes.object.isRequired,
  warnings: PropTypes.object,
  locations: PropTypes.arrayOf(PropTypes.object).isRequired,
  fields: PropTypes.arrayOf(PropTypes.object).isRequired,
};
