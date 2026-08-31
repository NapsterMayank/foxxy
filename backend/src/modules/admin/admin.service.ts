import type { AuditPort } from '@/platform/audit/index';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import {
  ALERT_CHANNEL_POLICY,
  ALERT_KIND_PAGE,
  ALERT_KIND_TICKET,
  ALERT_RULES,
  SIGNAL_RANGES,
  collectSignals,
  evaluate,
  type CollectedSignals,
} from '@/platform/alerts/index';
import type {
  AdminDryRunResponse,
  AdminHealthResponse,
  AdminJobsResponse,
  AdminMetricsResponse,
  AdminOverviewResponse,
  AdminRulesResponse,
  AdminSignalsResponse,
  AdminWorkersResponse,
} from '@/shared/contracts/admin.contract';
import type { AdminOverviewCounts, AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';

/**
 * =============================================================================
 * admin — the operations read model.
 *
 * EVERY METHOD AUDITS. Not a decorator and not a route-level hook: the audit
 * call sits in the method, beside the read it describes, because a wrapper is
 * something a future endpoint can be added outside of. `AuditPort.record()`
 * never throws by contract, so auditing can never be the reason a monitoring
 * screen fails to load — which matters most at exactly the moment it is being
 * looked at.
 *
 * WHAT THE AUDIT ROW CARRIES: the action, the resource type, and counts.
 * `audit_log.metadata` is "identifiers and counts ONLY", so nothing here writes
 * a name, an address or free text, and the monitoring reads have no subject to
 * name anyway.
 * =============================================================================
 */

/** The counting window for signals and metrics, in minutes. */
const WINDOW_MINUTES = 15;

/**
 * Matches the shipped `worker_heartbeat_stale` threshold, so a worker this
 * screen calls stale is a worker the pager would call stale. Two different
 * numbers for one word is how a dashboard and an alert come to disagree in
 * front of an operator at 3am.
 */
const WORKER_STALE_AFTER_MS = 300_000;

/** How many dead letters a single page returns. */
const DEAD_LETTER_LIMIT = 50;

/**
 * How long an overview count may be reused.
 *
 * =============================================================================
 * NINE EXACT `count(*)` OVER WHOLE TABLES, ON THE SCREEN REFRESHED DURING AN
 * INCIDENT, ON THE POOL THAT SERVES LEARNERS.
 *
 * The counts must stay EXACT — `pg_stat_user_tables` was tried in this
 * repository and reported 0 rows for tables holding thousands, and an overview
 * that under-reports is worse than one that is slightly stale. So the fix is
 * not a cheaper count; it is counting less often.
 *
 * Thirty seconds is chosen against how the screen is USED rather than against a
 * freshness requirement: an operator refreshing during an incident refreshes
 * every few seconds, and none of these nine numbers can move meaningfully in
 * that window. `generatedAt` on the response is the count's OWN timestamp, so a
 * reader can always see how old it is.
 *
 * The alert signals and the job queue are NOT cached — those are the numbers
 * that move on the timescale an incident does.
 * =============================================================================
 */
const OVERVIEW_CACHE_SECONDS = 30;
const OVERVIEW_CACHE_KEY = 'admin:overview:counts:v1';

export interface AdminServiceDeps {
  readonly repository: AdminRepository;
  /** Shared with the rest of the platform. See `OVERVIEW_CACHE_SECONDS`. */
  readonly cache: CachePort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditPort;
  /**
   * The database handle the signal collector reads through.
   *
   * Handed in rather than reached for: `collectSignals` is platform code that
   * takes its own dependencies, and giving it the same handle the repository
   * uses keeps "what the panel shows" and "what the pager would see" measured
   * through one pool.
   */
  readonly signalDb: Parameters<typeof collectSignals>[0]['db'];
  /** `/health/ready` of this API. The collector probes it, as the CLI does. */
  readonly readinessUrl: string;
  /** Where backups are published. Absent means the backup signal is unmeasured. */
  readonly backupDir?: string | undefined;
}

export interface AdminService {
  overview(actor: AdminActor): Promise<AdminOverviewResponse>;
  signals(actor: AdminActor): Promise<AdminSignalsResponse>;
  rules(actor: AdminActor): Promise<AdminRulesResponse>;
  dryRun(actor: AdminActor): Promise<AdminDryRunResponse>;
  jobs(actor: AdminActor): Promise<AdminJobsResponse>;
  workers(actor: AdminActor): Promise<AdminWorkersResponse>;
  metrics(actor: AdminActor): Promise<AdminMetricsResponse>;
  health(actor: AdminActor): Promise<AdminHealthResponse>;
}

export function createAdminService(deps: AdminServiceDeps): AdminService {
  const { repository, clock, audit } = deps;

  const record = async (
    actor: AdminActor,
    resourceType: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    await audit.record({
      actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
      action: 'admin.read',
      resourceType,
      metadata,
    });
  };

  /**
   * The nine counts, at most once every `OVERVIEW_CACHE_SECONDS`.
   *
   * A cache MISS is the normal path on the first load and after any gap; the
   * hit path is the operator hitting refresh. On a cache failure this falls
   * through to the database rather than failing the screen — a monitoring
   * surface that goes dark because a cache is down has failed at the one moment
   * it exists for.
   */
  const countsCached = async (): Promise<AdminOverviewCounts> => {
    try {
      const cached = await deps.cache.get(OVERVIEW_CACHE_KEY);
      // JSON, because `CachePort` stores strings — it is a cache, not a
      // document store, and giving it a typed value would mean a serialiser
      // per caller. Parsed inside the try: a malformed entry (a truncated
      // write, a format change) must fall through to the database rather than
      // take the screen down.
      if (cached !== null) return JSON.parse(cached) as AdminOverviewCounts;
    } catch {
      /* fall through to the database */
    }
    const fresh = await repository.overviewCounts();
    try {
      await deps.cache.set(OVERVIEW_CACHE_KEY, JSON.stringify(fresh), OVERVIEW_CACHE_SECONDS);
    } catch {
      /* a count that could not be cached is still a correct count */
    }
    return fresh;
  };

  const collect = async (): Promise<CollectedSignals> =>
    await collectSignals({
      db: deps.signalDb,
      logger: deps.logger,
      windowMinutes: WINDOW_MINUTES,
      readinessUrl: deps.readinessUrl,
      backupDir: deps.backupDir,
      now: clock.now(),
    });

  /**
   * The declared range for a signal, or null when it has none.
   *
   * `SIGNAL_RANGES` is a `Record<SignalName, SignalRange>`, so an index into it
   * is TYPED as always present — which is a lie the moment the key is a string
   * that came out of the collector rather than out of the constant. The lookup
   * is widened deliberately so the null case exists at all: an unranged signal
   * is exactly the orphan this screen is meant to reveal.
   */
  const rangeOf = (name: string): { min: number; max: number; unit: string } | null =>
    (SIGNAL_RANGES as Record<string, { min: number; max: number; unit: string } | undefined>)[
      name
    ] ?? null;

  /** Which rules watch a given signal. Empty means the signal is an orphan. */
  const watchersOf = (signal: string): string[] =>
    ALERT_RULES.filter((rule) => rule.signal === signal).map((rule) => rule.id);

  return {
    async overview(actor: AdminActor): Promise<AdminOverviewResponse> {
      const [counts, collected, jobCounts, workerRows] = await Promise.all([
        countsCached(),
        collect(),
        repository.jobCounts(),
        repository.databaseNow().then(async (now) => await repository.workers(now, WORKER_STALE_AFTER_MS)),
      ]);

      const firing = evaluate(ALERT_RULES, collected.signals, clock.now());
      const jobsPending = jobCounts
        .filter((row) => row.status === 'pending' || row.status === 'failed')
        .reduce((sum, row) => sum + row.count, 0);

      await record(actor, 'overview', {
        firing: firing.length,
        blindSpots: collected.failures.length,
      });

      return {
        counts,
        firingNow: firing.length,
        // A BLIND SPOT IS A HEADLINE NUMBER, not a detail. Every rule watching
        // an unmeasured signal is disabled, and a disabled rule and a quiet one
        // look identical from anywhere else in the product.
        blindSpots: collected.failures.length,
        workersRunning: workerRows.filter((worker) => !worker.stale).length,
        jobsPending,
        generatedAt: clock.now().toISOString(),
      };
    },

    async signals(actor: AdminActor): Promise<AdminSignalsResponse> {
      const collected = await collect();
      const failureBySignal = new Map(
        collected.failures.map((failure) => [failure.signal, failure.reason]),
      );

      /**
       * THE UNION OF WHAT WAS MEASURED AND WHAT ANY RULE WATCHES.
       *
       * Listing only the measured signals would hide the interesting case: a
       * signal a rule depends on that produced no value at all. Listing only
       * the watched ones would hide a signal that is collected and watched by
       * nothing — an orphan, which is the same defect from the other side.
       */
      const names = new Set<string>([
        ...Object.keys(collected.signals),
        ...ALERT_RULES.map((rule) => rule.signal),
        ...collected.failures.map((failure) => failure.signal),
      ]);

      await record(actor, 'monitoring.signals', {
        measured: Object.keys(collected.signals).length,
        blindSpots: collected.failures.length,
      });

      return {
        signals: [...names].sort().map((name) => ({
          name,
          value: collected.signals[name] ?? null,
          failureReason: failureBySignal.get(name) ?? null,
          watchedBy: watchersOf(name),
          range: rangeOf(name),
        })),
        windowMinutes: WINDOW_MINUTES,
        collectedAt: clock.now().toISOString(),
      };
    },

    async rules(actor: AdminActor): Promise<AdminRulesResponse> {
      await record(actor, 'monitoring.rules', { rules: ALERT_RULES.length });

      return {
        rules: ALERT_RULES.map((rule) => ({
          id: rule.id,
          signal: rule.signal,
          comparison: rule.comparison,
          threshold: rule.threshold,
          severity: rule.severity,
          cooldownSeconds: rule.cooldownSeconds,
          title: rule.title,
          body: rule.body,
          runbook: rule.runbook,
          channels: [
            ...(ALERT_CHANNEL_POLICY[
              rule.severity === 'page' ? ALERT_KIND_PAGE : ALERT_KIND_TICKET
            ] ?? []),
          ],
        })),
        cooldownsAreProcessLocal: true,
      };
    },

    /**
     * =========================================================================
     * THE DRY RUN. IT CANNOT DELIVER, AND THE REASON IS STRUCTURAL.
     *
     * No dispatcher is constructed here. Not built and then not called — which
     * is a delivery one careless refactor away from happening — but absent. The
     * only things this touches are `collectSignals`, which reads, and
     * `evaluate`, which is a pure function of numbers. There is no code path
     * from this method to a channel because there is no channel in scope.
     *
     * `createAlertEvaluator` is what pages a human, and it is not imported by
     * this module at all.
     * =========================================================================
     */
    async dryRun(actor: AdminActor): Promise<AdminDryRunResponse> {
      const ranAt = clock.now();
      const collected = await collect();
      const fired = evaluate(ALERT_RULES, collected.signals, ranAt);

      await audit.record({
        actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
        action: 'admin.alert_dry_run',
        resourceType: 'monitoring',
        metadata: {
          wouldFire: fired.length,
          blindSpots: collected.failures.length,
          evaluatedRules: ALERT_RULES.length,
        },
      });

      return {
        wouldFire: fired.map((alert) => ({
          ruleId: alert.ruleId,
          severity: alert.severity,
          signal: alert.signal,
          value: alert.value,
          threshold: alert.threshold,
          title: alert.title,
          body: alert.body,
          runbook: alert.runbook,
        })),
        blindSpots: [...collected.failures],
        evaluatedRules: ALERT_RULES.length,
        windowMinutes: WINDOW_MINUTES,
        ranAt: ranAt.toISOString(),
        delivered: false,
      };
    },

    async jobs(actor: AdminActor): Promise<AdminJobsResponse> {
      const [byStatus, deadLetters, oldestPendingSeconds] = await Promise.all([
        repository.jobCounts(),
        repository.deadLetters(DEAD_LETTER_LIMIT),
        repository.oldestPendingSeconds(),
      ]);

      await record(actor, 'monitoring.jobs', {
        kinds: byStatus.length,
        deadLetters: deadLetters.length,
      });

      return {
        byStatus: byStatus.map((row) => ({ ...row })),
        deadLetters: deadLetters.map((row) => ({
          id: row.id,
          kind: row.kind,
          attempts: row.attempts,
          // The MESSAGE only, which is all the column holds — never a stack
          // trace and never a payload dump, per `jobs.last_error`.
          lastError: row.lastError,
          updatedAt: row.updatedAt.toISOString(),
        })),
        oldestPendingSeconds,
      };
    },

    async workers(actor: AdminActor): Promise<AdminWorkersResponse> {
      const now = await repository.databaseNow();
      const rows = await repository.workers(now, WORKER_STALE_AFTER_MS);

      await record(actor, 'monitoring.workers', { workers: rows.length });

      return {
        workers: rows.map((worker) => ({
          workerId: worker.workerId,
          status: worker.status,
          startedAt: worker.lastBeatAt.toISOString(),
          lastBeatAt: worker.lastBeatAt.toISOString(),
          ageSeconds: (now.getTime() - worker.lastBeatAt.getTime()) / 1_000,
          jobsProcessed: worker.jobsProcessed,
          stale: worker.stale,
        })),
        // Zero live rows is the loudest case — see the contract's note.
        noneRunning: rows.every((worker) => worker.stale),
        staleAfterSeconds: WORKER_STALE_AFTER_MS / 1_000,
      };
    },

    async metrics(actor: AdminActor): Promise<AdminMetricsResponse> {
      const metrics = await repository.recentMetrics(WINDOW_MINUTES);
      await record(actor, 'monitoring.metrics', { series: metrics.length });

      return {
        metrics: metrics.map((metric) => ({
          name: metric.name,
          kind: metric.kind,
          total: metric.total,
          occurrences: metric.occurrences,
          lastRecordedAt: metric.lastRecordedAt.toISOString(),
        })),
        windowMinutes: WINDOW_MINUTES,
      };
    },

    /**
     * READINESS AS THE COLLECTOR SEES IT, not as a second implementation.
     *
     * `/health/ready` already exists and already says whether this instance
     * should receive traffic. Re-deriving that here would be a second answer to
     * one question, and the two would disagree the first time either changed.
     * So this reports the `readiness.failing` signal the alert collector
     * produces — the same number the pager would act on.
     */
    async health(actor: AdminActor): Promise<AdminHealthResponse> {
      const collected = await collect();
      const failing = collected.signals['readiness.failing'];
      const failure = collected.failures.find((entry) => entry.signal === 'readiness');

      await record(actor, 'monitoring.health', { ready: failing === 0 });

      return {
        ready: failing === 0,
        checks: [
          {
            name: 'readiness',
            ok: failing === 0,
            detail: failure?.reason ?? null,
            durationMs: null,
          },
        ],
      };
    },
  };
}
