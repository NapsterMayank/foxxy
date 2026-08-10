import { z } from 'zod';
import {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_CONCURRENCY_LIMITS,
  DEFAULT_TIMEOUT_POLICY,
  parseBreakerPolicy,
  parseConcurrencyLimits,
  parseTimeoutPolicy,
  type BreakerPolicy,
  type ConcurrencyLimits,
  type TimeoutPolicy,
} from './timeouts';

/** An absolute http(s) origin — no trailing slash, no path. */
const originSchema = (name: string): z.ZodType<string, z.ZodTypeDef, string> =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine(
      (value) => value.startsWith('http://') || value.startsWith('https://'),
      `${name} must be an absolute http:// or https:// URL`,
    )
    .refine((value) => {
      try {
        return new URL(value).pathname === '/';
      } catch {
        return false;
      }
    }, `${name} must be an origin with no path (e.g. https://app.foxxy.in)`)
    .transform((value) => value.replace(/\/+$/, ''));

/** Comma-separated origins -> a trimmed, non-empty list. */
const splitOrigins = (value: string): string[] =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/**
 * The shape of the environment. This is the single authoritative list of
 * every variable the application reads.
 *
 * Rules:
 *  - REQUIRED variables have no default. A missing one stops the process.
 *  - Everything is coerced and validated here, so the rest of the codebase
 *    receives real types (number, boolean, string[]) and never a string that
 *    happens to look like one.
 */
