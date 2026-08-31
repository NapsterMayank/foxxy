'use client';

import Link from 'next/link';
import { use } from 'react';
import { adminChatSessionDetailResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';
import { Failure, Masked, useAdminData } from '@/components/screen';
import { Reveal } from '@/components/reveal';

/**
 * =============================================================================
 * ONE SESSION, AS A SHAPE.
 *
 * THE DETAIL ENDPOINT RETURNS NO MESSAGE TEXT. Not a masked version of it —
 * none. There is no `content` field on `AdminChatSessionDetailResponse` and
 * there must never be one, because a partial mask of prose is not a mask: the
 * opening characters of a child's message routinely carry the name, the
 * question and the distress.
 *
 * What is left per turn is who spoke, how long they spoke for, which of the six
 * buttons produced it, whether Foxy abstained, and how many citations survived.
 * That is enough to see the SHAPE of a conversation that went wrong — a run of
 * `confused`, an answer that abstained three times, a student who typed twelve
 * hundred characters and got nothing back — which is the whole point of the
 * screen. The prose itself is reachable exactly one way: the reveal control
 * below, which writes an audit row for the reading.
 * =============================================================================
 */

/**
 * ISO in, ISO out — only the milliseconds and the `T` are dropped. The trailing
 * `Z` stays so the value still matches a server log line.
 */
function stamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+/, '');
}

/** Whole seconds between two ISO instants. Negative is impossible but not clamped. */
function gapSeconds(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 1000);
}

/**
 * The colour of a turn's length bar.
 *
 * Role is encoded in the bar rather than only in a text column because the bar
 * is what gets scanned: alternating colours make a monologue, a stall or a
 * student typing three times in a row visible without reading a single cell.
 */
function barColour(role: string, abstained: boolean): string {
  if (abstained) return 'var(--warn)';
  return role === 'assistant' ? 'var(--accent)' : 'var(--muted)';
}

