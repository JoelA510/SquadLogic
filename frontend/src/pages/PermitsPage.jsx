import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Download, ExternalLink, FileText } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import PermitStatusBadge from '../components/permits/PermitStatusBadge.jsx';
import { useFacilityPermits } from '../hooks/useFacilityPermits.js';
import { sortPermitsForPage } from '@squadlogic/core/facility/permits.js';
import {
  PERMIT_NO_FILE_TEXT,
  formatPermitDate,
  permitScopeText,
  permitSizeText,
} from '../utils/permitText.js';
import { logger } from '../lib/logger.js';

/**
 * The admins' Field Permits page (docs/changes/2026-10-27-admin-only.md, decision 4; Phase C3's
 * coach page, made the admins' consolidated, quick access): every permit on record for the
 * organization, each with its number, issuer, dates and the fields it covers as text, and Open and
 * Download buttons of at least 44 px that make a short signed link on tap (two minutes). Adding,
 * changing and removing a permit stays in Fields & Venues (`FieldPermitsSection`); this page only
 * reads (`get_facility_permits`, an admin's), and says where to go to change one.
 *
 * **A permit blocks nothing** (owner, 2026-10-26): an expired permit, or one with no file, is
 * shown as it is. There is no offline copy (owner decision 6): "Download" saves the file, and the
 * number, issuer and dates stay readable as text.
 */
export default function PermitsPage() {
  const { permits, loading, error, signedUrl } = useFacilityPermits();
  const [notice, setNotice] = useState(/** @type {null | string} */ (null));
  const [busyId, setBusyId] = useState(/** @type {string|null} */ (null));
  const sorted = sortPermitsForPage(permits);

  const fail = (err, what) => {
    logger.error(`[PermitsPage] ${what}`, { message: err?.message });
    setNotice(err?.message || `${what}.`);
  };

  const open = async (permit) => {
    setNotice(null);
    setBusyId(permit.id);
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
    } finally {
      setBusyId(null);
    }
  };

  const download = async (permit) => {
    setNotice(null);
    setBusyId(permit.id);
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
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Page
      header={
        <PageHeader
          title="Field permits"
          subtitle="Every permit on record for your fields and venues. Open or download one when you are asked for it."
          icon={
            <span className="page-obj-icon permit-page-icon">
              <FileText size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      <div className="permit-page">
        <div aria-live="polite">{notice && <DataErrorBanner message={notice} />}</div>
        <p className="muted" data-testid="permits-manage-hint">
          To add, replace or remove a permit, go to <Link to="/fields">Fields &amp; Venues</Link>.
        </p>

        {loading && (
          <p className="muted" role="status">
            Loading field permits…
          </p>
        )}
        {!loading && error && (
          // A failed read is said politely (as on the admin's Permits section); a tap that fails
          // is the alert above.
          <p className="permit-read-error" role="status" data-testid="permits-error">
            <AlertTriangle size={16} aria-hidden="true" /> {error}
          </p>
        )}
        {!loading && !error && sorted.length === 0 && (
          <div className="card" data-testid="permits-empty">
            <div className="card-body muted">
              No permits are on record yet. Add one for a field or venue in{' '}
              <Link to="/fields">Fields &amp; Venues</Link> and it appears here.
            </div>
          </div>
        )}
        {!loading && !error && sorted.length > 0 && (
          <ul className="permit-card-list" data-testid="permits-page-list">
            {sorted.map((permit) => {
              const busy = busyId === permit.id;
              return (
                <li key={permit.id} className="card" data-testid={`permits-page-${permit.id}`}>
                  <div className="card-body">
                    <div className="permit-head">
                      <h2 className="permit-title">{permit.issuer}</h2>
                      <PermitStatusBadge permit={permit} />
                    </div>
                    <dl className="permit-facts">
                      {permit.permit_number && (
                        <div>
                          <dt>Permit number</dt>
                          <dd>{permit.permit_number}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Valid</dt>
                        <dd>
                          {formatPermitDate(permit.valid_from)} to{' '}
                          {formatPermitDate(permit.valid_to)}
                        </dd>
                      </div>
                      <div>
                        <dt>Covers</dt>
                        <dd>
                          {permit.scopes.length === 0
                            ? 'No field or venue'
                            : permit.scopes.map(permitScopeText).join('; ')}
                        </dd>
                      </div>
                      {permit.notes && (
                        <div>
                          <dt>Notes</dt>
                          <dd>{permit.notes}</dd>
                        </div>
                      )}
                    </dl>
                    {permit.file ? (
                      <>
                        <p className="permit-file-name">
                          <FileText size={14} aria-hidden="true" className="permit-inline-icon" />{' '}
                          {permit.file.name} ({permitSizeText(permit.file.size)})
                        </p>
                        <div className="permit-file-actions">
                          <button
                            type="button"
                            className="btn btn-primary permit-touch"
                            disabled={busy}
                            onClick={() => open(permit)}
                            aria-label={`Open the file for the permit from ${permit.issuer}`}
                          >
                            <ExternalLink size={16} aria-hidden="true" />
                            Open
                          </button>
                          <button
                            type="button"
                            className="btn btn-default permit-touch"
                            disabled={busy}
                            onClick={() => download(permit)}
                            aria-label={`Download the file for the permit from ${permit.issuer}`}
                          >
                            <Download size={16} aria-hidden="true" />
                            Download
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="permit-no-file">{PERMIT_NO_FILE_TEXT}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Page>
  );
}
