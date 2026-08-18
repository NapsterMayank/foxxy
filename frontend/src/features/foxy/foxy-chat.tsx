'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { Button } from '@/components/ui/button';
import { SUBJECTS, type Subject } from '@/lib/api/generated/constants/curriculum';
import { isFoxyAction } from '@/lib/api/generated/constants/foxy';
import { useT } from '@/lib/i18n/i18n-provider';
import { ActionBar } from './components/action-bar';
import { Composer } from './components/composer';
import { MessageList } from './components/message-list';
import { StartPanel } from './components/start-panel';
import {
  useFoxyCapabilities,
  useFoxyTranscript,
  useStartFoxySession,
} from './hooks/use-foxy-conversation';
import { useFoxyStream } from './hooks/use-foxy-stream';
import { foxyErrorMessage } from './lib/foxy-messages';

/**
 * ===========================================================================
 * THE FOXY SCREEN — build-order step 9.
 *
 * The ONE component that knows a stream exists. Everything under
 * `components/` takes props and renders them, which is §7's rendering rule and
 * the reason those pieces are testable by handing them an array.
 *
 * ---------------------------------------------------------------------------
 * THE STORED TRANSCRIPT AND THE LIVE MESSAGES ARE CONCATENATED, not merged.
 *
 * They cannot overlap: a completed turn marks the transcript stale without
 * refetching it, so the stored half of a mounted screen never grows. What a
 * reader sees is what existed when the screen opened, then everything since.
 * See `lib/transcript.ts` for why deduplication is not available as a fallback.
 * ===========================================================================
 */
/** The query parameter that makes a conversation survive a refresh. */
export const FOXY_SESSION_PARAM = 'session';
/** Set when the student arrived from a chapter — see `StartPanel.initialSubject`. */
export const FOXY_SUBJECT_PARAM = 'subject';

