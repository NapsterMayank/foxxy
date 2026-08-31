'use client';

import { Failure, useAdminData } from '@/components/screen';
import { adminJobsResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';

/**
 * =============================================================================
 * THE QUEUE, READ THE WAY AN OPERATOR OPENS IT.
 *
 * Nobody opens this screen to admire a balanced view of the queue. They open it
 * because something did not happen — a mastery update did not land, a
 * notification did not arrive — and they want to know whether the worker ate it.
 * So the layout is ordered by trouble, not by alphabet or by volume:
 *
 *   1. The backlog age, because it is the only number that says whether the
 *      worker is KEEPING UP. Ten thousand pending jobs drained in four seconds
 *      is a healthy queue; one pending job stuck for an hour is not, and no
 *      count can tell those apart.
 *   2. Dead letters, in full. The `jobs` table keeps a dead row rather than
 *      deleting it because "a job that gave up silently is a job nobody
 *      investigates" — this screen is the thing that stops it being silent, so
 *      it is rendered prominently even when the answer is "none".
 *   3. The status breakdown, sorted so `dead` and `failed` come first.
 * =============================================================================
 */

/*
 * Both of these are module-level on purpose. `useAdminData` has `path` and
 * `schema` in its effect dependencies, so a value rebuilt on each render would
 * re-run the fetch on each render, forever.
 */
const PATH = adminPaths.jobs;
const SCHEMA = adminJobsResponseSchema;

/**
 * Backlog thresholds, in seconds.
 *
 * These are presentation thresholds, not the pager's — the pager owns its own
 * numbers in the rules contract. They exist so a glance at the card carries the
 * same verdict a human would reach after reading it.
 */
const BACKLOG_WARN_SECONDS = 30;
const BACKLOG_BAD_SECONDS = 300;

/**
 * Where each status sorts. Lower is more urgent.
 *
 * An UNRECOGNISED status sorts at 2 — ahead of every healthy status and behind
 * the two known-bad ones. A status this screen has never heard of is far more
 * likely to be a new failure mode than a new kind of success, and burying it at
 * the bottom of the table is how it stays unnoticed.
 */
const STATUS_PRIORITY: Readonly<Record<string, number>> = {
  dead: 0,
  failed: 1,
  processing: 3,
  pending: 4,
  done: 5,
};
const UNKNOWN_STATUS_PRIORITY = 2;

function statusRank(status: string): number {
  return STATUS_PRIORITY[status] ?? UNKNOWN_STATUS_PRIORITY;
}

/** Red for the two that mean work was lost, green for work that finished. */
function statusClass(status: string): string {
  if (status === 'dead' || status === 'failed') return 'bad';
  if (status === 'done') return 'ok';
  return '';
}

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${String(whole)}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(whole % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

function backlogClass(seconds: number | null): string {
  if (seconds === null) return 'muted';
  if (seconds > BACKLOG_BAD_SECONDS) return 'bad';
  if (seconds > BACKLOG_WARN_SECONDS) return 'warn';
  return 'ok';
}

export default function JobsPage() {
  const { data, error, loading, reload } = useAdminData(PATH, SCHEMA);

  return (
    <>
      <h2>Jobs</h2>
      <p className="sub">
        The background queue: how much is waiting, how old the wait is, and what
        gave up entirely.
      </p>

      <p>
        <button type="button" onClick={reload} disabled={loading}>Reload</button>
      </p>

      {/*
        A failure NEVER falls through to the tables below. On this screen an
        empty dead-letter table is the best news there is, and a failed request
        that rendered as one would be the worst possible lie to tell an operator
        mid-incident.
      */}
      {error ? <Failure error={error} /> : null}
      {!error && loading ? <p className="muted">Loading the queue…</p> : null}

      {!error && !loading && data ? (
        <>
          <div className="cards">
            <div className="card">
              <div className="label">Oldest pending</div>
              {/*
                Null is "the queue is empty", which is a different fact from
                "the oldest job is zero seconds old" and must not be rendered
                as 0 — one means nothing is waiting, the other means something
                just arrived.
              */}
              <div className={`value ${backlogClass(data.oldestPendingSeconds)}`}>
                {data.oldestPendingSeconds === null
                  ? 'empty'
                  : formatSeconds(data.oldestPendingSeconds)}
              </div>
            </div>

            <div className="card">
              <div className="label">Dead letters</div>
              <div className={`value ${data.deadLetters.length > 0 ? 'bad' : 'ok'}`}>
                {data.deadLetters.length}
              </div>
            </div>

            <div className="card">
              <div className="label">Rows counted</div>
              <div className="value">
                {data.byStatus.reduce((total, row) => total + row.count, 0)}
              </div>
            </div>
          </div>

          <h2>Dead letters</h2>
          <p className="sub">
            Jobs that exhausted their retries. The row is kept rather than
            deleted so somebody can look at it; this table is that look.
          </p>
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Kind</th>
                <th className="num">Attempts</th>
                <th>Last error</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.deadLetters.length === 0 ? (
                <tr>
                  {/* Say "none" out loud. A table that renders nothing when
                      empty is indistinguishable from a table that failed. */}
                  <td colSpan={5} className="ok">none — no job has exhausted its retries</td>
                </tr>
              ) : (
                data.deadLetters.map((job) => (
                  <tr key={job.id}>
                    <td>{job.id}</td>
                    <td>{job.kind}</td>
                    <td className="num">{job.attempts}</td>
                    {/* A stack trace is long. Let it wrap here rather than push
                        the timestamp off the right edge of the screen. */}
                    <td style={{ whiteSpace: 'normal', maxWidth: 440 }}>
                      {job.lastError === null
                        ? <span className="muted">no error recorded</span>
                        : job.lastError}
                    </td>
                    <td>{job.updatedAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <h2>By status</h2>
          <p className="sub">
            Sorted by urgency, not by name: dead and failed first, then anything
            this screen does not recognise, then the healthy statuses.
          </p>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Kind</th>
                <th className="num">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.byStatus.length === 0 ? (
                <tr><td colSpan={3} className="muted">none — the queue holds no jobs</td></tr>
              ) : (
                [...data.byStatus]
                  .sort((left, right) => (
                    statusRank(left.status) - statusRank(right.status)
                    || left.status.localeCompare(right.status)
                    || right.count - left.count
                    || left.kind.localeCompare(right.kind)
                  ))
                  .map((row) => (
                    <tr key={`${row.status}:${row.kind}`} className={statusClass(row.status)}>
                      <td>{row.status}</td>
                      <td>{row.kind}</td>
                      <td className="num">{row.count}</td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}
