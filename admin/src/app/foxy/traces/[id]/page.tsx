'use client';

import { use } from 'react';
import { adminTraceResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';
import { Failure, Masked, useAdminData } from '@/components/screen';
import { Reveal } from '@/components/reveal';

/**
 * =============================================================================
 * ONE RETRIEVAL TRACE — the debugging surface for a bad answer.
 *
 * The number this screen is built around is `fabricatedCitationCount`: chunk ids
 * the model cited that were never retrieved, and which the verifier stripped
 * before the answer reached the student. A non-zero value is not a display bug
 * and it is not a near miss — it is the model asserting a source that does not
 * exist, which is the exact failure grounding is supposed to prevent. It is
 * shown as a card, coloured, and called out in prose above the table, because an
 * operator scanning traces during an incident must not have to look for it.
 *
 * `query`, `prompt` and `answer` arrive as `{present, length}` and never as
 * text. PRESENT-AND-EMPTY IS NOT ABSENT: a prompt that was recorded as an empty
 * string means the assembler produced nothing, while a prompt that is absent
 * means nothing was recorded at all — a template failure and a logging failure,
 * and they are fixed in different places. The text itself is reachable only
 * through the audited reveal.
 * =============================================================================
 */

interface TextShape {
  readonly present: boolean;
  readonly length: number;
}

/**
 * ISO in, ISO out — only the milliseconds and the `T` are dropped. The trailing
 * `Z` stays so the value still matches a server log line.
 */
function stamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+/, '');
}

function presenceOf(shape: TextShape): { label: string; className: string } {
  if (!shape.present) return { label: 'absent — never recorded', className: 'bad' };
  if (shape.length === 0) return { label: 'present but empty', className: 'warn' };
  return { label: 'present', className: '' };
}

export default function FoxyTraceScreen({ params }: { params: Promise<{ id: string }> }) {
  // Next 16 hands a client page its params as a promise; `use` unwraps it. The
  // session detail route does the same, so both dynamic routes read alike.
  const { id } = use(params);

  const { data, error, loading } = useAdminData(adminPaths.foxyTrace(id), adminTraceResponseSchema);

  if (error !== null) {
    return (
      <>
        <h2>Retrieval trace</h2>
        <p className="sub">{id}</p>
        <Failure error={error} />
      </>
    );
  }

  if (loading || data === null) {
    return (
      <>
        <h2>Retrieval trace</h2>
        <p className="sub">{id}</p>
        <p className="muted">Loading trace…</p>
      </>
    );
  }

  const fabricated = data.fabricatedCitationCount;
  const texts: readonly { field: 'query' | 'prompt' | 'answer'; shape: TextShape }[] = [
    { field: 'query', shape: data.query },
    { field: 'prompt', shape: data.prompt },
    { field: 'answer', shape: data.answer },
  ];

  return (
    <>
      <h2>Retrieval trace</h2>
      {/*
        THE TRACE{String.fromCharCode(8217)}S OWN ID, NOT THE URL PARAMETER.

        On the by-message route the parameter is a MESSAGE id, so rendering it
        here labelled a trace showed one id under two names and neither of them
        the trace. The loaded row knows what it is; the URL only knows how it
        was found.
      */}
      <p className="sub">{data.id}</p>

      {fabricated > 0 ? (
        <p className="error">
          <strong>Grounding failure.</strong> {fabricated} cited{' '}
          {fabricated === 1 ? 'id was' : 'ids were'} never retrieved and{' '}
          {fabricated === 1 ? 'was' : 'were'} stripped before the answer was sent. The model
          invented a source. Treat the answer as ungrounded even though the student never saw
          the fabricated citation.
        </p>
      ) : null}

      <div className="cards">
        <div className="card">
          <div className="label">Fabricated citations</div>
          {/* Green at zero on purpose: this is the number an operator wants to
              confirm is zero, and confirming takes a colour, not a reading. */}
          <div className={fabricated > 0 ? 'value bad' : 'value ok'}>{fabricated}</div>
        </div>
        <div className="card">
          <div className="label">Retrieved</div>
          <div className={data.retrievedCount === 0 ? 'value warn' : 'value'}>
            {data.retrievedCount}
          </div>
        </div>
        <div className="card">
          <div className="label">Citations kept</div>
          <div className="value">{data.citationCount}</div>
        </div>
        <div className="card">
          <div className="label">Latency</div>
          <div className="value">{data.latencyMs}ms</div>
        </div>
        <div className="card">
          <div className="label">Input tokens</div>
          <div className="value">{data.inputTokens}</div>
        </div>
        <div className="card">
          <div className="label">Output tokens</div>
          <div className="value">{data.outputTokens}</div>
        </div>
      </div>

      <table>
        <tbody>
          <tr>
            <th>Message</th>
            <td>{data.messageId}</td>
          </tr>
          <tr>
            <th>Grade</th>
            <td>{data.grade}</td>
          </tr>
          <tr>
            <th>Subject</th>
            <td>{data.subject}</td>
          </tr>
          <tr>
            <th>Model</th>
            <td>{data.model}</td>
          </tr>
          <tr>
            <th>Abstained</th>
            <td>
              {data.abstained ? (
                <span className="warn">
                  yes
                  {/*
                    An abstention is a successful answer, not an error — Foxy
                    saying the textbook does not cover this. An abstention with
                    no reason recorded is the anomaly, because the reason is what
                    tells retrieval from safety from an empty corpus.
                  */}
                  {data.abstainReason === null ? (
                    <span className="bad"> — no reason recorded</span>
                  ) : (
                    ` — ${data.abstainReason}`
                  )}
                </span>
              ) : (
                'no'
              )}
            </td>
          </tr>
          <tr>
            <th>Retrieved / cited</th>
            <td>
              {data.retrievedCount} retrieved, {data.citationCount} cited
              {data.retrievedCount === 0 ? (
                <span className="warn"> — nothing was retrieved for this answer</span>
              ) : null}
            </td>
          </tr>
          <tr>
            <th>Created</th>
            <td>{stamp(data.createdAt)}</td>
          </tr>
        </tbody>
      </table>

      <h2>Text</h2>
      <p className="sub">
        Presence and length are on the wire; the text is not. Reveal is the only road to it
        and it writes an audit row for the reading.
      </p>

      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Presence</th>
            <th className="num">Chars</th>
            <th>Text</th>
          </tr>
        </thead>
        <tbody>
          {texts.map(({ field, shape }) => {
            const presence = presenceOf(shape);
            return (
              <tr key={field}>
                <td>{field}</td>
                <td className={presence.className}>{presence.label}</td>
                <td className="num">{shape.length}</td>
                <td>
                  {shape.present && shape.length > 0 ? (
                    <Reveal
                      resourceType="retrieval_trace"
                      resourceId={id}
                      field={field}
                      masked={<Masked>{field} withheld</Masked>}
                    />
                  ) : (
                    // No control where there is nothing behind it. Offering a
                    // reveal that can only ever return an empty string would
                    // spend an audit row to learn what this row already says.
                    <span className="muted">nothing to reveal</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