export const envSchema = z.object({
  // --- Runtime ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- Database (REQUIRED) ---
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // --- Database bulkheads (04-RESILIENCE-PLAN.md §3.1) ---
  // One pool per concern, each independently capped. NOT one shared pool.
  // The defaults are the table in §3.1; they are exposed as variables only so
  // an operator can retune under load without a deploy.
  DATABASE_POOL_AUTH_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_POOL_CORE_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_POOL_AI_MAX: z.coerce.number().int().min(1).max(100).default(8),
  DATABASE_POOL_WORKER_MAX: z.coerce.number().int().min(1).max(100).default(6),

  /**
   * pgvector's HNSW search breadth, applied to the `ai` pool only (D-041,
   * D-049).
   *
   * THIS IS NOT A TUNING KNOB WITH A HARMLESS DEFAULT. An HNSW index scan
   * returns NO MORE ROWS THAN `ef_search`, and pgvector's default is 40 — while
   * plan §8.4 step 3 asks retrieval for the top 50. Measured on pgvector 0.8.6:
   * `ef_search = 40, limit 50` returns 40 rows; `ef_search = 100` returns 50.
   *
   * Left unset, retrieval therefore receives 40 candidates where it asked for
   * 50, every time, with no error and no warning. The symptom is a fused result
   * set that looks thin, which reads as "the corpus does not cover this" rather
   * than as a misconfiguration — and the response to that misreading is to go
   * and re-ingest content that is already there.
   *
   * 100 gives headroom above the top-50 ask without being so wide that the
   * graph traversal stops being cheap. It is a variable rather than a constant
   * so it can be raised alongside the retrieval `LIMIT` in one place, and so
   * the value is greppable from a deployment rather than from the source.
   */
  DATABASE_HNSW_EF_SEARCH: z.coerce.number().int().min(1).max(1000).default(100),

  // --- Cache (REQUIRED) ---
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      'REDIS_URL must be a redis:// or rediss:// connection string',
    ),

  // --- HTTP (REQUIRED: both origin lists) ---
  //
  // ========================================================================
  // TWO LISTS, NOT ONE — open item 1.
  //
  // There used to be a single `CORS_ORIGINS`, serving both the CORS allow-list
  // and the CSRF origin check. That conflates two different grants:
  //
  //   READ  — "this origin's browser may call us and see the answer"
  //   WRITE — "this origin's browser may CHANGE something"
  //
  // With one list, adding a partner origin so their dashboard can GET a
  // read-only report ALSO hands them state-changing rights across the whole
  // API, silently, in the same commit that looked like a read integration. The
  // person adding the origin has no way to express the smaller grant, and
  // nothing in review distinguishes the two.
  //
  // THE RELATIONSHIP: write is a SUBSET of read, validated below. An origin
  // that may POST must be able to read the response to its POST, so a write
  // grant that is not also a read grant is not a stricter policy, it is a
  // broken one. Every deployment's sensible starting point is
  // `CORS_WRITE_ORIGINS` = the app's own origin, and `CORS_READ_ORIGINS` = that
  // plus anything read-only.
  //
  // BOTH ARE REQUIRED, with no default. Defaulting write to read would restore
  // the exact behaviour this splits apart — adding a read origin would again
  // silently grant writes — and it would do it invisibly, which is worse than
  // the single variable was. A deployment that has not thought about the
  // distinction fails at boot and thinks about it.
  CORS_READ_ORIGINS: z
    .string()
    .min(1, 'CORS_READ_ORIGINS is required (comma-separated list of allowed origins)')
    .transform(splitOrigins)
    .refine((origins) => origins.length > 0, 'CORS_READ_ORIGINS must list at least one origin'),
  CORS_WRITE_ORIGINS: z
    .string()
    .min(
      1,
      'CORS_WRITE_ORIGINS is required (comma-separated; the origins allowed to POST/PUT/PATCH/DELETE)',
    )
    .transform(splitOrigins)
    .refine((origins) => origins.length > 0, 'CORS_WRITE_ORIGINS must list at least one origin'),
  /**
   * The retired single list.
   *
   * Declared solely so that a deployment still carrying it fails LOUDLY at boot.
   * Silently ignoring an unknown variable is how a stale `CORS_ORIGINS` sits in
   * a production environment for a year while the operator believes it is doing
   * something — and in this particular case, believing it is doing something is
   * believing an origin is allowed when it is not.
   */
  CORS_ORIGINS: z.string().optional(),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),

  // --- Public URLs (REQUIRED) — resolves D-015 ---
  //
  // The identity module derived these from `corsOrigins[0]` and from
  // host + port. Both break the moment a reverse proxy fronts the service:
  // `HOST` is a bind address (`0.0.0.0` is not somewhere a browser can go),
  // and the first CORS origin is an allow-list entry that happens to be first.
  // A verification email that points at the wrong host is a silently broken
  // signup funnel, which is the most expensive thing in the product to break.
  APP_URL: originSchema('APP_URL'),
  API_URL: originSchema('API_URL'),

  // --- Sessions (REQUIRED: SESSION_COOKIE_NAME) ---
  SESSION_COOKIE_NAME: z.string().min(1, 'SESSION_COOKIE_NAME is required'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // --- Graceful shutdown (04-RESILIENCE-PLAN.md §12) ---
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),
  SHUTDOWN_WORKER_TIMEOUT_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),

  /**
   * THE TENANT THIS DEPLOYMENT SERVES — D-073.
   *
   * Signup has no authenticated actor to inherit a tenant from, so the value
   * has to come from somewhere; it comes from here, and never from a request
   * body. Defaulted to the single seeded tenant that migration 0004 creates,
   * because a single-tenant deployment should not need to know this exists.
   *
   * When multi-tenancy arrives this stops being a constant and becomes a
   * per-request resolution (subdomain -> tenant). It becomes that in ONE place,
   * which is the entire point of threading it through explicitly now rather
   * than leaning on the column default.
   */
  DEFAULT_TENANT_ID: z
    .string()
    .uuid('DEFAULT_TENANT_ID must be a UUID')
    .default('11111111-1111-4111-8111-111111111111'),
})
  /**
   * WRITE IS A SUBSET OF READ. See the note on `CORS_READ_ORIGINS`.
   *
   * A superRefine rather than a per-field refine because it is a rule ABOUT TWO
   * FIELDS, and expressing it on either one alone would attach the error message
   * to the wrong variable half the time.
   */
  .superRefine((env, ctx) => {
    if (env.CORS_ORIGINS !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message:
          'CORS_ORIGINS has been split into CORS_READ_ORIGINS and CORS_WRITE_ORIGINS. ' +
          'Remove it, and decide which origins may only READ and which may also WRITE ' +
          '(write must be a subset of read).',
      });
    }

    const readable = new Set(env.CORS_READ_ORIGINS);
    const notReadable = env.CORS_WRITE_ORIGINS.filter((origin) => !readable.has(origin));
    if (notReadable.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_WRITE_ORIGINS'],
        message:
          `every write origin must also be a read origin; not in CORS_READ_ORIGINS: ` +
          `[${notReadable.join(', ')}]. An origin allowed to POST must be able to read the ` +
          'response to its POST, so a write-without-read grant is not a stricter policy — ' +
          'it is a broken one.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** The structured, frozen configuration object the application consumes. */
export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly server: {
    readonly port: number;
    readonly host: string;
  };
  readonly log: {
    readonly level: Env['LOG_LEVEL'];
  };
  readonly db: {
    readonly url: string;
    readonly poolMax: number;
    readonly ssl: boolean;
    /** §3.1 — one independently capped pool per concern. */
    readonly pools: {
      readonly auth: number;
      readonly core: number;
      readonly ai: number;
      readonly worker: number;
    };
    /**
     * HNSW search breadth for the `ai` pool. Must be at least the largest
     * `LIMIT` any retrieval query uses, or the index silently returns fewer
     * rows than were asked for (D-041).
     */
    readonly hnswEfSearch: number;
  };
  readonly cache: {
    readonly url: string;
  };
  readonly http: {
    /**
     * Origins the CORS plugin allows. The wider of the two lists.
     *
     * A browser at one of these may call the API and read the answer. It may
     * NOT change anything unless it is also in `corsWriteOrigins` — the origin
     * check refuses a state-changing method from an origin that is only here.
     */
    readonly corsReadOrigins: readonly string[];
    /**
     * Origins the CSRF origin check allows to POST/PUT/PATCH/DELETE.
     *
     * A SUBSET of `corsReadOrigins`, validated at boot. Adding a read-only
     * partner integration must not silently confer state-changing rights, which
     * is what one shared list did.
     */
    readonly corsWriteOrigins: readonly string[];
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };
  /**
   * Where the browser application and this API actually live. Explicit, not
   * derived — see D-015 and D-021.
   */
  readonly urls: {
    readonly app: string;
    readonly api: string;
  };
  readonly session: {
    readonly cookieName: string;
    readonly ttlDays: number;
  };
  /** §4 — the single authoritative timeout table. */
  readonly timeouts: TimeoutPolicy;
  /** §3.3 — max in-flight calls per external port. */
  readonly concurrency: ConcurrencyLimits;
  /** §5 — circuit-breaker thresholds. */
  readonly breaker: BreakerPolicy;
  /** §12 — how long a drain may take before the process stops waiting. */
  readonly shutdown: {
    readonly drainTimeoutMs: number;
    readonly workerTimeoutMs: number;
  };
  /** The tenant every signup on this deployment belongs to (D-073). */
  readonly tenancy: {
    readonly defaultTenantId: string;
  };
}

