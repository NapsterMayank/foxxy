'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  adminChatSessionsResponseSchema,
  type AdminChatSession,
} from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';
import { Failure, useAdminData } from '@/components/screen';

/**
 * =============================================================================
 * FOXY SESSIONS — a list of conversations, with no conversation in it.
 *
 * Nothing on this screen is message text and nothing on it can become message
 * text; the wire shape carries counts and timings only. What that leaves is
 * still the two things worth scanning a list for:
 *
 *   - A SESSION WITH NO MESSAGES. Somebody opened Foxy and never said anything.
 *     That is a real event and it is worth counting — it is the shape of a
 *     student who could not work out what to do, or of a client that created a
 *     session it never used. It is NOT a short conversation, so it is muted and
 *     labelled rather than shown as a row with a small number in it.
 *   - ABSTENTIONS AGAINST MESSAGES. A session where Foxy repeatedly said "I
 *     could not find this in your textbook" is either a retrieval gap or a
 *     student asking about something the corpus does not cover. Either way it is
 *     the row an operator came here to find.
 * =============================================================================
 */

/** Matches `adminPageQuerySchema`'s own default; stated so the URL is explicit. */
const PAGE_SIZE = 50;

/**
 * The line above which a session counts as abstention-heavy.
 *
 * The denominator is `messageCount`, which counts BOTH sides of the
 * conversation — so a rate of 0.25 here is roughly half of Foxy's own turns
 * ending in an abstention. The per-answer rate is about double what is shown.
 * Stated rather than corrected for, because the wire does not carry an
 * assistant-turn count and inventing one would be a guess presented as a
 * measurement.
 */
const ABSTENTION_HEAVY = 0.25;

/**
 * ISO in, ISO out — only the milliseconds and the `T` are dropped. The trailing
 * `Z` stays so the value still matches a server log line.
 */
function stamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+/, '');
}

function abstentionRate(session: AdminChatSession): number | null {
  if (session.messageCount === 0) return null;
  return session.abstentions / session.messageCount;
}

export default function FoxySessionsScreen() {
  /** See the practice list: a keyset cursor only walks forward, so back is a stack. */
  const [cursors, setCursors] = useState<readonly string[]>([]);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  const cursor = cursors[cursors.length - 1];
  if (cursor !== undefined) query.set('cursor', cursor);

  const { data, error, loading } = useAdminData(
    `${adminPaths.foxySessions}?${query.toString()}`,
    adminChatSessionsResponseSchema,
  );

  return (
    <>
      <h2>Foxy sessions</h2>
      <p className="sub">
        Counts and timings only — no message text reaches this screen. Open a session for
        the shape of its turns.
      </p>

      {error !== null ? (
        <Failure error={error} />
      ) : loading || data === null ? (
        // Not the previous page's rows: see the same note on the practice list.
        <p className="muted">Loading Foxy sessions…</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Student</th>
                <th>Mode</th>
                <th>Subject</th>
                <th>Chapter</th>
                <th>Language</th>
                <th>Visit</th>
                <th>Started</th>
                <th>Last message</th>
                <th className="num">Messages</th>
                <th className="num">Abstentions</th>
                <th className="num">Rate</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((session) => {
                const rate = abstentionRate(session);
                const heavy = rate !== null && rate >= ABSTENTION_HEAVY;
                const unused = session.messageCount === 0;
                return (
                  <tr key={session.id} className={unused ? 'muted' : ''}>
                    <td>
                      <Link href={`/foxy/sessions/${session.id}`}>{session.id}</Link>
                    </td>
                    <td>{session.studentUserId}</td>
                    <td>{session.mode}</td>
                    <td>{session.subject}</td>
                    <td>{session.chapterId ?? <span className="muted">none</span>}</td>
                    <td>{session.language}</td>
                    <td>{session.visitId ?? <span className="muted">none</span>}</td>
                    <td>{stamp(session.startedAt)}</td>
                    <td>
                      {session.lastMessageAt === null ? (
                        <span className="muted">never</span>
                      ) : (
                        stamp(session.lastMessageAt)
                      )}
                    </td>
                    <td className="num">{session.messageCount}</td>
                    <td className={heavy ? 'num warn' : 'num'}>{session.abstentions}</td>
                    <td className={heavy ? 'num warn' : 'num'}>
                      {rate === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span title="Abstentions over all turns, both sides. Foxy's own rate is about double this.">
                          {Math.round(rate * 100)}%
                        </span>
                      )}
                    </td>
                    <td>
                      {unused ? (
                        // Counted, not hidden: an opened-and-abandoned session is
                        // a different thing from a conversation, and from nothing.
                        'opened, never used'
                      ) : heavy ? (
                        <span className="warn">abstention-heavy</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={13} className="muted">
                    No Foxy sessions on this page. This is the server answering, not a failed
                    request.
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
