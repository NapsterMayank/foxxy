'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  adminPracticeSessionsResponseSchema,
  type AdminPracticeSession,
} from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';
import { Failure, useAdminData } from '@/components/screen';

/**
 * =============================================================================
 * PRACTICE SESSIONS — the ledger of every attempt, including the ones that did
 * not count.
 *
 * The three states this screen exists to keep apart are OPEN, SUBMITTED and
 * INVALID. They are easy to collapse into "finished / not finished" and that
 * collapse is exactly what hides the interesting rows:
 *
 *   - an INVALID session is still scored (at zero) and still recorded. Deleting
 *     it would erase the evidence of whatever produced it — a tab left open for
 *     an hour, a duplicate submit, a clock skew — so it stays in the list, in
 *     `.bad`, carrying its reason.
 *   - an OPEN session is not a failure. It is a session in progress or one
 *     abandoned mid-way, and rendering it like an invalid one would put a red
 *     row next to a child who simply walked away from their laptop.
 * =============================================================================
 */

/** Matches `adminPageQuerySchema`'s own default; stated so the URL is explicit. */
const PAGE_SIZE = 50;

/**
 * ISO in, ISO out — only the milliseconds and the `T` are dropped.
 *
 * The trailing `Z` STAYS. A timestamp on this panel gets compared against a
 * server log line; rendering it in the operator's local zone would produce a
 * different number with nothing on screen to say it had been shifted.
 */
function stamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+/, '');
}

interface SessionState {
  readonly label: string;
  /** Applied to the whole row, so the state colours every cell in it. */
  readonly rowClass: string;
  /** Only an invalid session has one, and an invalid session must show it. */
  readonly detail: string | null;
}

function stateOf(session: AdminPracticeSession): SessionState {
  // Order matters. `isValid === false` wins over everything: an invalidated
  // session that also happens to be unsubmitted is still, first, invalidated.
  if (session.isValid === false) {
    return {
      label: 'invalid',
      rowClass: 'bad',
      detail: session.invalidReason ?? 'no reason recorded',
    };
  }
  if (session.submittedAt === null) {
    // Open, not failed. `.warn` says "needs an eye on it", not "went wrong".
    return { label: 'open', rowClass: 'warn', detail: null };
  }
  return { label: 'submitted', rowClass: '', detail: null };
}

/**
 * True when a SUBMITTED session was handed fewer questions than it asked for.
 *
 * Served below target on a finished session is how a chapter that ran out of
 * questions looks from here — the session ended early because there was nothing
 * left to serve, not because the student stopped. While a session is still open
 * the same inequality is just progress, which is why the submitted check is part
 * of the condition rather than a separate note.
 */
function ranDry(session: AdminPracticeSession): boolean {
  return session.submittedAt !== null && session.questionsServed < session.targetQuestionCount;
}

