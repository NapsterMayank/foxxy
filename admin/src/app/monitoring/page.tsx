'use client';

import { useCallback, useState } from 'react';
import { Failure, useAdminData } from '@/components/screen';
import { ApiError, adminRequest } from '@/lib/api/client';
import {
  adminDryRunResponseSchema,
  adminRulesResponseSchema,
  adminSignalsResponseSchema,
  type AdminDryRunResponse,
  type AdminSignal,
} from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';

/*
 * =============================================================================
 * SIGNALS, RULES, AND WHAT WOULD HAPPEN IF THEY MET RIGHT NOW.
 *
 * The three sections are three different questions, so they are three separate
 * requests rather than one composed view: a rules list that still renders when
 * collection is down is more useful than a joined screen that fails whole.
 *
 * Two defects live in the seam between the halves and only this screen can see
 * either of them:
 *
 *   - an UNMEASURED signal, which disables every rule watching it and looks
 *     from everywhere else exactly like a healthy quiet one;
 *   - an ORPHAN signal, collected every cycle with no rule watching it, which
 *     is the same defect from the other side.
 *
 * Both are marked in the table rather than left for the reader to spot by
 * comparing two columns.
 * =============================================================================
 */

/*
 * Schemas are effect dependencies inside `useAdminData` — module-level so they
 * are the same object every render, rather than a fresh one that refetches
 * forever.
 */
const SIGNALS_SCHEMA = adminSignalsResponseSchema;
const RULES_SCHEMA = adminRulesResponseSchema;

/** Integers get thousands separators; thresholds like 0.05 must survive verbatim. */
function num(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
}

/**
 * The band the signal has to stay inside to keep every rule watching it quiet.
 *
 * `range` is nullable on the wire and null means the same thing as an empty
 * `watchedBy`: nothing constrains this number. `max: null` is different — the
 * band is open at the top, and writing that as a blank would read as missing.
 */
function describeRange(range: AdminSignal['range']): string {
  if (range === null) return 'unbounded';
  return `${num(range.min)}–${range.max === null ? '∞' : num(range.max)} ${range.unit}`;
}

/** `page` wakes somebody up; `ticket` does not. Worth seeing without reading. */
const severityTone = (severity: 'page' | 'ticket'): string =>
  severity === 'page' ? 'bad' : 'warn';

const comparisonSymbol = (comparison: 'gte' | 'lte'): string =>
  comparison === 'gte' ? '≥' : '≤';

// ---------------------------------------------------------------------------
// SIGNALS
// ---------------------------------------------------------------------------

function SignalRow({ signal }: { signal: AdminSignal }) {
  const unmeasured = signal.value === null;
  const orphan = signal.watchedBy.length === 0;

  return (
    <tr>
      <td>{signal.name}</td>
      <td className="num">
        {/*
          A null value must not render as 0 or as a blank. Zero is a measurement
          and this is the absence of one, and the two lead an operator to
          opposite conclusions about the same signal.
        */}
        {signal.value === null ? <span className="warn">unmeasured</span> : num(signal.value)}
      </td>
      <td className="muted">{describeRange(signal.range)}</td>
      <td>
        {orphan ? (
          <span className="muted">nothing</span>
        ) : (
          signal.watchedBy.join(', ')
        )}
      </td>
      <td>
        {/*
          Terse markers, because table cells do not wrap. What each one means is
          said once above the table rather than repeated on every row.
        */}
        {unmeasured ? (
          <div className="warn">unmeasured — {signal.failureReason ?? 'no reason reported'}</div>
        ) : null}
        {orphan ? <div className="muted">orphan — no rule watches this</div> : null}
        {!unmeasured && !orphan ? <span className="ok">watched</span> : null}
      </td>
    </tr>
  );
}

