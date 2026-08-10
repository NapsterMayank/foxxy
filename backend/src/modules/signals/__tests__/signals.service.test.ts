import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { MIN_AVERAGE_MS_PER_QUESTION, validateAttempt } from '@/modules/practice/domain/anti-cheat';
import type { Logger } from '@/platform/logger/index';
import { createAnomalyRuleRegistry } from '../domain/anomaly-rules';
import { MS_PER_DAY } from '../domain/thresholds';
import type { SignalsRepository } from '../signals.repository';
import { createSignalsService } from '../signals.service';
import type { AntiCheatEdge, AnomalyWindow, SessionFact } from '../signals.types';

const STUDENT = '11111111-1111-1111-1111-111111111111';
const CHAPTER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** The real `practice` functions, through the edge. See the domain test's note. */
const realAntiCheat: AntiCheatEdge = {
  minimumAverageMsPerQuestion: MIN_AVERAGE_MS_PER_QUESTION,
  isAttemptValid: (responses, questionCount) => validateAttempt(responses, questionCount).isValid,
};

const NOW = new Date('2026-09-01T00:00:00.000Z');
const WINDOW: AnomalyWindow = {
  from: new Date(NOW.getTime() - 30 * MS_PER_DAY),
  to: NOW,
};

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function createFakeRepository(
  sessions: readonly SessionFact[],
  lastActivityAt: Date | null,
): SignalsRepository {
  return {
    listSessionsInWindow: (): Promise<SessionFact[]> => Promise.resolve([...sessions]),
    getLastActivityAt: (): Promise<Date | null> => Promise.resolve(lastActivityAt),
  };
}

function createService(
  sessions: readonly SessionFact[],
  lastActivityAt: Date | null,
  logger: Logger = createLogger(),
): ReturnType<typeof createSignalsService> {
  return createSignalsService({
    repository: createFakeRepository(sessions, lastActivityAt),
    registry: createAnomalyRuleRegistry(realAntiCheat),
    clock: new FixedClock(NOW),
    logger,
  });
}

function failedSession(index: number): SessionFact {
  return {
    sessionId: `s${String(index)}`,
    chapterId: CHAPTER,
    submittedAt: new Date(NOW.getTime() - (10 - index) * MS_PER_DAY),
    scorePercent: 20,
    isValid: true,
    questionCount: 10,
    responses: Array.from({ length: 10 }, (_unused, i) => ({
      selectedIndex: i % 4,
      timeSpentMs: 30_000,
    })),
  };
}

describe('signals.service — detectAnomalies', () => {
  it('returns an empty list for a student with no history, never an error', async () => {
    const service = createService([], null);
    await expect(service.detectAnomalies(STUDENT, WINDOW)).resolves.toEqual([]);
  });

  it('detects repeated struggle and stamps it with the rule version', async () => {
    const service = createService([failedSession(0), failedSession(1), failedSession(2)], NOW);
    const signals = await service.detectAnomalies(STUDENT, WINDOW);
    const struggle = signals.find((s) => s.kind === 'repeated_struggle');
    expect(struggle?.ruleStamp).toBe('repeated_struggle@1');
    expect(struggle?.studentUserId).toBe(STUDENT);
    expect(struggle?.chapterId).toBe(CHAPTER);
  });

  it('uses the INJECTED clock for the evaluation instant — no clock is read deeper', async () => {
    const service = createService([], new Date(NOW.getTime() - 30 * MS_PER_DAY));
    const signals = await service.detectAnomalies(STUDENT, WINDOW);
    expect(signals[0]?.detectedAt).toEqual(NOW);
  });

  it('is deterministic — the same inputs return the same output', async () => {
    const sessions = [failedSession(0), failedSession(1), failedSession(2)];
    const first = await createService(sessions, NOW).detectAnomalies(STUDENT, WINDOW);
    const second = await createService(sessions, NOW).detectAnomalies(STUDENT, WINDOW);
    expect(first).toEqual(second);
  });

  it('REFUSES a reversed window rather than silently reporting a healthy student', async () => {
    const service = createService([], NOW);
    await expect(
      service.detectAnomalies(STUDENT, { from: WINDOW.to, to: WINDOW.from }),
    ).rejects.toThrow(RangeError);
  });

  it('accepts a zero-length window', async () => {
    const service = createService([], null);
    await expect(
      service.detectAnomalies(STUDENT, { from: NOW, to: NOW }),
    ).resolves.toEqual([]);
  });

  it('logs COUNTS AND STAMPS only — never a reason string or a payload', async () => {
    const logger = createLogger();
    const info = vi.spyOn(logger, 'info');
    const service = createService(
      [failedSession(0), failedSession(1), failedSession(2)],
      NOW,
      logger,
    );
    await service.detectAnomalies(STUDENT, WINDOW);

    expect(info).toHaveBeenCalledTimes(1);
    const [payload] = info.mock.calls[0] ?? [];
    expect(Object.keys(payload as object).sort()).toEqual([
      'ruleStamps',
      'signalCount',
      'studentUserId',
    ]);
  });

  it('does not log at all when nothing was detected', async () => {
    const logger = createLogger();
    const info = vi.spyOn(logger, 'info');
    await createService([], null, logger).detectAnomalies(STUDENT, WINDOW);
    expect(info).not.toHaveBeenCalled();
  });
});
