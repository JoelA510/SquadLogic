import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Contact } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient.js';
import { logger } from '../../lib/logger.js';
import Button from '../ui/Button.jsx';
import { ContactCardSchema, contactCardFormOf } from '../../utils/contactCard.js';

/**
 * The account page's contact card (Phase A2c): a phone, an email and whether to
 * share them. Wherever the app shows this person's contact details (a team's
 * staff, the coach directory, a roster's guardian contacts), a saved card
 * replaces what the league imported, and "Don't share" shows neither. Saved
 * through `set_my_contact_card`, the card's only writer.
 *
 * The saved card is read here, from the caller's own profile row, rather than
 * from the profile the auth context loaded at sign-in: nothing refreshes that
 * copy after a save, so a page opened again later would show the old card.
 */
export default function ContactCardSettings({ userId }) {
  const [form, setForm] = useState(() => contactCardFormOf(null));
  const [loadState, setLoadState] = useState(
    /** @type {'loading' | 'ready' | 'failed'} */ ('loading')
  );
  const [fieldErrors, setFieldErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(
    /** @type {{ type: 'success' | 'error', text: string } | null} */ (null)
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId) return;
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('contact_phone, contact_email, share_contact')
          .eq('id', userId)
          .maybeSingle();
        if (error) throw error;
        if (cancelled) return;
        setForm(contactCardFormOf(data));
        setLoadState('ready');
      } catch (error) {
        // A returned error or a transport failure: the form stays disabled.
        logger.error('Contact card read failed', error);
        if (!cancelled) setLoadState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const update = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: '' }));
    setMessage(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving || loadState !== 'ready') return;
    const parsed = ContactCardSchema.safeParse(form);
    if (!parsed.success) {
      const errors = /** @type {Record<string, string>} */ ({});
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.rpc('set_my_contact_card', {
        p_phone: parsed.data.phone,
        p_email: parsed.data.email,
        p_share: parsed.data.share,
      });
      if (error) throw error;
      setForm(contactCardFormOf(data));
      setMessage({ type: 'success', text: 'Contact card saved.' });
    } catch (error) {
      logger.error('Contact card update failed', error);
      setMessage({ type: 'error', text: error?.message || 'Could not save your contact card.' });
    } finally {
      setSaving(false);
    }
  };

  const describe = (id, error) => (error ? `${id}-error` : undefined);

  return (
    <section className="glass-panel p-6 space-y-6" aria-labelledby="account-contact-heading">
      <div>
        <h2
          id="account-contact-heading"
          className="text-xl font-bold text-text-primary flex items-center gap-2"
        >
          <Contact size={18} aria-hidden="true" />
          Contact card
        </h2>
        <p className="text-sm text-text-muted mt-1">
          The phone and email your team and league see for you. Until you save this card, they see
          the details your league imported.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        noValidate
        aria-describedby={fieldErrors.share ? 'account-contact-share-error' : undefined}
      >
        <div className="space-y-2">
          <label
            htmlFor="account-contact-phone"
            className="block text-sm font-medium text-text-secondary"
          >
            Phone
          </label>
          <input
            id="account-contact-phone"
            type="tel"
            value={form.phone}
            onChange={(event) => update('phone', event.target.value)}
            autoComplete="tel"
            aria-invalid={fieldErrors.phone ? true : undefined}
            aria-describedby={describe('account-contact-phone', fieldErrors.phone)}
            className="w-full glass-input"
          />
          {fieldErrors.phone && (
            <p id="account-contact-phone-error" className="text-xs text-status-error-text">
              {fieldErrors.phone}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label
            htmlFor="account-contact-email"
            className="block text-sm font-medium text-text-secondary"
          >
            Contact email
          </label>
          <input
            id="account-contact-email"
            type="email"
            value={form.email}
            onChange={(event) => update('email', event.target.value)}
            autoComplete="email"
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={describe('account-contact-email', fieldErrors.email)}
            className="w-full glass-input"
          />
          {fieldErrors.email && (
            <p id="account-contact-email-error" className="text-xs text-status-error-text">
              {fieldErrors.email}
            </p>
          )}
        </div>

        <fieldset className="md:col-span-2 space-y-2">
          <legend className="block text-sm font-medium text-text-secondary">Sharing</legend>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="account-contact-share"
              checked={form.share === true}
              onChange={() => update('share', true)}
            />
            Share this phone and email
          </label>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="account-contact-share"
              checked={form.share === false}
              onChange={() => update('share', false)}
            />
            Don&apos;t share my contact details
          </label>
          {fieldErrors.share && (
            <p id="account-contact-share-error" className="text-xs text-status-error-text">
              {fieldErrors.share}
            </p>
          )}
        </fieldset>

        <div className="md:col-span-2 flex flex-col sm:flex-row sm:items-center gap-3">
          <Button type="submit" variant="primary" disabled={saving || loadState !== 'ready'}>
            {saving ? 'Saving Contact Card...' : 'Save Contact Card'}
          </Button>
          {loadState === 'failed' && (
            <p role="alert" className="text-sm text-status-error-text">
              Your saved contact card could not be loaded. Reload the page to try again.
            </p>
          )}
          {message?.text && (
            <p
              role={message.type === 'error' ? 'alert' : 'status'}
              className={`text-sm ${
                message.type === 'error' ? 'text-status-error-text' : 'text-status-success-text'
              }`}
            >
              {message.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

ContactCardSettings.propTypes = {
  userId: PropTypes.string,
};