function Signals() {
  const { data, error, loading, reload } = useAdminData(adminPaths.signals, SIGNALS_SCHEMA);
  const showData = error === null && data !== null;

  return (
    <section>
      <h2>Signals</h2>
      <p className="sub">
        What the collector measured, and whether anything is watching it. An{' '}
        <span className="warn">unmeasured</span> signal has no value this cycle, which silently
        disables every rule watching it — that is not the same as a value of 0. An{' '}
        <span className="muted">orphan</span> is collected every cycle and watched by no rule, so
        nothing it reports can ever raise an alert.
      </p>

      <p>
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? 'Collecting…' : 'Recollect'}
        </button>
        {showData ? (
          <span className="muted">
            {' '}
            {num(data.windowMinutes)} minute window, collected at {data.collectedAt}
          </span>
        ) : null}
      </p>

      {error !== null ? <Failure error={error} /> : null}
      {error === null && data === null ? <p className="muted">Loading signals…</p> : null}

      {/*
        An empty list gets a sentence, never an empty table. A table with
        headers and no rows is the shape a failed request would take if the
        error were swallowed, and the two must not be able to look alike.
      */}
      {showData && data.signals.length === 0 ? (
        <p className="warn">
          The request succeeded and returned no signals at all. That is a collector defect, not a
          quiet system.
        </p>
      ) : null}
      {showData && data.signals.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Signal</th>
              <th className="num">Value</th>
              <th>Rule range</th>
              <th>Watched by</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {data.signals.map((signal) => (
              <SignalRow key={signal.name} signal={signal} />
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

function Rules() {
  const { data, error, loading, reload } = useAdminData(adminPaths.rules, RULES_SCHEMA);
  const showData = error === null && data !== null;

  return (
    <section>
      <h2>Rules</h2>
      <p className="sub">
        Both languages, because both are what would actually be delivered — a rule that reads well
        in English and badly in Hindi is half broken and looks fine.
      </p>

      <p>
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? 'Reloading…' : 'Reload'}
        </button>
      </p>

      {error !== null ? <Failure error={error} /> : null}
      {error === null && data === null ? <p className="muted">Loading rules…</p> : null}

      {showData ? (
        <>
          {/*
            The cooldown column is CONFIGURATION. `CooldownLedger` is an
            in-memory object owned by an evaluator process, so under `--once`
            from a cron it starts empty every run and a sustained breach pages
            on every tick whatever the number says. A panel that showed this as
            live state would be a guess dressed as a fact.
          */}
          <p className="warn">
            cooldownsAreProcessLocal = {String(data.cooldownsAreProcessLocal)}. Cooldowns below are
            CONFIGURED values, not live state. The ledger lives in the evaluator process: run with
            --once it starts empty each time, so a sustained breach pages on every tick regardless
            of the number shown.
          </p>
          {data.rules.length === 0 ? (
            <p className="bad">
              The request succeeded and returned no rules. Nothing is being alerted on.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Signal</th>
                  <th>Fires when</th>
                  <th>Severity</th>
                  <th className="num">Cooldown (configured)</th>
                  <th>Channels (delivery order)</th>
                  <th>Runbook</th>
                  <th>Title (EN)</th>
                  <th>Title (HI)</th>
                </tr>
              </thead>
              <tbody>
                {data.rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.id}</td>
                    <td>{rule.signal}</td>
                    <td className="num">
                      {comparisonSymbol(rule.comparison)} {num(rule.threshold)}
                    </td>
                    <td className={severityTone(rule.severity)}>{rule.severity}</td>
                    <td className="num">{num(rule.cooldownSeconds)}s</td>
                    <td>
                      {/* Joined with an arrow because the array IS the delivery order. */}
                      {rule.channels.length === 0 ? (
                        <span className="bad">none</span>
                      ) : (
                        rule.channels.join(' → ')
                      )}
                    </td>
                    <td className="muted">{rule.runbook}</td>
                    <td>{rule.title.en}</td>
                    <td>{rule.title.hi}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// DRY RUN
// ---------------------------------------------------------------------------

/**
 * The dry run is a POST because it EXECUTES — see the contract header. It runs
 * a real collection cycle against the live database, so it is behind a button
 * rather than fetched on mount: a screen somebody leaves open must not keep
 * paying that cost.
 */
function DryRun() {
  const [result, setResult] = useState<AdminDryRunResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(() => {
    setRunning(true);
    setError(null);
    /*
     * The previous result is dropped before the new one is asked for. A result
     * from three minutes ago sitting under a fresh failure reads as the answer
     * to the button just pressed.
     */
    setResult(null);

    adminRequest({ path: adminPaths.dryRun, schema: adminDryRunResponseSchema, method: 'POST' })
      .then((value) => { setResult(value); setRunning(false); })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause : new ApiError(0, 'UNKNOWN', String(cause)));
        setRunning(false);
      });
  }, []);

  return (
    <section>
      <h2>Dry run</h2>
      <p className="sub">
        Evaluate every rule against a freshly collected set of signals and report what would have
        happened. Nothing is delivered.
      </p>

      <p>
        <button type="button" onClick={run} disabled={running}>
          {running ? 'Collecting and evaluating…' : 'Run a real collection cycle against the live database'}
        </button>
      </p>

      {error !== null ? <Failure error={error} /> : null}
      {running ? <p className="muted">Loading — collecting signals and evaluating rules…</p> : null}

      {error === null && result !== null ? (
        <>
          <p className="ok">
            delivered = {String(result.delivered)} — nothing was sent. No page, no ticket, no
            message. This is what the evaluator WOULD have done.
          </p>
          <p className="muted">
            {num(result.evaluatedRules)} rules evaluated over a {num(result.windowMinutes)} minute
            window at {result.ranAt}.
          </p>

          <h2>Would fire</h2>
          {result.wouldFire.length === 0 ? (
            <p className="ok">
              No rule would fire on this cycle. Read that together with the blind spots below — an
              unmeasured signal cannot breach its rule, so silence here is only good news when that
              list is empty.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Signal</th>
                  <th className="num">Value</th>
                  <th className="num">Threshold</th>
                  <th>Severity</th>
                  <th>Runbook</th>
                </tr>
              </thead>
              <tbody>
                {result.wouldFire.map((fire) => (
                  <tr key={fire.ruleId}>
                    <td>{fire.ruleId}</td>
                    <td>{fire.signal}</td>
                    <td className="num bad">{num(fire.value)}</td>
                    <td className="num muted">{num(fire.threshold)}</td>
                    <td className={severityTone(fire.severity)}>{fire.severity}</td>
                    <td className="muted">{fire.runbook}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Blind spots</h2>
          {result.blindSpots.length === 0 ? (
            <p className="ok">Every signal was measured on this cycle.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Reason it could not be measured</th>
                </tr>
              </thead>
              <tbody>
                {result.blindSpots.map((spot) => (
                  <tr key={spot.signal}>
                    <td className="warn">{spot.signal}</td>
                    <td className="warn">{spot.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}

export default function Monitoring() {
  return (
    <>
      <h2>Signals and rules</h2>
      <p className="sub">
        What is measured, what is watched, and what would page right now.
      </p>
      <Signals />
      <Rules />
      <DryRun />
    </>
  );
}