export function FoxyChat() {
  const t = useT();
  const router = useRouter();
  /*
   * THE OPEN SESSION LIVES IN THE URL, NOT IN COMPONENT STATE.
   *
   * §7 point 5 asks that "a page refresh shows the same history", and the
   * stored transcript alone cannot deliver that — a refresh with the id in
   * `useState` loses which conversation to load and drops the student back on
   * the start panel with their turns still sitting on the server, unreachable.
   * In the URL it is also shareable between the two tabs a phone user ends up
   * with, and back-navigable to the start panel for free.
   */
  const search = useSearchParams();
  const sessionId = search.get(FOXY_SESSION_PARAM);
  /*
   * Narrowed rather than trusted: a query string is user input, and an unknown
   * value must fall back to the picker rather than reach the API as a subject
   * the pilot does not carry.
   */
  const arrivedWith = SUBJECTS.find((code): code is Subject => code === search.get(FOXY_SUBJECT_PARAM));

  const capabilities = useFoxyCapabilities();
  const startSession = useStartFoxySession();
  const transcript = useFoxyTranscript(sessionId);
  /*
   * The hook is called UNCONDITIONALLY with a placeholder id, because hooks
   * cannot be conditional — and nothing can be sent before a session exists,
   * since every control that could send is behind the `sessionId === null`
   * branch below.
   */
  const stream = useFoxyStream(sessionId ?? '');

  if (capabilities.isPending) {
    return <LoadingState label={t('foxy.loadingTranscript')} />;
  }

  if (capabilities.error !== null) {
    return (
      <ErrorState
        description={foxyErrorMessage(capabilities.error, t)}
        onRetry={() => {
          void capabilities.refetch();
        }}
        retryLabel={t('foxy.retryAction')}
        title={t('foxy.errorCapabilities')}
      />
    );
  }

  const { actions, modes, usage } = capabilities.data;
  const isExhausted = usage.remaining <= 0;

  if (sessionId === null) {
    return (
      <div className="space-y-6">
        <UsageLine limit={usage.limit} remaining={usage.remaining} />
        <StartPanel
          {...(arrivedWith === undefined ? {} : { initialSubject: arrivedWith })}
          error={
            startSession.error === null
              ? undefined
              : foxyErrorMessage(startSession.error, t, { fallback: 'foxy.errorStartFailed' })
          }
          isPending={startSession.isPending}
          modes={modes}
          onStart={(input) => {
            startSession.mutate(input, {
              onSuccess: (response) => {
                // `replace`, not `push`: the start panel and the conversation
                // are the same screen in two states, and a back press should
                // leave Foxy rather than land on a panel that starts a second
                // session nobody asked for.
                router.replace(
                  `/student/foxy?${FOXY_SESSION_PARAM}=${encodeURIComponent(response.session.id)}`,
                );
              },
            });
          }}
        />
      </div>
    );
  }

  const messages = [...transcript.history, ...stream.messages];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <UsageLine limit={usage.limit} remaining={usage.remaining} />
        {/*
          Back to the start panel, which is this same route without the
          parameter. A LINK and not a button: it is a navigation, so it works
          with a middle click and reads as one to a screen reader.
        */}
        <Link
          className="inline-flex min-h-control items-center rounded-full px-4 py-3 text-sm font-semibold text-brand transition-surface duration-micro hover:bg-brand-subtle hover:text-brand-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
          href="/student/foxy"
        >
          {t('foxy.startAgainAction')}
        </Link>
      </div>

      {transcript.isLoading ? (
        <LoadingState label={t('foxy.loadingTranscript')} />
      ) : messages.length === 0 ? (
        <EmptyState description={t('foxy.emptyDescription')} title={t('foxy.emptyTitle')} />
      ) : (
        <MessageList messages={messages} />
      )}

      {/*
        THE TURN ERROR SITS BELOW THE TRANSCRIPT AND NEVER REPLACES IT. §7:
        "keep the partial text visible and offer retry. Never silently discard
        it." Rendering an `ErrorState` in place of the list would discard it
        visually, which to the student is the same thing.
      */}
      {stream.error === null ? null : (
        <div className="rounded-card border border-danger bg-surface p-4" role="alert">
          <p className="text-base font-semibold text-ink">{t('foxy.errorTitle')}</p>
          <p className="mt-1 text-sm leading-body text-muted">
            {foxyErrorMessage(stream.error, t)}
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              void stream.retry();
            }}
            variant="secondary"
          >
            {t('foxy.retryAction')}
          </Button>
        </div>
      )}

      <Composer
        isExhausted={isExhausted}
        isStreaming={stream.isStreaming}
        onSend={(text) => {
          void stream.send({ text });
        }}
        onStop={stream.cancel}
      />

      <ActionBar
        actions={actions}
        disabled={stream.isStreaming || isExhausted}
        onAction={(code) => {
          /*
           * NARROWED AT THE LAST MOMENT. The list is served, so a code this
           * build does not know can reach here — and `FoxySendInput.action` is
           * the generated union, which such a code does not satisfy. Dropping
           * it is better than casting: a cast would send a body the backend's
           * own contract rejects with a 400 the student cannot act on.
           */
          if (isFoxyAction(code)) void stream.send({ action: code });
        }}
      />
    </div>
  );
}

/**
 * Today's allowance, stated before it runs out rather than after.
 *
 * The number is a FACT FROM THE SERVER (`GET /foxy/capabilities`), which is why
 * the exhausted case is a plain sentence and not an error: nothing has failed,
 * and a student who sees "3 left" is not surprised by the fourth.
 */
function UsageLine({ limit, remaining }: { readonly limit: number; readonly remaining: number }) {
  const t = useT();

  return (
    <p className="text-sm text-muted" data-testid="foxy-usage">
      {remaining <= 0 ? t('foxy.usageExhausted') : t('foxy.usageRemaining', { limit, remaining })}
    </p>
  );
}