function PracticeSessions({ studentUserId }: { studentUserId: string }) {
  const router = useRouter();

  const [draft, setDraft] = useState(studentUserId);
  /**
   * The cursors already followed, one per page beyond the first.
   *
   * A keyset cursor only walks forward, so "back" cannot be computed from the
   * current page — it has to be remembered. The stack is that memory and its
   * length is the page number.
   */
  const [cursors, setCursors] = useState<readonly string[]>([]);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (studentUserId !== '') query.set('studentUserId', studentUserId);
  const cursor = cursors[cursors.length - 1];
  if (cursor !== undefined) query.set('cursor', cursor);

  const { data, error, loading } = useAdminData(
    `${adminPaths.practiceSessions}?${query.toString()}`,
    adminPracticeSessionsResponseSchema,
  );

  const applyFilter = (): void => {
    const trimmed = draft.trim();
    router.replace(
      trimmed === '' ? '/practice' : `/practice?studentUserId=${encodeURIComponent(trimmed)}`,
    );
  };

  return (
    <>
      <h2>Practice sessions</h2>
      <p className="sub">
        Every attempt, in the order the server returns them. Invalid sessions are kept and
        shown: they are the evidence of whatever invalidated them.
      </p>

      <p>
        <label htmlFor="studentUserId">Student user id </label>
        <input
          id="studentUserId"
          value={draft}
          onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={(event) => { if (event.key === 'Enter') applyFilter(); }}
          placeholder="all students"
          size={38}
          style={{
            font: 'inherit',
            background: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--line)',
            borderRadius: 5,
            padding: '4px 8px',
          }}
        />{' '}
        <button type="button" onClick={applyFilter}>Filter</button>
        {studentUserId === '' ? null : (
          <>
            {' '}
            <button
              type="button"
              onClick={() => { setDraft(''); router.replace('/practice'); }}
            >
              Clear
            </button>
          </>
        )}
      </p>

      {error !== null ? (
        <Failure error={error} />
      ) : loading || data === null ? (
        /*
         * A loading state rather than the previous page's rows. `useAdminData`
         * keeps the old value until the new one lands, and drawing those rows
         * under a new cursor would present page one as page two.
         */
        <p className="muted">Loading practice sessions…</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Student</th>
                <th>Chapter</th>
                <th>Visit</th>
                <th>Started</th>
                <th>Submitted</th>
                <th className="num">Served / target</th>
                <th className="num">Score</th>
                <th className="num">XP</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((session) => {
                const state = stateOf(session);
                return (
                  <tr key={session.id} className={state.rowClass}>
                    <td>{session.id}</td>
                    <td>{session.studentUserId}</td>
                    <td>{session.chapterId}</td>
                    <td>{session.visitId ?? <span className="muted">none</span>}</td>
                    <td>{stamp(session.startedAt)}</td>
                    <td>
                      {session.submittedAt === null ? (
                        <span className="muted">still open</span>
                      ) : (
                        stamp(session.submittedAt)
                      )}
                    </td>
                    <td className={ranDry(session) ? 'num warn' : 'num'}>
                      <span
                        title={
                          ranDry(session)
                            ? 'Submitted with fewer questions than it asked for — the chapter ran dry.'
                            : 'Questions handed out, against the number this session intended to ask.'
                        }
                      >
                        {session.questionsServed} / {session.targetQuestionCount}
                      </span>
                    </td>
                    <td className="num">
                      {/*
                        An invalid session scores zero rather than nothing. The
                        number is real and is shown as one; `null` means the
                        session has not been scored yet, which is a third thing.
                      */}
                      {session.scorePercent === null ? (
                        <span className="muted">—</span>
                      ) : (
                        `${String(session.scorePercent)}%`
                      )}
                    </td>
                    <td className="num">
                      {session.xpEarned === null ? <span className="muted">—</span> : session.xpEarned}
                    </td>
                    <td>
                      {state.label}
                      {state.detail === null ? null : ` — ${state.detail}`}
                    </td>
                  </tr>
                );
              })}
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="muted">
                    No practice sessions on this page. This is the server answering, not a
                    failed request.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <p>
            <button
              type="button"
              disabled={cursors.length === 0}
              onClick={() => { setCursors((stack) => stack.slice(0, -1)); }}
            >
              Previous page
            </button>{' '}
            <button
              type="button"
              disabled={data.nextCursor === null}
              onClick={() => {
                const next = data.nextCursor;
                if (next !== null) setCursors((stack) => [...stack, next]);
              }}
            >
              Next page
            </button>{' '}
            <span className="muted">
              Page {cursors.length + 1} · {data.items.length} rows
              {data.nextCursor === null ? ' · last page' : ''}
            </span>
          </p>
        </>
      )}
    </>
  );
}

/**
 * Reads the filter and REMOUNTS the list when it changes.
 *
 * The `key` is doing real work. Every remembered cursor points into one
 * particular result set, so a filter change invalidates the whole pagination
 * stack — and remounting discards it as a consequence of the filter rather than
 * as a second thing somebody has to remember to do.
 */
function PracticeFilter() {
  const studentUserId = useSearchParams().get('studentUserId') ?? '';
  return <PracticeSessions key={studentUserId} studentUserId={studentUserId} />;
}

/**
 * `useSearchParams` suspends, so the boundary is required rather than tidy —
 * without it the whole route opts out of static rendering at build time.
 */
export default function PracticeSessionsScreen() {
  return (
    <Suspense fallback={<p className="muted">Loading practice sessions…</p>}>
      <PracticeFilter />
    </Suspense>
  );
}
