'use client';

import { Badge } from '@/components/ui/badge';
import type { FoxyCitationDto } from '@/lib/api/generated/contracts/foxy.contract';
import { useT } from '@/lib/i18n/i18n-provider';
import { cx } from '@/lib/utils/cx';
import type { FoxyStreamMessage } from '../hooks/use-foxy-stream';

/**
 * ===========================================================================
 * THE TRANSCRIPT — 02-FRONTEND-IMPLEMENTATION-PLAN.md §7's rendering rule.
 *
 * "The component that renders messages is PURELY PRESENTATIONAL and receives
 * `messages` as a prop. It knows nothing about SSE." That is why it takes an
 * array and no session id, calls no hook that fetches, and can be handed seven
 * fixtures in a test with no network at all.
 *
 * ---------------------------------------------------------------------------
 * THE LIVE REGION ANNOUNCES ONCE, AT THE END, NOT ONCE PER TOKEN.
 *
 * `role="log"` with `aria-live="polite"` is the right container for a
 * conversation. Left alone it would also be unusable: a token frame arrives
 * every few milliseconds, and a polite region that changes that often reads a
 * screen-reader user a stuttering word salad.
 *
 * `aria-busy` on the streaming bubble is what fixes it. While the attribute is
 * true the assistive technology holds its announcement; when the turn settles
 * the attribute drops and the finished answer is read once, whole. That is also
 * why `aria-busy` sits on the BUBBLE and not on the log — a busy log would
 * suppress the student's own message going in.
 * ===========================================================================
 */

export interface MessageListProps {
  readonly messages: readonly FoxyStreamMessage[];
  readonly className?: string;
}

export function MessageList({ className, messages }: MessageListProps) {
  const t = useT();

  return (
    <div
      aria-label={t('foxy.transcriptLabel')}
      aria-live="polite"
      className={cx('space-y-4', className)}
      data-testid="foxy-transcript"
      role="log"
    >
      {messages.map((message) => (
        <MessageBubble key={message.localId} message={message} />
      ))}
    </div>
  );
}

const bubbleByRole: Readonly<Record<FoxyStreamMessage['role'], string>> = {
  // The student's own words sit on the brand, right-aligned — the universal
  // "this one is mine" of every chat interface a child has already used.
  user: 'ml-auto bg-brand text-brand-fg',
  assistant: 'mr-auto border border-line bg-surface text-ink',
};

export function MessageBubble({ message }: { readonly message: FoxyStreamMessage }) {
  const t = useT();
  const isStreaming = message.status === 'streaming';

  return (
    <article
      aria-busy={isStreaming ? true : undefined}
      className={cx(
        'max-w-prose rounded-card px-4 py-3 shadow-raised',
        bubbleByRole[message.role],
      )}
      data-role={message.role}
      data-status={message.status}
    >
      <p
        className={cx(
          'text-xs font-bold uppercase tracking-widest',
          message.role === 'user' ? 'text-brand-fg' : 'text-brand',
        )}
      >
        {message.role === 'user' ? t('foxy.youLabel') : t('foxy.foxyLabel')}
      </p>

      {/*
        `whitespace-pre-wrap`: the model writes steps on their own lines, and a
        collapsed run of newlines turns a worked solution into one paragraph.
      */}
      <p className="mt-1 whitespace-pre-wrap text-base leading-body">{message.text}</p>

      {isStreaming ? (
        <p className="mt-2 text-sm text-muted" data-testid="foxy-streaming">
          {t('foxy.streamingLabel')}
        </p>
      ) : null}

      {/*
        AN ABSTENTION IS LABELLED `info`, NEVER `warning` OR `danger`. It is a
        successful answer — the grounding rail working — and a red or amber
        badge would teach a student that honesty from the tutor is a fault.
      */}
      {message.abstained ? (
        <Badge className="mt-3" tone="info">
          {t('foxy.abstainedLabel')}
        </Badge>
      ) : null}

      {message.truncated ? <p className="mt-2 text-sm text-muted">{t('foxy.truncatedNotice')}</p> : null}

      {message.citations.length > 0 ? <CitationList citations={message.citations} /> : null}
    </article>
  );
}

/**
 * Where the answer came from.
 *
 * NOT DECORATION. The citations are the difference between this product and a
 * chatbot, and they are verified mid-stream on the server precisely so that
 * what reaches here can be shown as fact. A chapter with no number or no title
 * still gets a row: the chunk was used, and silently dropping it would make an
 * answer look less grounded than it is.
 */
export function CitationList({ citations }: { readonly citations: readonly FoxyCitationDto[] }) {
  const t = useT();

  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-xs font-bold uppercase tracking-widest text-muted">
        {t('foxy.citationsTitle')}
      </p>
      <ul className="mt-2 space-y-1">
        {citations.map((citation) => (
          <li className="text-sm leading-body text-muted" key={citation.chunkId}>
            {citation.chapterNumber === null || citation.chapterTitle === null
              ? t('foxy.citationUnknownChapter')
              : t('foxy.citationChapter', {
                  number: citation.chapterNumber,
                  title: citation.chapterTitle,
                })}
          </li>
        ))}
      </ul>
    </div>
  );
}
