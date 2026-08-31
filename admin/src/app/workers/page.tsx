'use client';

import { Failure, useAdminData } from '@/components/screen';
import { adminWorkersResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';

/**
 * =============================================================================
 * THE FLEET, WITH THE OUTAGE AT THE TOP.
 *
 * The contract calls `noneRunning` the loudest case rather than the quietest,
 * and this screen has to render it that way or the flag was pointless. A fleet
 * that never started, one that died overnight and one that was cleanly stopped
 * and never replaced are three different stories with one consequence: nothing
 * is draining the queue, and a learner is waiting for a mastery update that is
 * never coming. So zero workers gets a banner, not an empty table.
 *
 * The other thing this screen owes an operator is agreement with the pager. A
 * worker it calls stale is one the pager would also call stale — same 300s — so
 * that arguing with the page is never a matter of comparing two definitions.
 * =============================================================================
 */

/*
 * Module-level: `useAdminData` keys its effect on `path` and `schema`, so a
 * value rebuilt each render would refetch each render.
 */
const PATH = adminPaths.workers;
const SCHEMA = adminWorkersResponseSchema;

/**
 * The staleness threshold, stated here only so the screen can NAME it.
 *
 * `stale` itself is computed by the server and is never recomputed from
 * `ageSeconds` in this file — two implementations of one rule is how a screen
 * ends up disagreeing with the pager that fires off the same data.
 */
const STALE_SECONDS = 300;

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${String(whole)}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(whole % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

export default function WorkersPage() {
  const { data, error, loading, reload } = useAdminData(PATH, SCHEMA);
  const staleCount = data === null ? 0 : data.workers.filter((worker) => worker.stale).length;

  return (
    <>
      <h2>Workers</h2>
      <p className="sub">
        Who is draining the queue, and when each of them last said so.
      </p>
      <p className="muted">
        Staleness uses the same {STALE_SECONDS}s threshold the pager uses, so a
        worker this screen calls stale is one the pager would call stale.
      </p>

      <p>
        <button type="button" onClick={reload} disabled={loading}>Reload</button>
      </p>

      {/*
        Never fall through to the table on error. An empty fleet table and a
        failed request look identical, and only one of them is an outage worth
        waking somebody for.
      */}
      {error ? <Failure error={error} /> : null}
      {!error && loading ? <p className="muted">Loading the fleet…</p> : null}

      {!error && !loading && data ? (
        <>
          {/*
            The banner reuses `.error` deliberately. Zero workers IS the error
            condition on this screen, and giving it the same weight as a failed
            request is the honest rendering: in both cases nothing is being
            processed and somebody has to act.
          */}
          {data.noneRunning ? (
            <div className="error" style={{ marginBottom: 18 }}>
              <strong>NO WORKERS ARE RUNNING.</strong>
              <p style={{ margin: '6px 0 0' }}>
                Nothing is draining the job queue. A fleet that never started, one
                that died, and one that was stopped and never replaced are the same
                outage to a learner waiting on a mastery update. Check the process
                supervisor before reading anything else on this screen.
              </p>
            </div>
          ) : null}

          <div className="cards">
            <div className="card">
              <div className="label">Workers</div>
              <div className={`value ${data.noneRunning ? 'bad' : 'ok'}`}>
                {data.workers.length}
              </div>
            </div>
            <div className="card">
              <div className="label">Stale</div>
              <div className={`value ${staleCount > 0 ? 'bad' : 'ok'}`}>{staleCount}</div>
            </div>
            <div className="card">
              <div className="label">Jobs processed</div>
              <div className="value">
                {data.workers.reduce((total, worker) => total + worker.jobsProcessed, 0)}
              </div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th>Last beat</th>
                <th className="num">Age</th>
                <th className="num">Jobs processed</th>
                <th>Stale</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="bad">
                    none — no worker has registered a heartbeat
                  </td>
                </tr>
              ) : (
                data.workers.map((worker) => (
                  // A stale worker is red across the whole row: the interesting
                  // fact about it is not one cell, it is that the process is
                  // still listed and has stopped answering.
                  <tr key={worker.workerId} className={worker.stale ? 'bad' : ''}>
                    <td>{worker.workerId}</td>
                    <td>{worker.status}</td>
                    <td>{worker.lastBeatAt}</td>
                    <td className="num">{formatSeconds(worker.ageSeconds)}</td>
                    <td className="num">{worker.jobsProcessed}</td>
                    <td>{worker.stale ? 'stale' : <span className="ok">live</span>}</td>
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
