import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError, RateLimitError, toAppError } from '../../platform/errors/index';

/**
 * The single error handler.
 *
 * Everything thrown anywhere in the application is normalised to an AppError
 * and rendered as `{ error: { code, message } }`. Anything unrecognised
 * becomes a generic 500.
 *
 * NEVER leak an internal message or a stack trace to a client — that is the
 * entire reason AppError carries both `message` and `safeMessage`.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const appError = toAppError(error);

    const logPayload = {
      code: appError.code,
      httpStatus: appError.httpStatus,
      err: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    };

    if (appError.httpStatus >= 500) {
      request.log2.error(logPayload, 'request failed');
    } else {
      request.log2.warn(logPayload, 'request rejected');
    }

    if (appError instanceof RateLimitError && appError.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(appError.retryAfterSeconds));
    }

    void reply.status(appError.httpStatus).send(appError.toClientPayload());
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const error = new NotFoundError('Not found.', {
      message: `No route for ${request.method} ${request.url}`,
    });
    void reply.status(error.httpStatus).send(error.toClientPayload());
  });
}
