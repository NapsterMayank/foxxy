'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { FormField } from '@/components/patterns/form-field';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import {
  completeStudentOnboarding,
  submitLinkCode,
} from '@/features/onboarding/api/onboarding-requests';
import { isApiError, treatmentFor, type ApiError } from '@/lib/api/errors';
import { GRADES, SUBJECTS } from '@/lib/api/generated/constants/curriculum';
import { submitLinkRequestSchema } from '@/lib/api/generated/contracts/identity.contract';
import { onboardingRequestSchema } from '@/lib/api/generated/contracts/learner.contract';
import { fieldIssues, type FieldIssues } from '@/lib/forms/field-issues';
import { useT } from '@/lib/i18n/i18n-provider';
import { languages, type TranslationKey, type Translator } from '@/lib/i18n/translate';

export type OnboardingRole = 'student' | 'parent';

interface OnboardingFormProps {
  role: OnboardingRole;
}

/**
 * The subject list, from the GENERATED CONSTANT and not from a list typed here.
 *
 * The presentational form offered Mathematics, Science, English and Social
 * Science. `SUBJECTS` is `['mathematics', 'science']` — the pilot scope, and
 * the same list the database CHECK is built from. Two of those four options
 * would have written subjects with no chapters, no questions and no corpus
 * behind them, and the student would have met that as an empty practice
 * screen rather than as an error. It is open item 34 again, one field over.
 */
const subjectLabelKeys: Readonly<Record<(typeof SUBJECTS)[number], TranslationKey>> = {
  mathematics: 'onboarding.subjectOption.mathematics',
  science: 'onboarding.subjectOption.science',
};

export function OnboardingForm({ role }: OnboardingFormProps) {
  const t = useT();
  const router = useRouter();
  const [fields, setFields] = useState<FieldIssues>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [consentMissing, setConsentMissing] = useState(false);

  const student = useMutation({ mutationFn: completeStudentOnboarding });
  const parent = useMutation({ mutationFn: submitLinkCode });
  const isPending = student.isPending || parent.isPending;

  function fail(error: unknown): void {
    if (!isApiError(error)) throw error;
    setSuccessMessage(null);
    setFormMessage(onboardingMessage(error, t));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setFormMessage(null);

    if (role === 'parent') {
      /*
       * THE CONSENT BOX IS CHECKED HERE AND HAS NO WIRE FIELD. `/links/submit`
       * takes a code and nothing else. It is a gate on this screen, not a
       * record — and saying so is better than implying the backend stores an
       * attestation it has never been sent.
       */
      if (data.get('consent') === null) {
        setConsentMissing(true);
        setFields({});
        return;
      }
      setConsentMissing(false);

      const value = data.get('code');
      const parsed = submitLinkRequestSchema.safeParse({
        code: typeof value === 'string' ? value : '',
      });
      if (!parsed.success) {
        setFields(fieldIssues(parsed.error));
        return;
      }

      setFields({});
      parent.mutate(parsed.data, {
        /*
         * A LINK STARTS `pending` AND GRANTS NOTHING. Saying "connected" here
         * would be a lie the student has not agreed to yet (§6.8), so the copy
         * names the approval that still has to happen.
         */
        onSuccess: () => {
          setSuccessMessage(t('onboarding.linkPending'));
        },
        onError: fail,
      });
      return;
    }

    const parsed = onboardingRequestSchema.safeParse({
      displayName: data.get('displayName'),
      grade: data.get('grade'),
      preferredLanguage: data.get('language'),
      subjects: data.getAll('subjects'),
    });
    if (!parsed.success) {
      setFields(fieldIssues(parsed.error));
      return;
    }

    setFields({});
    student.mutate(parsed.data, {
      onSuccess: () => {
        setSuccessMessage(t('onboarding.studentSaved'));
        router.replace('/student');
      },
      onError: fail,
    });
  }

  const errorFor = (field: string): string | undefined =>
    fields[field] === undefined ? undefined : onboardingFieldMessage(field, t);

  return (
    <form aria-busy={isPending} className="space-y-6" method="post" noValidate onSubmit={handleSubmit}>
      {formMessage === null ? null : (
        <p
          className="rounded-card border border-danger/30 bg-danger/5 p-4 text-sm leading-body text-danger"
          role="alert"
        >
          {formMessage}
        </p>
      )}
      {successMessage === null ? null : (
        <p
          className="rounded-card border border-line bg-brand-subtle p-4 text-sm leading-body text-ink"
          role="status"
        >
          {successMessage}
        </p>
      )}

      {role === 'parent' ? (
        <ParentFields consentMissing={consentMissing} error={errorFor} t={t} />
      ) : (
        <StudentFields error={errorFor} t={t} />
      )}

      <Button className="w-full" disabled={isPending} type="submit">
        {isPending ? t('auth.waitAction') : t('onboarding.action')}
      </Button>
    </form>
  );
}

