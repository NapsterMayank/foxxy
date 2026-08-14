'use client';

import { EmptyState } from '@/components/patterns/states';
import type { DigestResponse } from '@/lib/api/generated/contracts/parent.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import { bilingual } from '../lib/bilingual';

/**
 * ===========================================================================
 * THE WEEKLY DIGEST — §8.7: "names a misconception and one concrete action,
 * never a percentage".
 *
 * ---------------------------------------------------------------------------
 * THE MISCONCEPTION IS NULL FOR ESSENTIALLY EVERY REAL WEEK, AND THE DIGEST
 * MUST READ WELL ANYWAY.
 *
 * The contract states it plainly: `misconceptionCode` is null today (D-077 —
 * nothing links a pattern to a distractor yet) and "a client must render the
 * digest with no misconception named, because that is the NORMAL case". So the
 * summary and the suggested action are the digest; the misconception is an
 * extra line when it exists, not a slot that sits empty.
 *
 * A layout built around the missing field — a heading with nothing under it, or
 * "no misconception detected" — would tell a parent every week that something
 * was absent, when what is absent is content generation.
 *
 * ---------------------------------------------------------------------------
 * A NULL DIGEST IS "NOT WRITTEN YET", NOT A FAILURE. `GET` never generates one,
 * which the contract says in as many words, so an absent digest for the current
 * week is the ordinary state of a Tuesday.
 * ===========================================================================
 */

export interface DigestPanelProps {
  readonly digest: DigestResponse['digest'];
}

export function DigestPanel({ digest }: DigestPanelProps) {
  const t = useT();
  const { language } = useLanguage();

  if (digest === null) {
    return (
      <EmptyState
        description={t('parentDashboard.digestPendingDescription')}
        title={t('parentDashboard.digestPendingTitle')}
      />
    );
  }

  return (
    <section
      aria-labelledby="parent-digest-title"
      className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
    >
      <h2
        className="text-xs font-bold uppercase tracking-widest text-brand"
        id="parent-digest-title"
      >
        {t('parentDashboard.digestTitle')}
      </h2>

      <p className="mt-2 text-base leading-body text-ink">{bilingual(digest.summary, language)}</p>

      <div className="mt-4 rounded-card bg-brand-subtle p-4">
        <p className="text-xs font-bold uppercase tracking-widest text-brand-strong">
          {t('parentDashboard.digestActionTitle')}
        </p>
        <p className="mt-1 text-base leading-body text-ink">
          {bilingual(digest.suggestedAction, language)}
        </p>
      </div>

      {/*
        THE CODE IS RENDERED AS A CODE, and only when there is one. It is a
        machine identifier with no bilingual prose behind it — the misconception
        catalogue has no Hindi description and the source has no such column
        (open item 14) — so it is labelled as a reference rather than dressed up
        as a sentence somebody wrote for this parent.
      */}
      {digest.misconceptionCode === null ? null : (
        <p className="mt-4 text-sm text-muted">
          {t('parentDashboard.digestMisconception', { code: digest.misconceptionCode })}
        </p>
      )}

      <p className="mt-4 text-sm text-muted">
        {t('parentDashboard.digestCounts', {
          days: digest.daysPractised,
          sessions: digest.sessionsCount,
          questions: digest.questionsAnswered,
        })}
      </p>
    </section>
  );
}