export default function FoxySessionScreen({ params }: { params: Promise<{ id: string }> }) {
  // Next 16 hands a client page its params as a promise; `use` unwraps it and
  // suspends until it resolves. Both dynamic routes in this app do it this way.
  const { id } = use(params);

  const { data, error, loading } = useAdminData(
    adminPaths.foxySession(id),
    adminChatSessionDetailResponseSchema,
  );

  if (error !== null) {
    return (
      <>
        <h2>Foxy session</h2>
        <p className="sub">{id}</p>
        <Failure error={error} />
      </>
    );
  }

  if (loading || data === null) {
    return (
      <>
        <h2>Foxy session</h2>
        <p className="sub">{id}</p>
        <p className="muted">Loading session…</p>
      </>
    );
  }

  const { session, turns } = data;
  // The bar is relative to the longest turn ON THIS PAGE, so it compares turns
  // within one conversation and says nothing about any other session.
  const longest = turns.reduce((max, turn) => Math.max(max, turn.length), 0);

  return (
    <>
      <h2>Foxy session</h2>
      <p className="sub">
        {id} · <Link href="/foxy">back to the list</Link>
      </p>

      <div className="cards">
        <div className="card">
          <div className="label">Mode</div>
          <div className="value">{session.mode}</div>
        </div>
        <div className="card">
          <div className="label">Subject</div>
          <div className="value">{session.subject}</div>
        </div>
        <div className="card">
          <div className="label">Language</div>
          <div className="value">{session.language}</div>
        </div>
        <div className="card">
          <div className="label">Messages</div>
          <div className="value">{session.messageCount}</div>
        </div>
        <div className="card">
          <div className="label">Abstentions</div>
          <div className={session.abstentions > 0 ? 'value warn' : 'value'}>
            {session.abstentions}
          </div>
        </div>
        <div className="card">
          <div className="label">Turns returned</div>
          <div className="value">{turns.length}</div>
        </div>
      </div>

      <table>
        <tbody>
          <tr>
            <th>Student</th>
            <td>{session.studentUserId}</td>
          </tr>
          <tr>
            <th>Visit</th>
            <td>{session.visitId ?? <span className="muted">none</span>}</td>
          </tr>
          <tr>
            <th>Chapter</th>
            <td>{session.chapterId ?? <span className="muted">none</span>}</td>
          </tr>
          <tr>
            <th>Started</th>
            <td>{stamp(session.startedAt)}</td>
          </tr>
          <tr>
            <th>Last message</th>
            <td>
              {session.lastMessageAt === null ? (
                <span className="muted">never</span>
              ) : (
                stamp(session.lastMessageAt)
              )}
            </td>
          </tr>
          <tr>
            <th>Transcript</th>
            <td>
              {/*
                The one road to the text. It picks a reason from the closed set,
                posts it, and the reading lands in `audit_log` — which is why
                there is no "show everything" control anywhere on this screen.
              */}
              <Reveal
                resourceType="chat_session"
                resourceId={id}
                field="transcript"
                masked={<Masked>transcript withheld</Masked>}
              />
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Turns</h2>
      <p className="sub">
        Who spoke, how much, and what produced it. No message text is on the wire for this
        endpoint, so none of it can appear here by accident.
      </p>

      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Role</th>
            <th>Source</th>
            <th className="num">Chars</th>
            <th>Length</th>
            <th className="num">Citations</th>
            <th>Abstained</th>
            <th className="num">Gap</th>
            <th>At</th>
            <th>Trace</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((turn, index) => {
            const previous = index === 0 ? undefined : turns[index - 1];
            const width = longest === 0 || turn.length === 0
              ? 0
              : Math.max(2, Math.round((turn.length / longest) * 100));
            return (
              <tr key={turn.messageId}>
                <td className="num">{index + 1}</td>
                <td>{turn.role}</td>
                <td>
                  {/*
                    `action === null` MEANS FREE TEXT, and that distinction is
                    the product: Foxy is six buttons plus a scoped text box, so a
                    turn that came from a button and a turn somebody typed are
                    different evidence about what the student was doing.
                  */}
                  {turn.action === null ? (
                    <span className="muted">free text</span>
                  ) : (
                    turn.action
                  )}
                </td>
                <td className="num">{turn.length}</td>
                <td>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 120,
                      height: 8,
                      background: 'var(--line)',
                      borderRadius: 2,
                      verticalAlign: 'middle',
                    }}
                    title={`${turn.role}, ${String(turn.length)} characters`}
                  >
                    <span
                      style={{
                        display: 'block',
                        width: `${String(width)}%`,
                        height: 8,
                        background: barColour(turn.role, turn.abstained),
                        borderRadius: 2,
                      }}
                    />
                  </span>
                </td>
                <td className="num">{turn.citationCount}</td>
                <td>
                  {turn.abstained ? (
                    <span className="warn">abstained</span>
                  ) : (
                    <span className="muted">no</span>
                  )}
                </td>
                <td className="num">
                  {/* Time since the turn before it — a stall is part of the shape. */}
                  {previous === undefined ? (
                    <span className="muted">—</span>
                  ) : (
                    `${String(gapSeconds(previous.createdAt, turn.createdAt))}s`
                  )}
                </td>
                <td>{stamp(turn.createdAt)}</td>
                <td>
                  {/*
                    The link the footnote used to apologise for. A turn with no
                    trace answers 404, which on this surface also means "or you
                    are not an operator" — the screen behind it says so.
                  */}
                  <Link href={`/foxy/traces/by-message/${turn.messageId}`}>trace</Link>
                </td>
              </tr>
            );
          })}
          {turns.length === 0 ? (
            <tr>
              <td colSpan={10} className="muted">
                No turns. This session was opened and never used — which is a real state, not
                a failed request.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <p className="muted">
        {/*
          THIS FOOTNOTE USED TO APOLOGISE FOR A MISSING LINK.

          The turn carried no message id, so the trace explaining an answer
          could not be reached from the turn that produced it — which is the
          single most likely reason to be on this screen. D-402 added the id and
          D-403 added the route behind it; a link needs both, and an id with no
          endpoint is a fact the UI can display and not act on.

          A turn with no trace is normal, not broken: a learner's own message
          produces none, and neither does an answer served without retrieval.
          The route answers 404 and the link says so rather than pretending.
        */}
        Trace opens the retrieval that produced a turn. A learner{String.fromCharCode(8217)}s own
        message has none, and neither does an answer served without retrieval.
      </p>
    </>
  );
}
