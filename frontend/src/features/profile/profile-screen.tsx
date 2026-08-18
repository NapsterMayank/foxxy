'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { FormField } from '@/components/patterns/form-field';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { GRADES } from '@/lib/api/generated/constants/curriculum';
import {
  updateProfileRequestSchema,
  type StudentProfile,
  type UpdateProfileRequest,
} from '@/lib/api/generated/contracts/learner.contract';
import { fieldIssues, type FieldIssues } from '@/lib/forms/field-issues';
import { useT } from '@/lib/i18n/i18n-provider';
import { languages, type Translator } from '@/lib/i18n/translate';
import { useMyProfile, useUpdateProfile } from './hooks/use-profile';

/**
 * ===========================================================================
 * THE PROFILE SCREEN — `GET` and `PATCH /me/profile`.
 *
 * ---------------------------------------------------------------------------
 * IT SENDS THE DIFFERENCE, NOT THE FORM.
 *
 * `PATCH` is partial, and this screen keeps it partial. A student correcting
 * the spelling of their name sends `{ displayName }` and nothing else — no
 * grade, no language. The alternative, posting every field every time, writes
 * values nobody touched and is indistinguishable in the audit trail from a
 * student who deliberately changed their class.
 *
 * The same fact makes the button DISABLED while nothing differs. The contract
 * refuses an empty body ("an empty body would otherwise be a successful update
 * that changed nothing"), so there is no request to make; a live button that
 * produced a 400 would blame the server for a form with nothing in it.
 *
 * ---------------------------------------------------------------------------
 * A 404 IS NOT AN ERROR HERE.
 *
 * `/me/profile` 404s for an authenticated user who never finished onboarding —
 * a parent has no learner profile at all, and a student can reach this URL
 * between signing up and submitting the form. Rendering "something went wrong"
 * for a state the person can fix in one click is the error; the empty state
 * points at onboarding instead, and offers no retry, because retrying a 404 is
 * how you get the same 404.
 * ===========================================================================
 */
export function ProfileScreen() {
  const t = useT();
  const profile = useMyProfile();

  if (profile.isPending) return <LoadingState label={t('profileScreen.loading')} />;

  if (profile.error !== null) {
    if (profile.error.status === 404) {
      return (
        <EmptyState
          action={
            <Link
              className="inline-flex min-h-control items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-bold text-brand-fg transition-surface duration-micro hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/40"
              href="/onboarding?role=student"
            >
              {t('profileScreen.missingAction')}
            </Link>
          }
          description={t('profileScreen.missingDescription')}
          title={t('profileScreen.missingTitle')}
        />
      );
    }

    return (
      <ErrorState
        description={t('profileScreen.errorTitle')}
        onRetry={() => {
          void profile.refetch();
        }}
        retryLabel={t('profileScreen.retryAction')}
        title={t('profileScreen.errorTitle')}
      />
    );
  }

  /*
   * KEYED ON `updatedAt`, so the form remounts when the server's copy moves.
   * Without it the draft below survives a save and the inputs keep showing the
   * values the student submitted rather than the values the server stored —
   * identical whenever the write was accepted verbatim, and quietly wrong the
   * moment the backend normalises anything (it trims the display name).
   */
  return <ProfileForm key={profile.data.profile.updatedAt} profile={profile.data.profile} t={t} />;
}

interface Draft {
  readonly displayName: string;
  readonly grade: string;
  readonly preferredLanguage: string;
}

function draftOf(profile: StudentProfile): Draft {
  return {
    displayName: profile.displayName,
    grade: profile.grade,
    preferredLanguage: profile.preferredLanguage,
  };
}

/**
 * The fields that MOVED, as the PATCH body.
 *
 * Comparison is against the server's copy, not against a "touched" flag: a
 * student who types over their name and then types it back has changed
 * nothing, and sending a no-op write because the input received keystrokes is
 * how an untouched grade ends up in the audit log.
 */
function changesBetween(profile: StudentProfile, draft: Draft): UpdateProfileRequest {
  const original = draftOf(profile);
  const changes: Record<string, string> = {};

  for (const field of ['displayName', 'grade', 'preferredLanguage'] as const) {
    if (draft[field] !== original[field]) changes[field] = draft[field];
  }

  return changes as UpdateProfileRequest;
}

