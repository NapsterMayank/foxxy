'use client';

import { useState } from 'react';
import { revealResponseSchema, REVEAL_REASONS } from '@/lib/api/generated/contracts/admin.contract';
import { ApiError, adminRequest } from '@/lib/api/client';
import { adminPaths } from '@/lib/api/paths';

/**
 * =============================================================================
 * REVEAL — the only control in this app that discloses anything.
 *
 * Everything else renders what the server already masked. This asks for the
 * real value, and its design is entirely about making that a deliberate act:
 *
 *   - THE REASON IS REQUIRED AND IS A CHOICE, not a text box. `audit_log`
 *     stores identifiers and counts only, so a code is what the server accepts;
 *     a text box here would collect something that cannot be stored and would
 *     teach the operator the reason does not matter.
 *   - THE BUTTON SAYS WHAT WILL HAPPEN. "Reveal (audited)" rather than "Show",
 *     because the audit row is the point and a control that hid it would be
 *     collecting consent it never asked for.
 *   - THE VALUE IS NOT KEPT. It lives in component state until the operator
 *     navigates away. Nothing caches it, nothing stores it, and re-reading it
 *     costs a second audit row — which is correct: two readings are two events.
 * =============================================================================
 */

export interface RevealProps {
  readonly resourceType: 'user' | 'learner' | 'chat_session' | 'retrieval_trace';
  readonly resourceId: string;
  readonly field: string;
  /** What is shown before the reveal — the server's masked value. */
  readonly masked: React.ReactNode;
}

export function Reveal({ resourceType, resourceId, field, masked }: RevealProps) {
  const [value, setValue] = useState<string | string[] | null>(null);
  const [reason, setReason] = useState<string>(REVEAL_REASONS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (value !== null) {
    return (
      <span>
        {Array.isArray(value) ? (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{value.join('\n')}</pre>
        ) : (
          value
        )}{' '}
        <span className="muted" title="This reading is recorded in audit_log.">
          (revealed — audited)
        </span>
      </span>
    );
  }

  const run = (): void => {
    setBusy(true);
    setError(null);
    adminRequest({
      path: adminPaths.reveal,
      method: 'POST',
      schema: revealResponseSchema,
      body: { resourceType, resourceId, fields: [field], reasonCode: reason },
    })
      .then((response) => {
        // The server returns only the fields asked for; this reads back the one
        // it asked for rather than assuming a shape.
        setValue(response.revealed[field] ?? '');
        setBusy(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : 'Reveal failed.');
        setBusy(false);
      });
  };

  return (
    <span>
      {masked}{' '}
      <select
        value={reason}
        onChange={(event) => { setReason(event.target.value); }}
        aria-label="Reason for revealing"
        style={{ font: 'inherit', background: 'var(--line)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4 }}
      >
        {REVEAL_REASONS.map((code) => (
          <option key={code} value={code}>{code}</option>
        ))}
      </select>{' '}
      <button type="button" onClick={run} disabled={busy}>
        {busy ? 'Revealing…' : 'Reveal (audited)'}
      </button>
      {error === null ? null : <span className="bad"> {error}</span>}
    </span>
  );
}