/** Maps validated environment values into the nested, frozen shape. */
export function toConfig(env: Env): Config {
  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    server: Object.freeze({ port: env.PORT, host: env.HOST }),
    log: Object.freeze({ level: env.LOG_LEVEL }),
    db: Object.freeze({
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      ssl: env.DATABASE_SSL,
      pools: Object.freeze({
        auth: env.DATABASE_POOL_AUTH_MAX,
        core: env.DATABASE_POOL_CORE_MAX,
        ai: env.DATABASE_POOL_AI_MAX,
        worker: env.DATABASE_POOL_WORKER_MAX,
      }),
      hnswEfSearch: env.DATABASE_HNSW_EF_SEARCH,
    }),
    cache: Object.freeze({ url: env.REDIS_URL }),
    http: Object.freeze({
      corsReadOrigins: Object.freeze([...env.CORS_READ_ORIGINS]),
      corsWriteOrigins: Object.freeze([...env.CORS_WRITE_ORIGINS]),
      timeoutMs: env.HTTP_TIMEOUT_MS,
      maxRetries: env.HTTP_MAX_RETRIES,
    }),
    urls: Object.freeze({ app: env.APP_URL, api: env.API_URL }),
    session: Object.freeze({
      cookieName: env.SESSION_COOKIE_NAME,
      ttlDays: env.SESSION_TTL_DAYS,
    }),
    // Parsed rather than spread: the policy is a hand-edited constant, and the
    // only moment it can be wrong is the moment somebody edits it. Validating
    // here makes that edit fail at boot instead of at the call site.
    timeouts: Object.freeze(parseTimeoutPolicy(DEFAULT_TIMEOUT_POLICY)),
    concurrency: Object.freeze(parseConcurrencyLimits(DEFAULT_CONCURRENCY_LIMITS)),
    breaker: Object.freeze(parseBreakerPolicy(DEFAULT_BREAKER_POLICY)),
    shutdown: Object.freeze({
      drainTimeoutMs: env.SHUTDOWN_DRAIN_TIMEOUT_MS,
      workerTimeoutMs: env.SHUTDOWN_WORKER_TIMEOUT_MS,
    }),
    tenancy: Object.freeze({ defaultTenantId: env.DEFAULT_TENANT_ID }),
  });
}
