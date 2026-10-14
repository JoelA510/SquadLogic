import React, { useId, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import Button from '../components/ui/Button.jsx';
import { CheckCircle2, UserPlus, ClipboardList, PenTool } from 'lucide-react';
import { logger } from '../lib/logger.js';

export default function RegistrationFlow() {
  const { formId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const userId = session?.user?.id;

  const [form, setForm] = useState(null);
  const [myChildren, setMyChildren] = useState([]);

  // Wizard State
  const [step, setStep] = useState(1);
  const [selectedPlayerId, setSelectedPlayerId] = useState(null);
  const [isCreatingNewPlayer, setIsCreatingNewPlayer] = useState(false);
  const newPlayerFieldId = useId();
  const [newPlayerName, setNewPlayerName] = useState({ first: '', last: '' });

  // Form Responses Data
  const [responses, setResponses] = useState({});
  const [waiverAgreed, setWaiverAgreed] = useState(false);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function init() {
      if (!userId || !formId) return;
      try {
        setLoading(true);
        // Load Form Definition
        const { data: formData, error: formErr } = await supabase
          .from('registration_forms')
          .select('*')
          .eq('id', formId)
          .single();
        if (formErr) throw formErr;
        setForm(formData);

        // Load existing children
        const { data: childrenData, error: childErr } = await supabase
          .from('profile_players')
          .select('player_id, players(id, first_name, last_name)')
          .eq('profile_id', userId);

        if (childErr) throw childErr;
        logger.log('[DEBUG] [RegistrationFlow] childrenData:', childrenData);
        const playerObjects = childrenData.map((c) => c.players).filter(Boolean);
        logger.log('[DEBUG] [RegistrationFlow] mapped players:', playerObjects);
        setMyChildren(playerObjects);

        // Initialize response object based on form fields
        const initialResponses = {};
        formData.fields?.forEach((f) => {
          initialResponses[f.label] = '';
        });
        setResponses(initialResponses);
      } catch (err) {
        logger.error(err);
        setError('Failed to load registration form.');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [formId, userId]);

  const handleNext = async () => {
    setError(null);
    if (step === 1) {
      if (!selectedPlayerId && !isCreatingNewPlayer) {
        setError('Please select or create a player to register.');
        return;
      }
      if (isCreatingNewPlayer && (!newPlayerName.first || !newPlayerName.last)) {
        setError('Please enter the first and last name of the new player.');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      // Validate Custom Fields
      const missing = form.fields.find((f) => f.required && !responses[f.label]);
      if (missing) {
        setError(`Please fill out the required field: ${missing.label}`);
        return;
      }
      setStep(3);
    }
  };

  const handleSubmit = async () => {
    if (!waiverAgreed) {
      setError('You must agree to the waiver to proceed.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Use the new atomic RPC for registration
      const { data: _regId, error: rpcErr } = await supabase.rpc('submit_registration', {
        p_organization_id: form.organization_id,
        p_form_id: form.id,
        p_profile_id: userId,
        p_responses: responses,
        p_player_id: isCreatingNewPlayer ? null : selectedPlayerId,
        p_first_name: isCreatingNewPlayer ? newPlayerName.first : null,
        p_last_name: isCreatingNewPlayer ? newPlayerName.last : null,
      });

      if (rpcErr) throw rpcErr;

      setSuccess(true);
    } catch (err) {
      logger.error(err);
      setError(err.message || 'Failed to submit registration. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading)
    return (
      <div className="text-center p-8 animate-pulse text-text-secondary">
        Loading Registration...
      </div>
    );
  if (!form)
    return <div className="text-center text-status-error p-8">{error || 'Form not found'}</div>;

  if (success) {
    return (
      <div className="max-w-2xl mx-auto mt-12 bg-bg-surface border border-border-highlight rounded-2xl p-8 text-center shadow-md relative overflow-hidden">
        <div className="absolute inset-0 bg-brand-glow z-0 pointer-events-none" />
        <div className="relative z-10 flex flex-col items-center">
          <CheckCircle2 size={64} className="text-status-success mb-6" />
          <h2 className="text-3xl font-display font-bold text-text-primary mb-4">
            Registration Complete
          </h2>
          <p className="text-text-secondary mb-8">
            You have successfully registered for {form.title}. The compliance dashboard has been
            updated.
          </p>
          <Button onClick={() => navigate('/')}>Return to Dashboard</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="bg-bg-surface/80 border border-border-subtle rounded-2xl p-8 shadow-md relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-brand-glow rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />
        <div className="relative z-10">
          <h1 className="text-3xl lg:text-4xl font-display font-bold text-text-primary mb-2 tracking-tight">
            {form.title}
          </h1>
          <p className="text-text-secondary text-lg">{form.description}</p>
        </div>
      </div>

      {/* Progress Indicator */}
      <div className="flex justify-center mb-8">
        <div className="flex items-center gap-4 text-sm font-semibold">
          <span
            className={`flex items-center gap-2 ${step >= 1 ? 'text-color-primary' : 'text-text-muted'}`}
          >
            <UserPlus size={16} /> Select Player
          </span>
          <div className="w-8 h-[2px] bg-border-subtle" />
          <span
            className={`flex items-center gap-2 ${step >= 2 ? 'text-color-primary' : 'text-text-muted'}`}
          >
            <ClipboardList size={16} /> Custom Form
          </span>
          <div className="w-8 h-[2px] bg-border-subtle" />
          <span
            className={`flex items-center gap-2 ${step >= 3 ? 'text-color-primary' : 'text-text-muted'}`}
          >
            <PenTool size={16} /> Waiver
          </span>
        </div>
      </div>

      <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6 lg:p-10 shadow-md">
        {error && (
          <div className="mb-6 p-4 bg-status-error-bg border border-status-error/30 text-status-error rounded-xl text-sm font-medium text-center">
            {error}
          </div>
        )}

        {/* Step 1: Select Player */}
        {step === 1 && (
          <div className="space-y-6 animate-fadeIn">
            <h3 className="text-2xl font-bold text-text-primary mb-4">Who are you registering?</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {myChildren.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => {
                    setSelectedPlayerId(child.id);
                    setIsCreatingNewPlayer(false);
                  }}
                  className={`w-full text-left p-4 rounded-xl border-2 transition-all ${selectedPlayerId === child.id && !isCreatingNewPlayer ? 'border-color-primary bg-brand-glow' : 'border-border-highlight bg-bg-app hover:border-color-primary/50'}`}
                >
                  <UserPlus
                    size={24}
                    className={
                      selectedPlayerId === child.id && !isCreatingNewPlayer
                        ? 'text-color-primary mb-2'
                        : 'text-text-muted mb-2'
                    }
                  />
                  <h4 className="font-bold text-text-primary">
                    {child.first_name} {child.last_name}
                  </h4>
                  <p className="text-xs text-text-secondary">Existing Profile</p>
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setIsCreatingNewPlayer(true);
                  setSelectedPlayerId(null);
                }}
                className={`w-full text-left p-4 rounded-xl border-2 transition-all ${isCreatingNewPlayer ? 'border-color-primary bg-brand-glow' : 'border-border-highlight bg-bg-app hover:border-color-primary/50'}`}
              >
                <UserPlus
                  size={24}
                  className={
                    isCreatingNewPlayer ? 'text-color-primary mb-2' : 'text-text-muted mb-2'
                  }
                />
                <h4 className="font-bold text-text-primary">New Player</h4>
                <p className="text-xs text-text-secondary">Register a new child</p>
              </button>
            </div>

            {isCreatingNewPlayer && (
              <div className="mt-6 p-6 bg-bg-app border border-border-highlight rounded-xl space-y-4 animate-scaleIn origin-top">
                <h4 className="font-semibold text-text-primary">Child&apos;s Details</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor={`${newPlayerFieldId}-first`}
                      className="block text-sm font-medium text-text-secondary mb-1"
                    >
                      First Name
                    </label>
                    <input
                      id={`${newPlayerFieldId}-first`}
                      type="text"
                      value={newPlayerName.first}
                      onChange={(e) =>
                        setNewPlayerName({ ...newPlayerName, first: e.target.value })
                      }
                      className="w-full bg-bg-surface border border-border-subtle rounded-lg p-3 text-text-primary focus:border-color-primary focus:outline-none focus:ring-1 focus:ring-color-primary"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`${newPlayerFieldId}-last`}
                      className="block text-sm font-medium text-text-secondary mb-1"
                    >
                      Last Name
                    </label>
                    <input
                      id={`${newPlayerFieldId}-last`}
                      type="text"
                      value={newPlayerName.last}
                      onChange={(e) => setNewPlayerName({ ...newPlayerName, last: e.target.value })}
                      className="w-full bg-bg-surface border border-border-subtle rounded-lg p-3 text-text-primary focus:border-color-primary focus:outline-none focus:ring-1 focus:ring-color-primary"
                    />
                  </div>
                </div>
                <p className="text-xs text-color-primary mt-2">
                  Note: Creating a new player will automatically link them to your authorized
                  profile for future scheduling.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Custom Form */}
        {step === 2 && (
          <div className="space-y-6 animate-fadeIn">
            <h3 className="text-2xl font-bold text-text-primary mb-4">Registration Details</h3>
            <div className="space-y-5">
              {form.fields &&
                form.fields.map((field, idx) => (
                  <div key={idx}>
                    <label
                      htmlFor={`custom-field-${idx}`}
                      className="block text-sm font-medium text-text-primary mb-1"
                    >
                      {field.label} {field.required && <span className="text-status-error">*</span>}
                    </label>
                    {field.type === 'text' && (
                      <input
                        id={`custom-field-${idx}`}
                        type="text"
                        aria-required={field.required ? 'true' : undefined}
                        value={responses[field.label] || ''}
                        onChange={(e) =>
                          setResponses({ ...responses, [field.label]: e.target.value })
                        }
                        className="w-full bg-bg-app border border-border-highlight rounded-lg p-3 text-text-primary focus:border-color-primary focus:outline-none"
                      />
                    )}
                    {/* More field types could be handled here (select, radio) */}
                    {field.type !== 'text' && (
                      <input
                        id={`custom-field-${idx}`}
                        type="text"
                        aria-required={field.required ? 'true' : undefined}
                        value={responses[field.label] || ''}
                        onChange={(e) =>
                          setResponses({ ...responses, [field.label]: e.target.value })
                        }
                        className="w-full bg-bg-app border border-border-highlight rounded-lg p-3 text-text-primary focus:border-color-primary focus:outline-none"
                      />
                    )}
                  </div>
                ))}
              {(!form.fields || form.fields.length === 0) && (
                <p className="text-text-secondary italic">No additional questions required.</p>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Waiver */}
        {step === 3 && (
          <div className="space-y-6 animate-fadeIn">
            <h3 className="text-2xl font-bold text-text-primary mb-2">Legal Waiver & Consents</h3>
            <p className="text-xs text-text-muted mb-4">
              Please read the following waiver carefully before agreeing.
            </p>

            <div className="bg-bg-app border border-border-highlight border-l-4 border-l-color-primary rounded-r-xl p-5 max-h-60 overflow-y-auto text-sm text-text-secondary">
              {form.waiver_text || 'Standard Liability Waiver: By signing this, I acknowledge...'}
            </div>

            <div className="flex items-start gap-4 p-4 border border-border-subtle rounded-xl bg-bg-app mt-6">
              <div className="pt-1">
                <input
                  type="checkbox"
                  id="waiver"
                  checked={waiverAgreed}
                  onChange={(e) => setWaiverAgreed(e.target.checked)}
                  className="w-5 h-5 rounded border-border-highlight bg-bg-surface text-color-primary focus:ring-color-primary focus:ring-offset-bg-surface"
                />
              </div>
              <label
                htmlFor="waiver"
                className="text-sm font-medium text-text-primary cursor-pointer leading-relaxed"
              >
                I have read, understand, and agree to the waiver extending to the organization,
                coaches, and staff. I certify that my child is medically cleared to play.
              </label>
            </div>
          </div>
        )}

        {/* Navigation Actions */}
        <div className="mt-10 pt-6 border-t border-border-subtle flex justify-between items-center">
          {step > 1 ? (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : (
            <div />
          )}

          {step < 3 ? (
            <Button variant="primary" onClick={handleNext}>
              Next Step
            </Button>
          ) : (
            <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Submitting...' : 'Complete Registration'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
