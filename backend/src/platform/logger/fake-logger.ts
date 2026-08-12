import type { Logger, LogLevel } from './logger';

export interface CapturedLogLine {
  readonly level: LogLevel;
  readonly bindings: Record<string, unknown>;
  readonly obj: Record<string, unknown>;
  readonly msg: string | undefined;
}

/**
 * Test fake. Records calls to an array instead of writing anywhere.
 *
 * It does NOT redact — redaction is a property of the real pino adapter and
 * is asserted against that adapter. Using the fake to assert redaction would
 * test the fake, not the system.
 */
export class FakeLogger implements Logger {
  readonly lines: CapturedLogLine[] = [];

  constructor(private readonly bindings: Record<string, unknown> = {}) {}

  private record(level: LogLevel, obj: Record<string, unknown>, msg?: string): void {
    this.lines.push({ level, bindings: this.bindings, obj, msg });
  }

  fatal(obj: Record<string, unknown>, msg?: string): void {
    this.record('fatal', obj, msg);
  }
  error(obj: Record<string, unknown>, msg?: string): void {
    this.record('error', obj, msg);
  }
  warn(obj: Record<string, unknown>, msg?: string): void {
    this.record('warn', obj, msg);
  }
  info(obj: Record<string, unknown>, msg?: string): void {
    this.record('info', obj, msg);
  }
  debug(obj: Record<string, unknown>, msg?: string): void {
    this.record('debug', obj, msg);
  }
  trace(obj: Record<string, unknown>, msg?: string): void {
    this.record('trace', obj, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    const childLogger = new FakeLogger({ ...this.bindings, ...bindings });
    // Children share the parent's buffer so assertions have one place to look.
    Object.defineProperty(childLogger, 'lines', { value: this.lines });
    return childLogger;
  }
}