function ProfileForm({ profile, t }: { readonly profile: StudentProfile; readonly t: Translator }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));
  const [fields, setFields] = useState<FieldIssues>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = useUpdateProfile();

  const changes = changesBetween(profile, draft);
  const hasChanges = Object.keys(changes).length > 0;

  function set(field: keyof Draft, value: string): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormMessage(null);
    setSaved(false);

    /*
     * VALIDATED WITH THE GENERATED SCHEMA, which is the backend's own rules
     * copied by `contracts:sync`. A message beside the field beats a 400 that
     * arrives as one prose sentence with nothing attached to it (§5.6).
     */
    const parsed = updateProfileRequestSchema.safeParse(changes);
    if (!parsed.success) {
      setFields(fieldIssues(parsed.error));
      return;
    }

    setFields({});
    update.mutate(parsed.data, {
      onSuccess: () => {
        setSaved(true);
      },
      /*
       * The draft is NOT cleared. A refused save that also wipes what somebody
       * typed makes them do the work twice to find out whether it fails again.
       */
      onError: (error) => {
        setFormMessage(
          error.status === 409 ? t('profileScreen.errorConflict') : t('profileScreen.errorGeneric'),
        );
      },
    });
  }

  const errorFor = (field: keyof Draft): string | undefined => {
    if (fields[field] === undefined) return undefined;
    if (field === 'grade') return t('profileScreen.errorGradeRequired');
    if (field === 'preferredLanguage') return t('profileScreen.errorLanguageRequired');
    return t('profileScreen.errorDisplayNameRequired');
  };

  return (
    <form aria-busy={update.isPending} className="space-y-6" noValidate onSubmit={handleSubmit}>
      {/*
        NO HEADING HERE. The route owns the banner — eyebrow, `h1` and the
        description — exactly as `/student/progress` does. A second `h1` inside
        the form would give the page two, and the outline a screen reader reads
        is the one nobody looking at the design would notice was wrong.
      */}
      {formMessage === null ? null : (
        <p
          className="rounded-card border border-danger/30 bg-danger/5 p-4 text-sm leading-body text-danger"
          role="alert"
        >
          {formMessage}
        </p>
      )}

      {!saved ? null : (
        <p
          className="rounded-card border border-line bg-brand-subtle p-4 text-sm leading-body text-ink"
          role="status"
        >
          {t('profileScreen.saved')}
        </p>
      )}

      <FormField
        error={errorFor('displayName')}
        hint={t('profileScreen.displayNameHint')}
        label={t('profileScreen.displayNameLabel')}
        required
      >
        <Input
          autoComplete="name"
          name="displayName"
          onChange={(event) => {
            set('displayName', event.target.value);
          }}
          value={draft.displayName}
        />
      </FormField>

      <FormField error={errorFor('grade')} label={t('profileScreen.gradeLabel')} required>
        {/* GRADES from the generated constant — open item 34, one screen over. */}
        <Select
          name="grade"
          onChange={(event) => {
            set('grade', event.target.value);
          }}
          value={draft.grade}
        >
          {GRADES.map((grade) => (
            <option key={grade} value={grade}>
              {t('profileScreen.gradeOption', { grade })}
            </option>
          ))}
        </Select>
      </FormField>

      <fieldset>
        <legend className="text-sm font-semibold text-ink">
          {t('profileScreen.languageLabel')}
        </legend>
        {/*
          THE HINT IS NOT DECORATION. This field is the language the SERVER
          answers in; the switch in the header is the language THIS INTERFACE
          is written in, kept in a cookie on this device. Two controls, two
          scopes, and a student who changes one expecting the other has been
          misled by a screen that did not say which was which.
        */}
        <p className="mt-2 max-w-prose text-sm leading-body text-muted">
          {t('profileScreen.languageHint')}
        </p>
        <div className="mt-3 flex flex-wrap gap-4">
          {languages.map((code) => (
            <label
              className="inline-flex min-h-control items-center gap-2 rounded-card border border-line px-4 py-3 text-sm text-muted"
              key={code}
            >
              <input
                checked={draft.preferredLanguage === code}
                className="h-4 w-4 accent-brand"
                name="preferredLanguage"
                onChange={() => {
                  set('preferredLanguage', code);
                }}
                type="radio"
                value={code}
              />
              {code === 'en' ? t('common.english') : t('common.hindi')}
            </label>
          ))}
        </div>
      </fieldset>

      <section className="rounded-card border border-line bg-surface p-4">
        <p className="text-sm font-semibold text-ink">{t('profileScreen.boardLabel')}</p>
        <p className="mt-1 text-base font-bold text-ink">{profile.board}</p>
        <p className="mt-2 text-sm leading-body text-muted">{t('profileScreen.boardNote')}</p>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <Button disabled={!hasChanges || update.isPending} type="submit">
          {t('profileScreen.action')}
        </Button>
        {hasChanges ? null : (
          <p className="text-sm text-muted">{t('profileScreen.unchangedHint')}</p>
        )}
      </div>
    </form>
  );
}
