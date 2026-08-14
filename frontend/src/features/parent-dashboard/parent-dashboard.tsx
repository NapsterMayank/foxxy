'use client';

import { useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { Button } from '@/components/ui/button';
import type { ParentChild } from './lib/parent-types';
import { ConsentPanel } from './components/consent-panel';
import { DigestPanel } from './components/digest-panel';
import { SnapshotPanel } from './components/snapshot-panel';
import { TranscriptPanel } from './components/transcript-panel';
import {
  useChildren,
  useConsent,
  useDigest,
  useRevokeConsent,
  useSnapshot,
  useTranscript,
} from './hooks/use-parent';
import { parentErrorMessage } from './lib/parent-messages';
import { useT } from '@/lib/i18n/i18n-provider';

/**
 * ===========================================================================
 * THE PARENT DASHBOARD — build-order step 12.
 *
 * ---------------------------------------------------------------------------
 * FOUR PANELS, FOUR QUERIES, FOUR INDEPENDENT FAILURES.
 *
 * The snapshot, the digest, the transcript and the consent state are four
 * endpoints answering four questions, and each renders its own loading and
 * failure. A page-level gate on all four would be as slow as the slowest and as
 * fragile as the weakest — the transcript is the biggest and the one a parent
 * looks at least, and it would hold up the counts they came for.
 *
 * ---------------------------------------------------------------------------
 * ONLY APPROVED CHILDREN ARE SELECTABLE.
 *
 * `approvedAt` is nullable on a link, and a pending one is a request the CHILD
 * has not answered. Offering it would produce a dashboard whose every request
 * 403s, and the parent would read that as the app being broken rather than as
 * their child not having approved yet.
 * ===========================================================================
 */
export function ParentDashboard() {
  const t = useT();
  const children = useChildren();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (children.isPending) return <LoadingState label={t('parentDashboard.loading')} />;

  if (children.error !== null) {
    return (
      <ErrorState
        description={parentErrorMessage(children.error, t)}
        onRetry={() => {
          void children.refetch();
        }}
        retryLabel={t('parentDashboard.retryAction')}
        title={t('parentDashboard.errorTitle')}
      />
    );
  }

  const approved = children.data.children.filter((child) => child.approvedAt !== null);
  const pending = children.data.children.filter((child) => child.approvedAt === null);

  if (approved.length === 0) {
    return (
      <EmptyState
        description={
          pending.length === 0
            ? t('parentDashboard.noChildrenDescription')
            : t('parentDashboard.pendingDescription')
        }
        title={
          pending.length === 0
            ? t('parentDashboard.noChildrenTitle')
            : t('parentDashboard.pendingTitle')
        }
      />
    );
  }

  const child = approved.find((candidate) => candidate.childUserId === selectedId) ?? approved[0];

  return (
    <div className="space-y-6 sm:space-y-8">
      <ChildPicker
        approved={approved}
        onSelect={setSelectedId}
        selectedId={child.childUserId}
      />
      <ChildPanels child={child} />
    </div>
  );
}

/**
 * Which child is being read about.
 *
 * RENDERED ONLY FOR TWO OR MORE. A "switch child" control above a single name
 * is a control that does nothing, and on this screen it also implies the parent
 * has children the product is not showing them.
 */
function ChildPicker({
  approved,
  onSelect,
  selectedId,
}: {
  readonly approved: readonly ParentChild[];
  readonly onSelect: (childUserId: string) => void;
  readonly selectedId: string;
}) {
  const t = useT();
  const current = approved.find((child) => child.childUserId === selectedId);

  if (approved.length < 2) {
    return (
      <p className="text-sm font-semibold text-muted">
        {t('parentDashboard.childLabel', {
          name: current?.displayName ?? '',
          grade: current?.grade ?? '',
        })}
      </p>
    );
  }

  return (
    <div aria-label={t('parentDashboard.childPickerLabel')} className="flex flex-wrap gap-2" role="group">
      {approved.map((child) => (
        <Button
          aria-pressed={child.childUserId === selectedId}
          key={child.childUserId}
          onClick={() => {
            onSelect(child.childUserId);
          }}
          variant={child.childUserId === selectedId ? 'primary' : 'secondary'}
        >
          {child.displayName}
        </Button>
      ))}
    </div>
  );
}

/** The four panels for one child. Each owns its own states. */
function ChildPanels({ child }: { readonly child: ParentChild }) {
  const t = useT();
  const childId = child.childUserId;

  const snapshot = useSnapshot(childId);
  const digest = useDigest(childId);
  const transcript = useTranscript(childId);
  const consent = useConsent(childId);
  const revoke = useRevokeConsent();

  return (
    <>
      <Panel
        error={snapshot.error}
        isPending={snapshot.isPending}
        label={t('parentDashboard.loading')}
        onRetry={() => {
          void snapshot.refetch();
        }}
      >
        {snapshot.data === undefined ? null : <SnapshotPanel snapshot={snapshot.data} />}
      </Panel>

      <Panel
        error={digest.error}
        isPending={digest.isPending}
        label={t('parentDashboard.loading')}
        onRetry={() => {
          void digest.refetch();
        }}
      >
        {digest.data === undefined ? null : <DigestPanel digest={digest.data.digest} />}
      </Panel>

      <Panel
        error={transcript.error}
        isPending={transcript.isPending}
        label={t('parentDashboard.loading')}
        onRetry={() => {
          void transcript.refetch();
        }}
      >
        {transcript.data === undefined ? null : <TranscriptPanel transcript={transcript.data} />}
      </Panel>

      <Panel
        error={consent.error}
        isPending={consent.isPending}
        label={t('parentDashboard.loading')}
        onRetry={() => {
          void consent.refetch();
        }}
      >
        {consent.data === undefined ? null : (
          <ConsentPanel
            consent={consent.data}
            error={revoke.error === null ? undefined : parentErrorMessage(revoke.error, t)}
            isRevoking={revoke.isPending}
            onRevoke={() => {
              revoke.mutate(childId);
            }}
          />
        )}
      </Panel>
    </>
  );
}

/**
 * One panel's three states.
 *
 * A FAILED PANEL DOES NOT TAKE THE PAGE DOWN. Each renders its own error with
 * its own retry, so a parent whose transcript request failed still reads the
 * week's counts — and still sees the consent controls, which is the one part of
 * this page they must always be able to reach.
 */
function Panel({
  children,
  error,
  isPending,
  label,
  onRetry,
}: {
  readonly children: React.ReactNode;
  readonly error: { readonly message: string } | null;
  readonly isPending: boolean;
  readonly label: string;
  readonly onRetry: () => void;
}) {
  const t = useT();

  if (isPending) return <LoadingState label={label} rows={2} />;
  if (error !== null) {
    return (
      <ErrorState
        description={t('parentDashboard.panelErrorDescription')}
        onRetry={onRetry}
        retryLabel={t('parentDashboard.retryAction')}
        title={t('parentDashboard.errorTitle')}
      />
    );
  }
  return <>{children}</>;
}
