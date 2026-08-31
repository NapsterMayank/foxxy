'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { adminActivityResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';
import { Failure, useAdminData } from '@/components/screen';

/**
 * =============================================================================
 * ONE LEARNER, ONE TIMELINE — the D-401 view.
 *
 * VISITS ARE THE POINT OF THIS SCREEN, which is why the count is a headline and
 * not a column. Before the visit id existed, a learner's day was N chat rows
 * plus M practice rows joined by nothing but a student id and a clock — and a
 * clock cannot separate two sittings in one afternoon from one long one. The
 * number below answers "how many separate sittings was this", and no arrangement
 * of timestamps can answer it after the fact.
 *
 * OUTCOME IS NOT FLATTENED. `empty`/`used` for chat and `open`/`submitted` for
 * practice are two genuinely different lifecycles: a chat with no questions in
 * it is not a half-finished practice set. Collapsing them into one "completed"
 * flag would read beautifully and be false, so the column shows the vocabulary
 * of the kind and the legend says which is which.
 * =============================================================================
 */

/** Matches the users list; the server would default to this anyway. */
const PAGE_LIMIT = 50;

const count = (total: number, one: string, many: string): string =>
  `${String(total)} ${total === 1 ? one : many}`;

export default function LearnerActivityPage({ params }: { params: Promise<{ id: string }> }) {
  // Same choice as the detail page: unwrap the params promise here rather than
  // splitting the screen in two. See the note there.
  const { id } = use(params);

  // Forward-only keyset pagination, so going back means remembering. See the
  // longer note in `users/page.tsx`.
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.at(-1);

  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor !== undefined) query.set('cursor', cursor);
  const path = `${adminPaths.learnerActivity(id)}?${query.toString()}`;

  const { data, error, loading } = useAdminData(path, adminActivityResponseSchema);
  const nextCursor = data?.nextCursor ?? null;

  /*
   * Rows with no visit id are counted separately because the server counts
   * DISTINCT NON-NULL visit ids. Folding them into `visits` would invent
   * sittings; leaving them out silently would make the arithmetic look wrong
   * ("4 activities across 1 visit"). So they are stated, as their own fact.
   */
  const withoutVisit = data === null ? 0 : data.items.filter((item) => item.visitId === null).length;

  return (
    <>
      <h2>Activity</h2>
      <p className="sub">
        <Link href="/users">Users</Link> /{' '}
        <Link href={`/users/${encodeURIComponent(id)}`}>{id}</Link> / activity
      </p>

      {error !== null ? (
        <Failure error={error} />
      ) : loading ? (
        <p className="muted">Loading activity…</p>
      ) : data === null ? (
        <p className="muted">Nothing to show.</p>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 18 }}>
            {/*
              TWO SCOPES IN ONE SENTENCE, SAID OUT LOUD.

              `items` is this page. `visits` is the learner's whole history —
              it was page-scoped until D-403, which made it wrong in two
              directions: a sitting spanning a page boundary got counted twice
              by anyone walking pages, and a learner with more visits than fit
              on a page was under-reported.

              Fixing the number left the label behind, and "3 activities across
              0 visits" under one heading reads as an arithmetic bug. Naming
              each scope where it applies is the only honest rendering.
            */}
            <div className="label">Activity</div>
            <div className="value">
              {count(data.items.length, 'activity', 'activities')} on this page
            </div>
            <div className="value">
              {count(data.visits, 'visit', 'visits')} all time
            </div>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              A visit is one sitting. Two practice runs and a chat in the same
              afternoon are one visit; the same three spread over two evenings
              are two. The server counts distinct visit ids, because a timestamp
              cannot tell those apart.
            </p>
            {withoutVisit > 0 ? (
              <p className="muted" style={{ margin: '6px 0 0' }}>
                {count(withoutVisit, 'row carries', 'rows carry')} no visit id —
                recorded before the column existed, or sent by a client with no
                header. Each is its own unknown sitting, and none of them is
                counted above.
              </p>
            ) : null}
            {nextCursor !== null ? (
              <p className="muted" style={{ margin: '6px 0 0' }}>
                Counted over this page only. A later page can hold more of the
                same visit.
              </p>
            ) : null}
          </div>

          {data.items.length === 0 ? (
            <p className="muted">No activity on this page.</p>
          ) : (
            <>
              <p className="muted">
                Outcome uses the vocabulary of its kind: chat reads empty or
                used, practice reads open or submitted. They are different
                lifecycles and are not flattened into one flag.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Ref</th>
                    <th>Visit</th>
                    <th>Chapter</th>
                    <th>Started</th>
                    <th>Last event</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    // `kind` is part of the key: a chat and a practice row are
                    // separate tables server-side and could collide on refId.
                    <tr key={`${item.kind}:${item.refId}`}>
                      <td>{item.kind}</td>
                      <td className="muted">{item.refId}</td>
                      <td>
                        {item.visitId === null ? (
                          /*
                            Rendered per row, never as a shared "unknown" bucket.
                            Two nulls are two rows whose sitting is unknown — not
                            one sitting they were both part of.
                          */
                          <span className="muted">unknown visit</span>
                        ) : (
                          item.visitId
                        )}
                      </td>
                      <td className="muted">
                        {item.chapterId === null ? 'none' : item.chapterId}
                      </td>
                      <td>{item.startedAt}</td>
                      <td>
                        {item.lastEventAt === null ? (
                          <span className="muted">no events</span>
                        ) : (
                          item.lastEventAt
                        )}
                      </td>
                      <td>{item.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {error === null ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => { setCursors((spent) => spent.slice(0, -1)); }}
            disabled={loading || cursors.length === 0}
          >
            Previous page
          </button>
          <button
            type="button"
            onClick={() => {
              if (nextCursor !== null) setCursors((spent) => [...spent, nextCursor]);
            }}
            disabled={loading || nextCursor === null}
          >
            Next page
          </button>
          <span className="muted">
            Page {cursors.length + 1}, {PAGE_LIMIT} per page
            {!loading && nextCursor === null ? ' — last page' : ''}
          </span>
        </div>
      ) : null}
    </>
  );
}
