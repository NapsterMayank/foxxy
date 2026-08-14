'use client';

import { useState, type FormEvent } from 'react';
import { FormField } from '@/components/patterns/form-field';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { SUBJECTS, type Subject } from '@/lib/api/generated/constants/curriculum';
import { isFoxyMode, type FoxyMode } from '@/lib/api/generated/constants/foxy';
import type { FoxyCapabilitiesResponse } from '@/lib/api/generated/contracts/foxy.contract';
import { useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * OPENING A CONVERSATION — `POST /foxy/sessions`.
 *
 * TWO FIELDS AND NO GRADE. The contract is explicit: the grade comes from the
 * student's profile, because "a grade a caller could choose is a grade a caller
 * could choose wrongly" — a Grade 8 student who picks Grade 6 gets answers
 * grounded in the wrong textbook and no way to tell.
 * ===========================================================================
 */

/**
 * Mode codes to their copy.
 *
 * THE LABELS ARE LOCAL WHILE THE ACTION LABELS ARE SERVED, and the asymmetry is
 * the contract's, not an inconsistency here: `FoxyCapabilitiesResponse.modes`
 * carries a `code` and nothing else, where `actions` carries a bilingual label.
 * That is right — an action's label must not drift from the prompt it triggers,
 * and a mode triggers no prompt.
 *
 * A TABLE, so a mode the compiler does not know about has no key to render, and
 * `isFoxyMode` filters it out rather than showing a blank option. `TranslationKey`
 * makes a typo here a build failure.
 */
const modeLabelKeys: Readonly<Record<FoxyMode, TranslationKey>> = {
  doubt: 'foxy.modeOption.doubt',
  explain: 'foxy.modeOption.explain',
  practice: 'foxy.modeOption.practice',
};

const subjectLabelKeys: Readonly<Record<Subject, TranslationKey>> = {
  mathematics: 'onboarding.subjectOption.mathematics',
  science: 'onboarding.subjectOption.science',
};

export interface StartPanelProps {
  readonly modes: FoxyCapabilitiesResponse['modes'];
  readonly onStart: (input: { mode: FoxyMode; subject: Subject }) => void;
  readonly isPending: boolean;
  readonly error?: string;
}

export function StartPanel({ error, isPending, modes, onStart }: StartPanelProps) {
  const t = useT();
  const [mode, setMode] = useState<FoxyMode>('doubt');
  const [subject, setSubject] = useState<Subject>(SUBJECTS[0]);

  /*
   * The served list, narrowed to the modes this build can label. An unknown
   * code is DROPPED rather than rendered with an empty label — a nameless
   * option in a select is unpickable, and a student who picks it gets a session
   * in a mode they did not choose.
   */
  const offered = modes.map((entry) => entry.code).filter(isFoxyMode);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) return;
    onStart({ mode, subject });
  }

  return (
    <form className="max-w-prose space-y-4" onSubmit={submit}>
      <div>
        <h2 className="text-xl font-extrabold tracking-tight text-ink">{t('foxy.startTitle')}</h2>
        <p className="mt-2 text-base leading-body text-muted">{t('foxy.startDescription')}</p>
      </div>

      <FormField label={t('foxy.modeLabel')}>
        <Select
          onChange={(event) => {
            if (isFoxyMode(event.target.value)) setMode(event.target.value);
          }}
          value={mode}
        >
          {offered.map((code) => (
            <option key={code} value={code}>
              {t(modeLabelKeys[code])}
            </option>
          ))}
        </Select>
      </FormField>

      <FormField label={t('foxy.subjectLabel')}>
        <Select
          onChange={(event) => {
            const next = event.target.value;
            setSubject(SUBJECTS.find((candidate) => candidate === next) ?? SUBJECTS[0]);
          }}
          value={subject}
        >
          {SUBJECTS.map((code) => (
            <option key={code} value={code}>
              {t(subjectLabelKeys[code])}
            </option>
          ))}
        </Select>
      </FormField>

      {error === undefined ? null : (
        <p className="text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}

      <Button disabled={isPending} type="submit">
        {t('foxy.startAction')}
      </Button>
    </form>
  );
}
