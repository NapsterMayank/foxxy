import type { Clock } from '../clock/index';
import { scrubTags } from '../pii/index';
import type {
  MetricEvent,
  MetricKind,
  MetricSnapshot,
  MetricTags,
  ReadableMetricsPort,
} from './metrics.port';

/**
 * The in-memory metrics adapter.
 *
 * TWO USES, and they are the same code for a good reason:
 *
 *  1. TESTS. "A breaker opening emits a metric" is only assertable against
 *     something you can read back, and reading back a Postgres table in a unit
 *     test would put a container behind every resilience assertion.
 *
 *  2. `/health/deps`. The snapshot the endpoint reports is the live process's
 *     own counters. Querying `metrics_events` for it would mean the endpoint
 *     that tells you the database is unreachable needs the database.
 *
 * In production this runs ALONGSIDE the Postgres sink (see `createTeeMetrics`):
 * memory answers "what is happening in this process right now", Postgres
 * answers "what happened last Tuesday".
 *
 * BOUNDED. Every distinct (name, tags) pair is a series, and the series map is
 * capped — a metric accidentally tagged with a user id would otherwise grow
 * without limit inside a long-lived process, which is a memory leak dressed up
 * as observability. The cap is the second line of defence; the first is that
 * `platform/pii` drops identifying tags before they get here.
 */

const MAX_SERIES = 2_000;

interface Series {
  readonly name: string;
  readonly kind: MetricKind;
  readonly tags: MetricTags;
  count: number;
  /** Counters accumulate; gauges are overwritten; histograms keep the last. */
  value: number;
  min: number;
  max: number;
  sum: number;
  lastAt: Date;
}

/**
 * The series key.
 *
 * Tags are sorted before joining so that `{a:'1',b:'2'}` and `{b:'2',a:'1'}`
 * are one series. Without the sort they are two, and a dashboard shows half the
 * traffic on each — a bug that looks like a traffic drop.
 */
export function seriesKey(name: string, kind: MetricKind, tags: MetricTags): string {
  const flattened = Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return `${kind}|${name}|${flattened}`;
}

export interface MemoryMetricsOptions {
  readonly clock: Clock;
  /** Called for every observation. How the Postgres sink is fed. */
  readonly onRecord?: (event: MetricEvent) => void;
}

export class MemoryMetrics implements ReadableMetricsPort {
  private readonly series = new Map<string, Series>();
  private readonly clock: Clock;
  private readonly onRecord: ((event: MetricEvent) => void) | undefined;
  /** Observations dropped because the series cap was reached. */
  private dropped = 0;

  constructor(options: MemoryMetricsOptions) {
    this.clock = options.clock;
    this.onRecord = options.onRecord;
  }

  counter(name: string, value = 1, tags: MetricTags = {}): void {
    this.record(name, 'counter', value, tags);
  }

  gauge(name: string, value: number, tags: MetricTags = {}): void {
    this.record(name, 'gauge', value, tags);
  }

  histogram(name: string, value: number, tags: MetricTags = {}): void {
    this.record(name, 'histogram', value, tags);
  }

  /** How many observations were discarded at the series cap. */
  droppedCount(): number {
    return this.dropped;
  }

  private record(name: string, kind: MetricKind, value: number, rawTags: MetricTags): void {
    // NaN and Infinity are not observations, they are bugs upstream. Storing
    // them poisons every aggregate that touches the series — one NaN makes a
    // sum NaN forever — so they are dropped here rather than propagated.
    if (!Number.isFinite(value)) {
      this.dropped += 1;
      return;
    }

    const { tags } = scrubTags(rawTags);
    const key = seriesKey(name, kind, tags);
    const at = this.clock.now();
    const existing = this.series.get(key);

    if (existing === undefined) {
      if (this.series.size >= MAX_SERIES) {
        this.dropped += 1;
        return;
      }
      this.series.set(key, {
        name,
        kind,
        tags,
        count: 1,
        value,
        min: value,
        max: value,
        sum: value,
        lastAt: at,
      });
    } else {
      existing.count += 1;
      existing.sum += value;
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
      // A counter's `value` is its RUNNING TOTAL; a gauge's and a histogram's
      // is its LATEST observation. Collapsing these into one rule would make
      // either "how many times has the breaker opened" or "how many calls are
      // in flight" report nonsense.
      existing.value = existing.kind === 'counter' ? existing.value + value : value;
      existing.lastAt = at;
    }

    this.onRecord?.({ name, kind, value, tags, at });
  }

  snapshot(): readonly MetricSnapshot[] {
    return [...this.series.values()]
      .map((series) => ({
        name: series.name,
        kind: series.kind,
        tags: series.tags,
        count: series.count,
        value: series.value,
        min: series.min,
        max: series.max,
        sum: series.sum,
        lastAt: series.lastAt.toISOString(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** The total for one counter, ignoring tags. What a test usually wants. */
  totalFor(name: string): number {
    let total = 0;
    for (const series of this.series.values()) {
      if (series.name === name) total += series.kind === 'counter' ? series.value : series.sum;
    }
    return total;
  }

  reset(): void {
    this.series.clear();
    this.dropped = 0;
  }
}
