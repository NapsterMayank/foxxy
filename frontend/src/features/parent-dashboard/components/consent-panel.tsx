'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import type { ConsentResponse } from '@/lib/api/generated/contracts/parent.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey } from '@/lib/i18n/translate';
import { bilingual } from '../lib/bilingual';

/**
 * ===========================================================================
 * WHAT THIS PARENT MAY SEE, AND HOW TO STOP.
 *
 * `canView` is a SERVED LIST, exactly like Foxy's action set: the screen shows
 * what the server grants rather than what this build happens to know about. A
 * local list would eventually claim access the backend does not give — and on
 * a consent screen, a claim about access is the one thing that must be true.
 *
 * ---------------------------------------------------------------------------
 * REVOKING GOES THROUGH `ConfirmDialog` AND NOT A PLAIN BUTTON.
 *
 * It is irreversible from this screen — the link moves to `revoked` and only
 * the child can approve a new one — so it gets the whole interaction the
 * pattern owns: the two-step, the focus trap, and a description that says what
 * will happen rather than asking "are you sure?".
 * ===========================================================================
 */

const viewLabelKeys: Readonly<Record<ConsentResponse['canView'][number], TranslationKey>> = {
  snapshot: 'parentDashboard.consentViewSnapshot',
  digest: 'parentDashboard.consentViewDigest',
  transcript: 'parentDashboard.consentViewTranscript',
};

export interface ConsentPanelProps {
  readonly consent: ConsentResponse;
  readonly onRevoke: () => void;
  readonly isRevoking: boolean;
  readonly error?: string;
}

export function ConsentPanel({ consent, error, isRevoking, onRevoke }: ConsentPanelProps) {
  const t = useT();
  const { language } = useLanguage();
  const [confirming, setConfirming] = useState(false);

  return (
    <section
      aria-labelledby="parent-consent-title"
      className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
    >
      <h2
        className="text-xs font-bold uppercase tracking-widest text-brand"
        id="parent-consent-title"
      >
        {t('parentDashboard.consentTitle')}
      </h2>

      <p className="mt-2 text-base leading-body text-ink">{bilingual(consent.notice, language)}</p>

      <ul className="mt-4 space-y-1">
        {consent.canView.map((item) => (
          <li className="text-sm text-ink" key={item}>
            {t(viewLabelKeys[item])}
          </li>
        ))}
      </ul>

      {/*
        STATED EITHER WAY. "Your child has been told" is reassurance; its absence
        is the thing a parent most needs to know and would never think to look
        for, so it is never rendered as silence.
      */}
      <p className="mt-4 text-sm font-semibold text-ink" data-child-informed={String(consent.childIsInformed)}>
        {consent.childIsInformed
          ? t('parentDashboard.consentChildInformed')
          : t('parentDashboard.consentChildNotInformed')}
      </p>

      <Button
        className="mt-6"
        disabled={isRevoking}
        onClick={() => {
          setConfirming(true);
        }}
        variant="secondary"
      >
        {t('parentDashboard.consentRevokeAction')}
      </Button>

      {error === undefined ? null : (
        <p className="mt-3 text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        cancelLabel={t('parentDashboard.consentRevokeCancel')}
        confirmLabel={t('parentDashboard.consentRevokeConfirm')}
        description={t('parentDashboard.consentRevokeDescription')}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          onRevoke();
        }}
        open={confirming}
        title={t('parentDashboard.consentRevokeTitle')}
      />
    </section>
  );
}
