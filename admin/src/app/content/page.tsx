'use client';

import { Failure, useAdminData } from '@/components/screen';
import { adminContentCoverageResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';

/**
 * =============================================================================
 * CONTENT COVERAGE — a report, not a table. It exists to name what is INERT.
 *
 * Every number here is a pair: how much of something exists, and how much of it
 * the product can actually use. Shown side by side as two figures, the reader
 * has to subtract before the screen means anything, and a reader who does not
 * subtract sees a page full of large healthy numbers. So each pair is rendered
 * with its GAP spelled out in words, coloured by how bad the gap is.
 *
 * THE ONE TO LOOK AT FIRST IS `withMisconceptions` (D-077). It is zero on every
 * imported question. Misconception-based remediation is wired end to end —
 * schema, service, prompt, UI — and has nothing to say, so a wrong answer gets
 * the generic explanation forever. That is the exact failure this screen was
 * built for: a feature that looks finished and behaves empty, which no test
 * catches because nothing is broken.
 * =============================================================================
 */

/*
 * Grouped digits, pinned to en-US rather than the operator's locale, so two
 * people reading the same row read the same number. See the billing screen.
 */
const COUNT = new Intl.NumberFormat('en-US');

/**
 * Below this share of the whole, a gap stops being a backlog and starts being a
 * feature that does not work. Half is arbitrary but it has to be somewhere, and
 * the case this screen was built for is at zero.
 */
const INERT_BELOW = 0.5;

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

function toneOf(covered: number, of: number): Tone {
  // Nothing imported yet is not a coverage failure — it is an empty database,
  // and colouring it red would cry wolf on a fresh environment.
  if (of === 0) return 'muted';
  if (covered >= of) return 'ok';
  return covered < of * INERT_BELOW ? 'bad' : 'warn';
}

/** A plain count with a line saying what it means. */
function Stat({ label, value, note }: {
  readonly label: string;
  readonly value: number;
  readonly note: string;
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{COUNT.format(value)}</div>
      <div className="muted">{note}</div>
    </div>
  );
}

/**
 * A count against the whole it should cover, with the shortfall named.
 *
 * `missing` is the noun phrase for what the gap costs — "chapters that cannot
 * be practised", not "missing". The point of the card is that the reader never
 * has to work out the consequence themselves.
 */
function Coverage({ label, covered, of, missing }: {
  readonly label: string;
  readonly covered: number;
  readonly of: number;
  readonly missing: string;
}) {
  const tone = toneOf(covered, of);
  const short = Math.max(of - covered, 0);
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">
        <span className={tone}>{COUNT.format(covered)}</span>
        <span className="muted"> / {COUNT.format(of)}</span>
      </div>
      <div className={short === 0 ? 'ok' : tone}>
        {short === 0 ? 'complete' : `${COUNT.format(short)} ${missing}`}
      </div>
    </div>
  );
}

const SECTION: React.CSSProperties = { fontSize: 14, margin: '18px 0 8px', fontWeight: 600 };

export default function ContentPage() {
  const { data, error, loading } = useAdminData(
    adminPaths.contentCoverage,
    adminContentCoverageResponseSchema,
  );

  return (
    <>
      <h2>Content coverage</h2>
      <p className="sub">
        What exists against what the product can use. Each pair names its own gap,
        because two numbers side by side are only a gap to a reader who subtracts.
      </p>

      {loading ? <p className="muted">Counting the corpus…</p> : null}
      {error === null ? null : <Failure error={error} />}

      {/* Nothing renders on a failed load. A report of zeroes and a report that
          never arrived look identical, and only one of them is a content
          problem — see `useAdminData`. */}
      {!loading && error === null && data !== null ? (
        <>
          <h3 style={SECTION}>Questions</h3>
          <div className="cards">
            <Stat label="Total" value={data.questions.total} note="rows in the bank" />
            <Stat
              label="Active"
              value={data.questions.active}
              note="eligible to be served"
            />
            <Stat
              label="Held out"
              value={data.questions.heldOut}
              // Not spare inventory. Serving these in practice would train the
              // learner on the exam used to measure them, and the mastery number
              // would stop meaning anything.
              note="reserved for independent mastery checks — never served in practice"
            />
            <Coverage
              label="With misconceptions"
              covered={data.questions.withMisconceptions}
              of={data.questions.active}
              missing="without a misconception to remediate against"
            />
          </div>

          {data.questions.withMisconceptions < data.questions.active ? (
            <p className={toneOf(data.questions.withMisconceptions, data.questions.active)}>
              {COUNT.format(data.questions.withMisconceptions)} of{' '}
              {COUNT.format(data.questions.active)} servable questions carry
              distractor misconceptions (D-077). For the rest, misconception-based
              remediation is inert: the pipeline is wired end to end, and a wrong
              answer falls through to the generic explanation because there is no
              misconception on the distractor to explain. The feature looks built
              and behaves empty.
            </p>
          ) : null}

          {/*
            An honest caveat rather than a silent one: the server counts
            `withMisconceptions` over ALL questions and `active` over the
            servable subset, so the pair is an indicator, not a join. It cannot
            hide the case that matters — zero is zero either way.
          */}
          <p className="muted">
            Misconceptions are counted across every question, active or not, so
            read the pair as an indicator rather than a per-question join.
          </p>

          <h3 style={SECTION}>Chapters</h3>
          <div className="cards">
            <Stat label="Total" value={data.chapters.total} note="chapters imported" />
            <Coverage
              label="With questions"
              covered={data.chapters.withQuestions}
              of={data.chapters.total}
              missing="a student can open and not practise"
            />
            <Coverage
              label="With concepts"
              covered={data.chapters.withConcepts}
              of={data.chapters.total}
              missing="with nothing for concept-keyed work to attach to"
            />
            <Coverage
              label="With chunks"
              covered={data.chapters.withChunks}
              of={data.chapters.total}
              missing="with no indexed passages for retrieval to return"
            />
          </div>
          <p className="muted">
            A chapter counts as having questions if ANY question points at it,
            including held-out and inactive ones — so that figure is the
            optimistic bound. A chapter whose only questions are held out is
            counted here and still cannot be practised.
          </p>

          <h3 style={SECTION}>Chunks</h3>
          <div className="cards">
            <Stat label="Total" value={data.chunks.total} note="passages in the corpus" />
            <Coverage
              label="Embedded"
              covered={data.chunks.embedded}
              of={data.chunks.total}
              missing="in the corpus with no embedding — text retrieval cannot reach"
            />
          </div>

          <h3 style={SECTION}>By grade and subject</h3>
          {data.byGradeSubject.length === 0 ? (
            <p className="muted">No grade or subject has any content yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Grade</th>
                  <th>Subject</th>
                  <th className="num">Chapters</th>
                  <th className="num">Questions</th>
                </tr>
              </thead>
              <tbody>
                {data.byGradeSubject.map((row) => (
                  <tr key={`${row.grade}::${row.subjectCode}`}>
                    <td>{row.grade}</td>
                    <td>{row.subjectCode}</td>
                    <td className="num">{COUNT.format(row.chapters)}</td>
                    {/* Chapters with no questions at all is the same failure as
                        the chapters card, localised: a grade and subject a
                        student can browse and cannot practise. */}
                    <td className={row.questions === 0 ? 'num bad' : 'num'}>
                      {COUNT.format(row.questions)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </>
  );
}
