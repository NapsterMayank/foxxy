import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdGen } from '../../platform/id-gen/index';
import { stripQueryString, type Logger } from '../../platform/logger/index';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * THE CAP ON AN INBOUND REQUEST ID — D-266 (H6).
 *
 * ===========================================================================
 * An inbound `x-request-id` was accepted VERBATIM AND UNBOUNDED, then bound
 * into the child logger for the request and echoed back on the response. It is
 * the one piece of caller-controlled data that reaches every log line the
 * request produces, and it had no length limit and no character rules.
 *
 * Three consequences, none of which fails anything:
 *
 *  1. LOG VOLUME AS A LEVER. An 8 kB header (inside Fastify's default limit)
 *     multiplied by every line a request logs is an amplification factor a
 *     caller chooses. Nothing errors; the log bill and the retention window
 *     are what move.
 *  2. LOG INJECTION. Newlines in a request id break line-oriented log
 *     shipping, and a forged `"level":"error"` fragment in the value is read
 *     by whatever parses the stream downstream. This is why the rule is a
 *     CHARACTER ALLOWLIST and not only a length.
 *  3. RESPONSE ECHO. The value comes straight back in a response header, so an
 *     unfiltered one is a header-injection primitive for any intermediary that
 *     is less careful than Fastify.
 *
 * 200 is comfortably above every real generator — a UUID is 36, a W3C
 * `traceparent` is 55, and the longest convention in common use is around 128
 * — and far below anything worth amplifying.
 *
 * A REJECTED ID IS REPLACED, NEVER REFUSED. Returning 400 would let a broken
 * upstream proxy take the API down over a correlation identifier, which is a
 * far worse failure than losing the correlation. The request gets a fresh
 * generated id and proceeds, which is exactly what happens when no proxy
 * supplied one at all.
 * ===========================================================================
 */
export const MAX_REQUEST_ID_LENGTH = 200;

/**
 * Printable ASCII minus the shell/log-hostile ones: letters, digits, and the
 * separators every real tracing format uses. An allowlist rather than a
 * denylist — a denylist of "characters that break log shipping" is a list
 * somebody has to keep complete, and the cost of missing one is silent.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:@+-]+$/u;

/** Whether an inbound header may be used as this request's id. */
export function isAcceptableRequestId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(value);
}

declare module 'fastify' {
  interface FastifyRequest {
    /** One child logger per request, carrying the request id (§5, logger). */
    log2: Logger;
  }
}

export interface RequestIdOptions {
  readonly idGen: IdGen;
  readonly logger: Logger;
}

/**
 * Assigns every request an id — reusing an inbound `x-request-id` when a proxy
 * supplied one — echoes it on the response, and attaches a child logger bound
 * to it. Without this, correlating two log lines from the same request is
 * guesswork.
 */
export function registerRequestId(app: FastifyInstance, options: RequestIdOptions): void {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const inbound = request.headers[REQUEST_ID_HEADER];
    // D-266 — bounded and character-checked. See `MAX_REQUEST_ID_LENGTH`: this
    // value is bound into every log line the request emits and echoed back on
    // the response, and it is chosen by the caller.
    const requestId =
      typeof inbound === 'string' && isAcceptableRequestId(inbound)
        ? inbound
        : options.idGen.uuid();

    reply.header(REQUEST_ID_HEADER, requestId);
    // D-178: the PATH only. `request.url` carries the query string, and
    // `GET /api/v1/auth/verify?token=…` puts a live session credential in it —
    // which the logger's key-based redaction cannot see, because the secret is
    // inside a value and not under a key of its own. Stripped here, at the one
    // binding site, rather than filtered downstream: there is exactly one place
    // a URL enters the log and this is it.
    request.log2 = options.logger.child({
      requestId,
      method: request.method,
      url: stripQueryString(request.url),
    });
    done();
  });

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    request.log2.info(
      { statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) },
      'request completed',
    );
    done();
  });
}
