'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

export type OnboardingRole = 'student' | 'parent';

interface OnboardingFormProps {
  role: OnboardingRole;
}

function StudentFields() {
  return (
    <>
      <label className="block text-sm font-semibold text-ink">
        Display name
        <input
          autoComplete="name"
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          name="displayName"
          required
        />
      </label>
      <label className="block text-sm font-semibold text-ink">
        Grade
        <select
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          defaultValue=""
          name="grade"
          required
        >
          <option disabled value="">Choose your grade</option>
          <option value="6">Grade 6</option>
          <option value="7">Grade 7</option>
          <option value="8">Grade 8</option>
          <option value="9">Grade 9</option>
          <option value="10">Grade 10</option>
        </select>
      </label>
      <fieldset>
        <legend className="text-sm font-semibold text-ink">Preferred language</legend>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="inline-flex items-center gap-2 text-sm text-muted">
            <input className="h-4 w-4 accent-brand" defaultChecked name="language" type="radio" value="english" />
            English
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-muted">
            <input className="h-4 w-4 accent-brand" name="language" type="radio" value="hindi" />
            Hindi
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-semibold text-ink">Subjects to begin with</legend>
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

function ParentFields() {
  return (
    <>
      <label className="block text-sm font-semibold text-ink">
        Your name
        <input
          autoComplete="name"
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          name="name"
          required
        />
      </label>
      <label className="block text-sm font-semibold text-ink">
        Child invitation code
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
        <span>I confirm that I am the parent or legal guardian responsible for this child.</span>
      </label>
    </>
  );
}

export function OnboardingForm({ role }: OnboardingFormProps) {
  const [message, setMessage] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('Preview complete. These details will be saved after backend integration.');
  }

  return (
    <form className="space-y-5" method="post" onSubmit={handleSubmit}>
      {role === 'parent' ? <ParentFields /> : <StudentFields />}
      <button
        className="inline-flex min-h-control w-full items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white shadow-raised transition-surface duration-150 hover:bg-brand-strong hover:shadow-overlay focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press"
        data-motion="press"
        type="submit"
      >
        Continue
      </button>
      {message ? (
        <p className="text-center text-sm leading-6 text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}
