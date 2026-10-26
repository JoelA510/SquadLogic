import React from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { OFFICIAL_SITE_URL } from '../env.js';
import { SELF_HOSTING_GUIDE_URL, hostedSiteNotice } from '../lib/demo.js';
import Modal from './ui/Modal.jsx';
import Button from './ui/Button.jsx';

/**
 * What a visitor sees instead of the file picker in a demo (plan
 * docs/changes/2026-10-22-demo-mode.md, D4). The demo holds placeholder data only and the server
 * refuses every import into it (D3), so the notice says so and offers the two ways to import for
 * real: an account on this deployment, or a SquadLogic of their own. On a deployment configured
 * with `VITE_OFFICIAL_SITE_URL`, and only off the official origin itself, it also names the hosted
 * service.
 *
 * The dialog is the shared `Modal`: focus is trapped in it and returns to the control that opened it.
 */
export default function DemoImportNotice({ open, onClose }) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const hosted = hostedSiteNotice(OFFICIAL_SITE_URL, window.location.origin);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Importing is turned off in the demo"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onClose();
              navigate('/?signup=1');
              signOut();
            }}
          >
            Create an account here
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0 }}>
          The demo league holds placeholder data only, so it cannot take a file of your own. To
          import your league&apos;s registrations, create an account on this site, or run SquadLogic
          yourself.
        </p>
        <p style={{ margin: 0 }}>
          <a href={SELF_HOSTING_GUIDE_URL} target="_blank" rel="noopener noreferrer">
            Run your own SquadLogic
          </a>
        </p>
        {hosted && (
          <p style={{ margin: 0 }}>
            SquadLogic is also hosted at{' '}
            <a href={hosted.url} target="_blank" rel="noopener noreferrer">
              {hosted.host}
            </a>
            .
          </p>
        )}
      </div>
    </Modal>
  );
}

DemoImportNotice.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
