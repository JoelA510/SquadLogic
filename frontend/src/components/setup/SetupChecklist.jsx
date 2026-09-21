import React from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, CheckCircle2 } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import Button from '../ui/Button.jsx';
import { useSetupProgress } from '../../hooks/useSetupProgress.js';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';

/**
 * Resumable Season Setup checklist. Completion is derived from live data
 * (useSetupProgress), so jumping between steps never resets anything —
 * the deliberate opposite of the old destructive wizard.
 */
export default function SetupChecklist({ onNavigate = undefined }) {
  const navigate = useNavigate();
  const { steps, doneCount, total, percent, nextStep, error } = useSetupProgress();

  const go = (route) => {
    navigate(route);
    onNavigate?.(route);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Above the bar, not below it: when the dashboard sources fail, the
          three run-derived steps fall back to "Not started" and the
          percentage understates a season that may be finished. The operator
          has to read this before the number, not after it. */}
      <DataErrorBanner message={error} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <div
          className="bar"
          style={{ flex: 1 }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Season setup progress"
        >
          <i style={{ width: `${percent}%` }} />
        </div>
        <span className="tnum" style={{ fontWeight: 700 }}>
          {doneCount}/{total}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          background: 'var(--success-weak)',
          borderRadius: 'var(--r-md)',
          color: 'var(--success-text)',
          fontSize: 12.5,
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        <CheckCircle2 size={16} aria-hidden="true" />
        Progress is saved automatically. Jump to any step at any time — nothing resets when you go
        back.
      </div>
      {steps.map((step, index) => {
        const isNext = step.id === nextStep?.id;
        return (
          <div
            key={step.id}
            className={`setup-step ${step.done ? 'done' : isNext ? 'active' : ''}`}
          >
            <div className="step-num">
              {step.done ? <Check size={16} strokeWidth={3} aria-hidden="true" /> : index + 1}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{step.title}</span>
                {step.done && <Badge tone="success">Done</Badge>}
                {isNext && <Badge tone="info">Up next</Badge>}
                {step.count && (
                  <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                    {step.count}
                  </span>
                )}
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                {step.description}
              </div>
            </div>
            <Button
              variant={isNext ? 'primary' : 'secondary'}
              size="sm"
              icon={ArrowRight}
              onClick={() => go(step.route)}
            >
              {step.done ? 'Review' : isNext ? 'Continue' : 'Open'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

SetupChecklist.propTypes = {
  onNavigate: PropTypes.func,
};
