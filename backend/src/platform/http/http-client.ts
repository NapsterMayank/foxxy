import { DependencyError } from '../errors/index';
import type { PortGuard } from '../resilience/index';
import {
  DEFAULT_BACKOFF_POLICY,
  backoffMs,
  jitteredBackoffMs,
  type BackoffPolicy,
} from '../retry/index';

/**
 * platform/http — the outbound HTTP client.
 *
 * Every call to an external system goes through here so that timeout, retry
 * and error translation are decided once. A vendor SDK that does its own
 * networking is wrapped by its own adapter, which owns the same concerns.
 *
 * Three resilience properties, all from 04-RESILIENCE-PLAN.md:
 *
 *  §4  Every attempt has a timeout, and the backoff between attempts is
 *      JITTERED. Un-jittered retries synchronise across callers and hit a
 *      recovering dependency as one wave.
 *  §4  A non-idempotent request is NEVER retried. Derived from the method
 *      rather than trusted to each caller — see `isIdempotentMethod`.
 *  §5  An optional `PortGuard` adds the circuit breaker and the concurrency
 *      limit. It is optional only so that the client stays constructible in a
 *      unit test with no clock and no logger; the composition root always
 *      supplies one.
 */
export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Overrides the configured default. */
  readonly timeoutMs?: number;
  /** Overrides the configured default. Only ever retry idempotent calls. */
  readonly maxRetries?: number;
  /**
   * Overrides the method-derived idempotency judgement.
   *
   * Set it `true` on a POST that carries an idempotency key. Set it `false` on
   * a GET that a particular API treats as a side effect. When `false`, the
   * retry budget is forced to zero no matter what was configured — the rule is
   * enforced, not advertised.
   */
  readonly idempotent?: boolean;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface HttpClientConfig {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** Injected so tests need no network and no mocking library. */
  readonly fetchImpl?: typeof fetch;
  /** Injected so backoff can be made instant in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can assert the exact jittered delay sequence. */
  readonly random?: () => number;
  readonly backoff?: BackoffPolicy;
  /** Circuit breaker + concurrency limit. Supplied by the composition root. */
  readonly guard?: PortGuard;
}

/** 5xx and 429 are worth another attempt; 4xx is our fault and will not change. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Whether repeating this request is safe.
 *
 * `GET`, `PUT` and `DELETE` are idempotent by HTTP's own definition. `POST`
 * and `PATCH` are not, and §4 is unambiguous: "Never retry a non-idempotent
 * write." Retrying a payment charge is materially worse than failing it.
 */
export function isIdempotentMethod(method: HttpRequest['method']): boolean {
  return method === 'GET' || method === 'PUT' || method === 'DELETE';
}

/**
 * The un-jittered exponential curve: 100ms, 200ms, 400ms, capped at 2s.
 * Re-exported from `platform/retry`, which owns backoff for every port.
 */
export { backoffMs };

/**
 * A 5xx is the dependency failing and counts toward opening the breaker.
 * A 4xx — 429 included — is not the dependency's fault (§5).
 */
function isBreakerFailureResponse(response: HttpResponse): boolean {
  return response.status >= 500;
}

export function createHttpClient(cfg: HttpClientConfig): HttpClient {
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep =
    cfg.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const backoffPolicy = cfg.backoff ?? DEFAULT_BACKOFF_POLICY;

  async function attemptOnce(
    req: HttpRequest,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await doFetch(req.url, {
        method: req.method,
        headers: {
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...req.headers,
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: controller.signal,
      });
      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: response.status, headers, body };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  /** One attempt, through the breaker and the limiter when one is wired. */
  function guardedAttempt(req: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    if (cfg.guard === undefined) {
      return attemptOnce(req, timeoutMs);
    }
    return cfg.guard.run<HttpResponse>((signal) => attemptOnce(req, timeoutMs, signal), {
      timeoutMs,
      isFailureResult: isBreakerFailureResponse,
    });
  }

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
      const idempotent = req.idempotent ?? isIdempotentMethod(req.method);
      // The enforcement, not a comment: a non-idempotent request gets exactly
      // one attempt regardless of the configured budget.
      const maxRetries = idempotent ? (req.maxRetries ?? cfg.maxRetries) : 0;
      let lastCause: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const response = await guardedAttempt(req, timeoutMs);
          if (!isRetryableStatus(response.status) || attempt === maxRetries) {
            return response;
          }
          lastCause = new Error(`HTTP ${String(response.status)}`);
        } catch (cause) {
          lastCause = cause;
          if (attempt === maxRetries) break;
        }
        await sleep(jitteredBackoffMs(attempt, backoffPolicy, cfg.random));
      }

      throw new DependencyError('http', {
        message: `Outbound request failed after ${String(maxRetries + 1)} attempt(s): ${req.method} ${req.url}`,
        cause: lastCause,
      });
    },
  };
}
