'use client';

import { useState, type FormEvent } from 'react';
import { FormField } from '@/components/patterns/form-field';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { MAX_QUESTION_CHARS } from '@/lib/api/generated/constants/foxy';
import { useT } from '@/lib/i18n/i18n-provider';

/**
 * ===========================================================================
 * THE FREE-TEXT TURN.
 *
 * Foxy is a GUIDED interface — the six buttons are the product — and this box
 * is the `doubt` mode's one open input. It is not a general chat field, which
 * is why it lives beside the action bar rather than above it.
 *
 * `MAX_QUESTION_CHARS` COMES FROM THE GENERATED CONSTANT and is enforced by
 * `maxLength` as well as counted. The backend applies the same number twice —
 * the Zod contract rejects a longer body with a 400, and the safety classifier
 * refuses it independently — so a client-side limit that disagreed would
 * produce a question the student watched themselves type and then lost.
 * ===========================================================================
 */

export interface ComposerProps {
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly isStreaming: boolean;
  /**
   * Today's allowance is spent. SEPARATE FROM `isStreaming`, because the two
   * disable the same control for opposite reasons and only one of them is
   * temporary.
   */
  readonly isExhausted: boolean;
}

export function Composer({ isExhausted, isStreaming, onSend, onStop }: ComposerProps) {
  const t = useT();
  const [text, setText] = useState('');

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !isStreaming && !isExhausted;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    // Cleared on send and not on success. The message is already in the
    // transcript by the time a frame arrives, and a box that keeps the question
    // invites a student to press send twice — which the hook refuses, silently.
    setText('');
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <FormField
        hint={t('foxy.composerRemaining', { remaining: MAX_QUESTION_CHARS - text.length })}
        label={t('foxy.composerLabel')}
      >
        <Textarea
          disabled={isExhausted}
          maxLength={MAX_QUESTION_CHARS}
          onChange={(event) => {
            setText(event.target.value);
          }}
          placeholder={t('foxy.composerPlaceholder')}
          rows={3}
          value={text}
        />
      </FormField>

      <div className="flex gap-3">
        <Button disabled={!canSend} type="submit">
          {t('foxy.sendAction')}
        </Button>
        {/*
          STOP IS RENDERED ONLY WHILE A TURN IS IN FLIGHT, rather than rendered
          always and disabled. A permanently visible stop button beside a send
          button is two primary-looking actions competing at rest, and the one
          that matters is send.
        */}
        {isStreaming ? (
          <Button onClick={onStop} variant="secondary">
            {t('foxy.stopAction')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
