'use client';

import { Failure, useAdminData } from '@/components/screen';
import {
  adminOverviewResponseSchema,
  type AdminOverviewResponse,
} from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';

/*
 * =============================================================================
 * THE FIRST SCREEN, AND THE ONLY ONE SOMEBODY OPENS WITHOUT A QUESTION.
 *
 * Every other screen in this app is reached because an operator already
 * suspects something. This one is reached out of habit, which makes it the only
 * place a problem nobody is looking for can be found — so the four numbers that
 * describe the system's ability to tell you it is broken sit here as headlines,
 * at the same weight as each other, rather than as a footnote under the census.
 * =============================================================================
 */

/*
 * The schema is an effect dependency inside `useAdminData`. Referenced through
 * a module-level binding it is the same object on every render; built inline it
 * would be a new one each time and the effect would refetch forever.
 */
const OVERVIEW_SCHEMA = adminOverviewResponseSchema;

/** The census, in the order somebody reads it: people, their work, the catalogue behind it. */
const COUNTS: ReadonlyArray<readonly [keyof AdminOverviewResponse['counts'], string]> = [
  ['users', 'Users'],
  ['students', 'Students'],
  ['parents', 'Parents'],
  ['practiceSessions', 'Practice sessions'],
  ['chatSessions', 'Chat sessions'],
  ['questions', 'Questions'],
  ['chapters', 'Chapters'],
  // ACTIVE chunks. The content-coverage screen reports the total including
  // withdrawn ones, so the two screens differ by design — the label says which
  // is which rather than leaving a reader to discover the gap by subtraction.
  ['ragChunksActive', 'RAG chunks (active)'],
  ['activeSubscriptions', 'Active subscriptions'],
];

const count = (value: number): string => value.toLocaleString('en-US');

/**
 * Zero alerts is only good news when nothing is blind.
 *
 * A signal that failed to collect cannot breach its rule, so a blind spot
 * SUPPRESSES firing rather than causing it. Painting `firingNow: 0` green while
 * a signal is unmeasured would be the panel agreeing with the outage.
 */
function firingTone(firingNow: number, blindSpots: number): string {
  if (firingNow > 0) return 'bad';
  return blindSpots > 0 ? 'muted' : 'ok';
}

function Headlines({ data }: { data: AdminOverviewResponse }) {
  return (
    <>
      <div className="cards">
        <div className="card">
          <div className="label">Firing now</div>
          <div className={`value ${firingTone(data.firingNow, data.blindSpots)}`}>
            {count(data.firingNow)}
          </div>
        </div>
        <div className="card">
          <div className="label">Blind spots</div>
          <div className={`value ${data.blindSpots > 0 ? 'warn' : 'ok'}`}>
            {count(data.blindSpots)}
          </div>
        </div>
        <div className="card">
          <div className="label">Workers running</div>
          <div className={`value ${data.workersRunning === 0 ? 'bad' : 'ok'}`}>
            {count(data.workersRunning)}
          </div>
        </div>
        <div className="card">
          <div className="label">Jobs pending</div>
          <div className="value">{count(data.jobsPending)}</div>
        </div>
      </div>
      <p className="muted">
        A blind spot is a signal that could not be measured this cycle, which silently disables
        every alert rule watching it. From everywhere else in the system that is indistinguishable
        from a healthy quiet signal, so it is a headline here and not a detail.
      </p>
    </>
  );
}

export default function Overview() {
  const { data, error, loading, reload } = useAdminData(adminPaths.overview, OVERVIEW_SCHEMA);

  /*
   * `data` survives a failed reload inside the hook, so it is gated on `error`
   * here. Numbers from the last successful poll sitting under a red box read as
   * current, and during an incident that is the one thing they must not do.
   */
  const showData = error === null && data !== null;

  return (
    <>
      <h2>Overview</h2>
      <p className="sub">Everything the system knows about itself, in one request.</p>

      <p>
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {showData ? (
          <span className="muted"> Generated at {data.generatedAt}</span>
        ) : null}
      </p>

      {error !== null ? <Failure error={error} /> : null}
      {error === null && data === null ? <p className="muted">Loading overview…</p> : null}

      {showData ? (
        <>
          <div className="cards">
            {COUNTS.map(([key, label]) => (
              <div className="card" key={key}>
                <div className="label">{label}</div>
                <div className="value">{count(data.counts[key])}</div>
              </div>
            ))}
          </div>
          <h2>Alerting and capacity</h2>
          <p className="sub">The system&rsquo;s ability to tell you it is broken.</p>
          <Headlines data={data} />
        </>
      ) : null}
    </>
  );
}
