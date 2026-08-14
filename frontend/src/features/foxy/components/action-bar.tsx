'use client';

import { Button } from '@/components/ui/button';
import type { FoxyCapabilitiesResponse } from '@/lib/api/generated/contracts/foxy.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';

/**
 * ===========================================================================
 * THE FIXED ACTION SET — the six buttons that ARE the product.
 *
 * ---------------------------------------------------------------------------
 * THE LIST AND ITS LABELS COME FROM THE SERVER. NOTHING HERE IS HARDCODED.
 *
 * `FOXY_ACTIONS` exists in the generated constants and this component
 * deliberately does not read it. The contract says why in as many words: a
 * client with its own copy of the list eventually renders a button the server
 * does not implement, "and that fails at the moment a child presses it".
 *
 * The labels are the same argument one level down. They live beside the prompt
 * each action produces, on the server, so a label and its prompt cannot drift —
 * and a button that drifts from its prompt is a button doing something other
 * than what it says.
 *
 * The consequence is that this component renders whatever arrives, including an
 * action shipped after this build. That is the intent, not a gap.
 * ===========================================================================
 */

export interface ActionBarProps {
  readonly actions: FoxyCapabilitiesResponse['actions'];
  readonly onAction: (code: string) => void;
  readonly disabled: boolean;
}

export function ActionBar({ actions, disabled, onAction }: ActionBarProps) {
  const t = useT();
  const { language } = useLanguage();

  if (actions.length === 0) return null;

  return (
    <section aria-labelledby="foxy-actions-title">
      <h2 className="text-xs font-bold uppercase tracking-widest text-muted" id="foxy-actions-title">
        {t('foxy.actionsTitle')}
      </h2>
      {/*
        `flex-wrap`, not a horizontal scroller. Six 44px targets wrap to three
        rows at 360px and sit on one at 1280px; a scroller would hide half of
        the product's entire vocabulary behind a gesture nobody is told about.
      */}
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            disabled={disabled}
            key={action.code}
            onClick={() => {
              onAction(action.code);
            }}
            variant="secondary"
          >
            {action.label[language]}
          </Button>
        ))}
      </div>
    </section>
  );
}
