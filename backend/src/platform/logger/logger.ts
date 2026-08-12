import { pino, type Logger as PinoLogger, type LoggerOptions, type DestinationStream } from 'pino';
import { REDACT_CENSOR, REDACT_PATHS } from './redaction';

/** The logging port. Modules depend on this, never on pino directly. */
export interface Logger {
  fatal(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  trace(obj: Record<string, unknown>, msg?: string): void;
  /** One child logger per request, carrying the request id. */
  child(bindings: Record<string, unknown>): Logger;
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LoggerConfig {
  readonly level: LogLevel;
  readonly env: string;
}

export function buildLoggerOptions(cfg: LoggerConfig): LoggerOptions {
  return {
    level: cfg.level,
    // JSON on every environment. Pretty-printing is a terminal concern; pipe
    // through `pino-pretty` locally rather than changing what is emitted.
    messageKey: 'msg',
    base: { env: cfg.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
      remove: false,
    },
    formatters: {
      level: (label: string): Record<string, string> => ({ level: label }),
    },
  };
}

/**
 * Creates the root logger. `destination` exists so tests can capture output
 * without patching stdout.
 */
export function createLogger(cfg: LoggerConfig, destination?: DestinationStream): Logger {
  const instance: PinoLogger = destination
    ? pino(buildLoggerOptions(cfg), destination)
    : pino(buildLoggerOptions(cfg));
  return instance;
}
