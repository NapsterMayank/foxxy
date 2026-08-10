import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdGen } from '../../platform/id-gen/index';
import type { Logger } from '../../platform/logger/index';

export const REQUEST_ID_HEADER = 'x-request-id';

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
    const requestId =
      typeof inbound === 'string' && inbound.length > 0 ? inbound : options.idGen.uuid();

    reply.header(REQUEST_ID_HEADER, requestId);
    request.log2 = options.logger.child({ requestId, method: request.method, url: request.url });
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
