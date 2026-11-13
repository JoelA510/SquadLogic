/**
 * The pieces both kinds of the schedule import panel show (PR 6's, moved here unchanged in PR 11 so the Practices
 * tab's steps, a chunk of their own, show them the same way): a message with an icon and a word, and a list of
 * sentences that names the first few and counts the rest.
 */
import React from 'react';
import { AlertCircle, CheckCircle, Info } from 'lucide-react';

/** How many rows of a list are named on screen; the rest are counted. */
export const NAMED = 25;

/**
 * A list of sentences, the first `NAMED` named and the rest counted.
 *
 * @param {{ items: string[], total: number, testId: string, heading: string }} props
 */
export function NamedList({ items, total, testId, heading }) {
  if (total <= 0) return null;
  const shown = items.slice(0, NAMED);
  const more = total - shown.length;
  return (
    <section data-testid={testId} className="mt-4">
      <h4 className="text-sm font-semibold text-text-primary mb-1">{`${heading} (${total})`}</h4>
      <ul className="text-sm text-text-secondary space-y-1 break-words list-disc pl-5">
        {shown.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
      {more > 0 && <p className="text-xs text-text-muted mt-1">{`and ${more} more`}</p>}
    </section>
  );
}

/**
 * A message with an icon and a word, never colour alone.
 *
 * @param {{ tone?: 'info' | 'error' | 'warning' | 'success', testId?: string, children: any, role?: string }} props
 */
export function Notice({ tone = 'info', testId, children, role }) {
  const styles = {
    info: 'border-border-subtle bg-bg-surface text-text-secondary',
    error: 'border-status-error/30 bg-status-error-bg text-status-error-text',
    warning: 'border-status-warning/30 bg-status-warning/10 text-status-warning-text',
    success: 'border-border-subtle bg-bg-surface text-status-success-text',
  };
  const Icon = tone === 'success' ? CheckCircle : tone === 'info' ? Info : AlertCircle;
  return (
    <div
      data-testid={testId}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${styles[tone]}`}
    >
      <Icon size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}
