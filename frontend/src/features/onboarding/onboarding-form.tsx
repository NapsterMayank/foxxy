'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { GRADES } from '@/lib/api/generated/constants/curriculum';
import { useT } from '@/lib/i18n/i18n-provider';
import { languages, type Translator } from '@/lib/i18n/translate';

export type OnboardingRole = 'student' | 'parent';

interface OnboardingFormProps {
  role: OnboardingRole;
}

function StudentFields({ t }: { t: Translator }) {
  return (
    <>
      <label className="block text-sm font-semibold text-ink">
        {t('onboarding.displayNameLabel')}
        <input
          autoComplete="name"
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          name="displayName"
          required
        />
      </label>
      <label className="block text-sm font-semibold text-ink">
        {t('onboarding.gradeLabel')}
        <select
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          defaultValue=""
          name="grade"
          required
        >
          <option disabled value="">
            {t('onboarding.gradePlaceholder')}
          </option>
          {/*
            GRADES COMES FROM THE BACKEND CONTRACT, not from a list retyped
            here. The generated constant is the same one the database CHECK is
            built from, so a hardcoded 6-10 cannot drift from a syllabus that
            runs to 12 — which it already had before this change.
          */}
          {GRADES.map((grade) => (
            <option key={grade} value={grade}>
              {t('onboarding.gradeOption', { grade })}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="text-sm font-semibold text-ink">{t('onboarding.languageLabel')}</legend>
        <div className="mt-3 flex flex-wrap gap-4">
          {/*
            THE VALUES ARE `en` AND `hi`, from the generated constant.
            They used to be `english` and `hindi`, which the learner contract
            rejects — root PROGRESS.md open item 34, latent only because nothing
            was posting yet. Sourcing them from the backend's own list means the
            form cannot offer a value the profile cannot store.
          */}
          {languages.map((code) => (
            <label className="inline-flex items-center gap-2 text-sm text-muted" key={code}>
              <input
                className="h-4 w-4 accent-brand"
                defaultChecked={code === 'en'}
                name="language"
                type="radio"
                value={code}
              />
              {code === 'en' ? t('common.english') : t('common.hindi')}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-semibold text-ink">{t('onboarding.subjectsLabel')}</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {['Mathematics', 'Science', 'English', 'Social Science'].map((subject) => (
            <label className="flex min-h-control items-center gap-3 rounded-card border border-line px-4 py-3 text-sm text-muted" key={subject}>
              <input className="h-4 w-4 accent-brand" name="subjects" type="checkbox" value={subject} />
              {subject}
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}

function ParentFields({ t }: { t: Translator }) {
  return (
    <>
      <label className="block text-sm font-semibold text-ink">
        {t('onboarding.parentNameLabel')}
        <input
          autoComplete="name"
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          name="name"
          required
        />
      </label>
      <label className="block text-sm font-semibold text-ink">
        {t('onboarding.linkCodeLabel')}
        <input
          autoCapitalize="characters"
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal uppercase text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          maxLength={12}
          name="invitationCode"
          required
        />
      </label>
      <label className="flex items-start gap-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 shrink-0 accent-brand" name="consent" required type="checkbox" />
        <span>{t('onboarding.consentLabel')}</span>
      </label>
    </>
  );
}

export function OnboardingForm({ role }: OnboardingFormProps) {
  const t = useT();
  const [message, setMessage] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(t('onboarding.previewComplete'));
  }

  return (
    <form className="space-y-6" method="post" onSubmit={handleSubmit}>
      {role === 'parent' ? <ParentFields t={t} /> : <StudentFields t={t} />}
      <button
        className="inline-flex min-h-control w-full items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white shadow-raised transition-surface duration-micro hover:bg-brand-strong hover:shadow-overlay focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press"
        data-motion="press"
        type="submit"
      >
        {t('onboarding.action')}
      </button>
      {message ? (
        <p className="text-center text-sm leading-6 text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}