type ErrorLookup = (field: string) => string | undefined;

function StudentFields({ error, t }: { error: ErrorLookup; t: Translator }) {
  return (
    <>
      <FormField error={error('displayName')} label={t('onboarding.displayNameLabel')} required>
        <Input autoComplete="name" name="displayName" />
      </FormField>

      <FormField error={error('grade')} label={t('onboarding.gradeLabel')} required>
        {/*
          GRADES COMES FROM THE BACKEND CONTRACT, not from a list retyped here.
          The generated constant is the same one the database CHECK is built
          from, so a hardcoded 6-10 cannot drift from a syllabus that runs to 12.
        */}
        <Select defaultValue="" name="grade">
          <option disabled value="">
            {t('onboarding.gradePlaceholder')}
          </option>
          {GRADES.map((grade) => (
            <option key={grade} value={grade}>
              {t('onboarding.gradeOption', { grade })}
            </option>
          ))}
        </Select>
      </FormField>

      <fieldset>
        <legend className="text-sm font-semibold text-ink">{t('onboarding.languageLabel')}</legend>
        <div className="mt-3 flex flex-wrap gap-4">
          {languages.map((code) => (
            /*
              `min-h-control` and real padding — §12's 44px, on the LABEL,
              because a wrapping label is what a finger actually hits and the
              radio itself is a 16px user-agent control that CSS does not
              meaningfully resize.
              It measured 68x21 and 50x21. The browser suite found it the first
              time it ever ran against these screens; the subject checkboxes
              below already had this and these did not.
            */
            <label
              className="inline-flex min-h-control items-center gap-2 rounded-card border border-line px-4 py-3 text-sm text-muted"
              key={code}
            >
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
          {SUBJECTS.map((subject) => (
            <label
              className="flex min-h-control items-center gap-3 rounded-card border border-line px-4 py-3 text-sm text-muted"
              key={subject}
            >
              <input className="h-4 w-4 accent-brand" name="subjects" type="checkbox" value={subject} />
              {t(subjectLabelKeys[subject])}
            </label>
          ))}
        </div>
        {error('subjects') === undefined ? null : (
          <p className="mt-2 text-sm font-semibold leading-body text-danger" role="alert">
            {error('subjects')}
          </p>
        )}
      </fieldset>
    </>
  );
}

function ParentFields({
  consentMissing,
  error,
  t,
}: {
  consentMissing: boolean;
  error: ErrorLookup;
  t: Translator;
}) {
  return (
    <>
      <FormField
        error={error('code')}
        hint={t('onboarding.linkCodeHint')}
        label={t('onboarding.linkCodeLabel')}
        required
      >
        <Input autoCapitalize="characters" className="uppercase" maxLength={6} name="code" />
      </FormField>

      <label className="flex items-start gap-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 shrink-0 accent-brand" name="consent" type="checkbox" />
        <span>{t('onboarding.consentLabel')}</span>
      </label>
      {consentMissing ? (
        <p className="text-sm font-semibold leading-body text-danger" role="alert">
          {t('onboarding.errorConsentRequired')}
        </p>
      ) : null}
    </>
  );
}

/** Field copy, chosen by name — the same reason as `authFieldMessage`. */
function onboardingFieldMessage(field: string, t: Translator): string {
  switch (field) {
    case 'displayName':
      return t('onboarding.errorDisplayNameRequired');
    case 'grade':
      return t('onboarding.errorGradeRequired');
    case 'subjects':
      return t('onboarding.errorSubjectsRequired');
    case 'code':
      return t('onboarding.errorLinkCodeInvalid');
    default:
      return t('auth.errorRequired');
  }
}

function onboardingMessage(error: ApiError, t: Translator): string {
  const treatment = treatmentFor(error);

  switch (treatment.kind) {
    /*
     * A CODE THAT DOES NOT RESOLVE IS A 404, and it is the one failure a parent
     * on this screen can actually act on — the codes expire, and the fix is to
     * ask the child for a new one rather than to retype the old one.
     */
    case 'not-found':
      return t('onboarding.errorLinkCodeUnknown');
    case 'rate-limited':
      return treatment.retryAfterSeconds === null
        ? t('auth.errorRateLimited')
        : t('auth.errorRateLimitedSeconds', { seconds: treatment.retryAfterSeconds });
    case 'degraded':
      return t('auth.errorDegraded');
    case 'action-blocked':
      return t('auth.errorBlocked');
    default:
      return t('auth.errorGeneric');
  }
}
