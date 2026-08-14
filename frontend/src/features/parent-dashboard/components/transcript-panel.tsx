'use client';

import { EmptyState } from '@/components/patterns/states';
import type { TranscriptResponse } from '@/lib/api/generated/contracts/parent.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import { formatDayAndMonth } from '@/lib/utils/format-date';
import { bilingual } from '../lib/bilingual';

/**
 * ===========================================================================
 * THE TRANSCRIPT — §10.4: "the transcript is read-only · THE CHILD'S
 * VISIBILITY INDICATOR IS ALWAYS PRESENT".
 *
 * ---------------------------------------------------------------------------
 * THE VISIBILITY NOTICE IS RENDERED BEFORE ANY BRANCH, AND OUTSIDE EVERY ONE.
 *
 * That placement is the whole component. A parent reading a child's
 * conversations is separated from surveillance ONLY by the child knowing, and
 * the contract makes `visibility` non-optional for exactly that reason — "an
 * optional field is a field a client can forget to render".
 *
 * So it is not inside the "has sessions" branch, not inside the "source is
 * foxy" branch, and not after an early return. Every path through this
 * component passes through it, including the empty one — the case where a
 * parent looks, sees nothing, and would otherwise have been told nothing about
 * what they were looking at.
 *
 * ---------------------------------------------------------------------------
 * `readOnly` IS A `z.literal(true)` ON THE WIRE. There is no write path and the
 * contract states it so no client goes looking for one. Nothing here renders a
 * reply box, a delete control, or anything else that would imply a parent can
 * act inside their child's conversation.
 *
 * ---------------------------------------------------------------------------
 * `not_yet_available` AND AN EMPTY LIST ARE DIFFERENT ANSWERS. The first means
 * the feature that would hold these has not shipped; the second means the child
 * has not used it. The contract keeps them apart precisely so a parent shown an
 * empty screen learns which — and conflating them would tell a parent their
 * child has never asked Foxy anything when the truth is nobody can see it yet.
 * ===========================================================================
 */

export interface TranscriptPanelProps {
  readonly transcript: TranscriptResponse;
}

export function TranscriptPanel({ transcript }: TranscriptPanelProps) {
  const t = useT();
  const { language } = useLanguage();

  return (
    <section aria-labelledby="parent-transcript-title" className="space-y-4">
      <h2
        className="text-xs font-bold uppercase tracking-widest text-brand"
        id="parent-transcript-title"
      >
        {t('parentDashboard.transcriptTitle')}
      </h2>

      <VisibilityNotice visibility={transcript.visibility} />

      {transcript.source === 'not_yet_available' ? (
        <EmptyState
          description={t('parentDashboard.transcriptUnavailableDescription')}
          title={t('parentDashboard.transcriptUnavailableTitle')}
        />
      ) : transcript.sessions.length === 0 ? (
        <EmptyState
          description={t('parentDashboard.transcriptEmptyDescription')}
          title={t('parentDashboard.transcriptEmptyTitle')}
        />
      ) : (
        <ol className="space-y-4">
          {transcript.sessions.map((session) => (
            <li
              className="rounded-card border border-line bg-surface p-4"
              key={session.sessionId}
            >
              <p className="text-sm font-semibold text-muted">
                {formatDayAndMonth(session.startedAt, language)}
              </p>

              <div className="mt-3 space-y-3">
                {session.messages.map((message) => (
                  <div key={message.id}>
                    <p className="text-xs font-bold uppercase tracking-widest text-brand">
                      {message.role === 'student'
                        ? t('parentDashboard.transcriptChild')
                        : t('parentDashboard.transcriptFoxy')}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-body text-ink">
                      {message.text}
                    </p>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * What the child knows about this page.
 *
 * TWO SEPARATE FACTS, and the second one changes the tone completely.
 * `parentCanView` is permission; `childIsTold` is whether the child has been
 * told. A parent with permission over a child who does not know is the shape
 * this product refuses to be, so that case is stated in `warning` rather than
 * passed over — and it is the server's own `disclosure` sentence that says it,
 * bilingual, because it is a promise the product makes and not copy a screen
 * invents.
 */
function VisibilityNotice({
  visibility,
}: {
  readonly visibility: TranscriptResponse['visibility'];
}) {
  const t = useT();
  const { language } = useLanguage();

  return (
    <div
      className={
        visibility.childIsTold
          ? 'rounded-card border border-line bg-brand-subtle p-4'
          : 'rounded-card border border-warning bg-warning/10 p-4'
      }
      data-child-told={visibility.childIsTold ? 'true' : 'false'}
      data-testid="transcript-visibility"
      // `note`, so it is reachable as a landmark. Not `alert`: it is a standing
      // statement about the page, not an event that just happened.
      role="note"
    >
      <p className="text-sm font-semibold text-ink">
        {visibility.childIsTold
          ? t('parentDashboard.visibilityChildTold')
          : t('parentDashboard.visibilityChildNotTold')}
      </p>
      <p className="mt-1 text-sm leading-body text-ink">
        {bilingual(visibility.disclosure, language)}
      </p>
      <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-muted">
        {t('parentDashboard.transcriptReadOnly')}
      </p>
    </div>
  );
}
