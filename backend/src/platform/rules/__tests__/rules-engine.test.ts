import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { activeVersionOrNull, evaluateAll, evaluateRule, matchedOnly } from '../evaluator';
import {
  DuplicateRuleError,
  NoActiveRuleVersionError,
  UnknownRuleError,
  createRuleRegistry,
} from '../registry';
import { type Rule, parseRuleStamp, ruleStamp } from '../rule';

/**
 * THE FACTS ARE DELIBERATELY MEANINGLESS. `platform/rules` must not know what a
 * student is, so its tests must not either — a fixture called `daysInactive`
 * here would be the first business rule sneaking into `platform/`.
 */
interface Facts {
  readonly value: number;
  readonly label: string;
}

interface Outcome {
  readonly note: string;
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-03-01T00:00:00.000Z');
const T2 = new Date('2026-06-01T00:00:00.000Z');

function rule(
  code: string,
  version: number,
  threshold: number,
  activeFrom: Date = T0,
): Rule<Facts, Outcome> {
  return {
    code,
    version,
    activeFrom,
    condition: (facts) => facts.value >= threshold,
    action: (facts) => ({ note: `${code}@${String(version)} saw ${String(facts.value)}` }),
  };
}

describe('ruleStamp / parseRuleStamp', () => {
  it('round-trips a stamp', () => {
    expect(ruleStamp('alpha', 3)).toBe('alpha@3');
    expect(parseRuleStamp('alpha@3')).toEqual({ code: 'alpha', version: 3 });
  });

  it('splits on the LAST @, so a code containing one survives', () => {
    expect(parseRuleStamp('a@b@12')).toEqual({ code: 'a@b', version: 12 });
  });

  it('returns null for a malformed stamp rather than throwing over stored data', () => {
    expect(parseRuleStamp('no-version')).toBeNull();
    expect(parseRuleStamp('@3')).toBeNull();
    expect(parseRuleStamp('code@')).toBeNull();
    expect(parseRuleStamp('code@v3')).toBeNull();
    expect(parseRuleStamp('code@-1')).toBeNull();
  });
});

describe('createRuleRegistry', () => {
  it('REJECTS a duplicate (code, version)', () => {
    expect(() => createRuleRegistry([rule('a', 1, 0), rule('a', 1, 5)])).toThrow(
      DuplicateRuleError,
    );
  });

  it('allows the same code at different versions, and the same version under different codes', () => {
    const registry = createRuleRegistry([rule('a', 1, 0), rule('a', 2, 5), rule('b', 1, 0)]);
    expect(registry.list()).toHaveLength(3);
  });

  it('rejects a version that is not a positive integer', () => {
    expect(() => createRuleRegistry([rule('a', 0, 0)])).toThrow(RangeError);
    expect(() => createRuleRegistry([rule('a', 1.5, 0)])).toThrow(RangeError);
    expect(() => createRuleRegistry([rule('a', -1, 0)])).toThrow(RangeError);
  });

  it('ORDERS rules by code then version, whatever order they were given in', () => {
    const registry = createRuleRegistry([
      rule('b', 2, 0),
      rule('a', 2, 0),
      rule('b', 1, 0),
      rule('a', 1, 0),
    ]);
    expect(registry.list().map((r) => ruleStamp(r.code, r.version))).toEqual([
      'a@1',
      'a@2',
      'b@1',
      'b@2',
    ]);
  });

  it('the order is STABLE across registries built from different input orders', () => {
    const forwards = createRuleRegistry([rule('a', 1, 0), rule('b', 1, 0), rule('c', 1, 0)]);
    const backwards = createRuleRegistry([rule('c', 1, 0), rule('b', 1, 0), rule('a', 1, 0)]);
    expect(forwards.codes()).toEqual(backwards.codes());
    expect(forwards.list().map((r) => r.code)).toEqual(backwards.list().map((r) => r.code));
  });

  it('does not mutate the array it was given', () => {
    const input = [rule('b', 1, 0), rule('a', 1, 0)];
    createRuleRegistry(input);
    expect(input.map((r) => r.code)).toEqual(['b', 'a']);
  });

  it('reports distinct codes, ascending', () => {
    const registry = createRuleRegistry([rule('z', 1, 0), rule('a', 1, 0), rule('a', 2, 0)]);
    expect(registry.codes()).toEqual(['a', 'z']);
  });

  it('is empty-safe', () => {
    const registry = createRuleRegistry<Facts, Outcome>([]);
    expect(registry.list()).toEqual([]);
    expect(registry.codes()).toEqual([]);
    expect(registry.has('anything')).toBe(false);
  });

  it('an empty registry still fails loudly, and says there are no rules at all', () => {
    const registry = createRuleRegistry<Facts, Outcome>([]);
    expect(() => registry.resolve('anything', T1)).toThrow(/Registered codes: \(none\)/);
  });
});

describe('registry.resolve — an unknown code FAILS LOUDLY', () => {
  const registry = createRuleRegistry([rule('a', 1, 0)]);

  it('throws UnknownRuleError, naming what is registered', () => {
    expect(() => registry.resolve('ghost', T1)).toThrow(UnknownRuleError);
    expect(() => registry.resolve('ghost', T1)).toThrow(/Registered codes: a/);
  });

  it('throws on versionsOf and resolveExact too — never returns undefined', () => {
    expect(() => registry.versionsOf('ghost')).toThrow(UnknownRuleError);
    expect(() => registry.resolveExact('a', 99)).toThrow(UnknownRuleError);
  });

  it('has() is the non-throwing question', () => {
    expect(registry.has('a')).toBe(true);
    expect(registry.has('ghost')).toBe(false);
  });
});

describe('registry.resolve — version selection by instant', () => {
  const registry = createRuleRegistry([
    rule('a', 1, 10, T0),
    rule('a', 2, 20, T1),
    rule('a', 3, 30, T2),
  ]);

  it('picks the highest version already active, not the highest version', () => {
    expect(registry.resolve('a', T0).version).toBe(1);
    expect(registry.resolve('a', T1).version).toBe(2);
    expect(registry.resolve('a', T2).version).toBe(3);
  });

  it('treats activeFrom as INCLUSIVE', () => {
    expect(registry.resolve('a', new Date(T1.getTime())).version).toBe(2);
    expect(registry.resolve('a', new Date(T1.getTime() - 1)).version).toBe(1);
  });

  it('throws rather than falling back when nothing was active yet', () => {
    expect(() => registry.resolve('a', new Date('2025-01-01T00:00:00.000Z'))).toThrow(
      NoActiveRuleVersionError,
    );
  });

  it('resolveExact replays a stored decision regardless of the instant', () => {
    expect(registry.resolveExact('a', 1).version).toBe(1);
  });
});

describe('evaluateRule — the version is recorded on EVERY result', () => {
  it('stamps a match', () => {
    const result = evaluateRule(rule('a', 2, 10), { value: 50, label: 'x' }, T1);
    expect(result.matched).toBe(true);
    expect(result.ruleCode).toBe('a');
    expect(result.ruleVersion).toBe(2);
    expect(result.ruleStamp).toBe('a@2');
    expect(result.outcome).toEqual({ note: 'a@2 saw 50' });
  });

  it('stamps a NON-match just as fully — the negative is half the audit trail', () => {
    const result = evaluateRule(rule('a', 2, 10), { value: 1, label: 'x' }, T1);
    expect(result.matched).toBe(false);
    expect(result.ruleStamp).toBe('a@2');
    expect(result.outcome).toBeNull();
  });

  it('records the instant it was evaluated FOR, copied so a caller cannot mutate it', () => {
    const at = new Date(T1.getTime());
    const result = evaluateRule(rule('a', 1, 0), { value: 1, label: 'x' }, at);
    expect(result.evaluatedAt.toISOString()).toBe(T1.toISOString());
    at.setFullYear(1999);
    expect(result.evaluatedAt.toISOString()).toBe(T1.toISOString());
  });

  it('does not run the action when the condition did not match', () => {
    let ran = 0;
    const counted: Rule<Facts, Outcome> = {
      code: 'a',
      version: 1,
      activeFrom: T0,
      condition: () => false,
      action: () => {
        ran += 1;
        return { note: 'ran' };
      },
    };
    evaluateRule(counted, { value: 0, label: 'x' }, T1);
    expect(ran).toBe(0);
  });

  it('lets a throwing condition propagate — a swallowed error would be a FALSE audit entry', () => {
    const broken: Rule<Facts, Outcome> = {
      code: 'a',
      version: 1,
      activeFrom: T0,
      condition: () => {
        throw new Error('predicate bug');
      },
      action: () => ({ note: 'never' }),
    };
    expect(() => evaluateRule(broken, { value: 0, label: 'x' }, T1)).toThrow('predicate bug');
  });
});

describe('evaluateAll — determinism', () => {
  const registry = createRuleRegistry([
    rule('beta', 1, 10, T0),
    rule('alpha', 1, 5, T0),
    rule('gamma', 1, 1000, T0),
  ]);

  it('produces an IDENTICAL result on repeated evaluation', () => {
    const facts: Facts = { value: 42, label: 'x' };
    const first = evaluateAll(registry, facts, T1);
    const second = evaluateAll(registry, facts, T1);
    const third = evaluateAll(registry, facts, T1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('evaluates in the REGISTRY order, not the order the rules were declared in', () => {
    const result = evaluateAll(registry, { value: 42, label: 'x' }, T1);
    expect(result.map((r) => r.ruleCode)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('the order does not change when the same rules are registered in another order', () => {
    const reversed = createRuleRegistry([
      rule('gamma', 1, 1000, T0),
      rule('alpha', 1, 5, T0),
      rule('beta', 1, 10, T0),
    ]);
    expect(evaluateAll(reversed, { value: 42, label: 'x' }, T1)).toEqual(
      evaluateAll(registry, { value: 42, label: 'x' }, T1),
    );
  });

  it('evaluates EVERY rule — no short-circuit on the first match', () => {
    const result = evaluateAll(registry, { value: 42, label: 'x' }, T1);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.matched)).toEqual([true, true, false]);
  });

  it('uses a real injected clock without ever reading one itself', () => {
    const clock = new FixedClock(T1);
    const first = evaluateAll(registry, { value: 42, label: 'x' }, clock.now());
    clock.advanceDays(30);
    const later = evaluateAll(registry, { value: 42, label: 'x' }, clock.now());
    // Same facts, no new versions: the decision is unchanged and only the
    // recorded instant moved.
    expect(later.map((r) => r.ruleStamp)).toEqual(first.map((r) => r.ruleStamp));
    expect(later.map((r) => r.matched)).toEqual(first.map((r) => r.matched));
    expect(later[0]?.evaluatedAt).not.toEqual(first[0]?.evaluatedAt);
  });
});

describe('evaluateAll — a different version yields a different, TRACEABLE result', () => {
  // v1 fires at 10 and above; v2 raises the bar to 100 from March.
  const registry = createRuleRegistry([rule('a', 1, 10, T0), rule('a', 2, 100, T1)]);
  const facts: Facts = { value: 50, label: 'x' };

  it('the same facts produce opposite outcomes under the two versions', () => {
    const before = evaluateAll(registry, facts, new Date(T1.getTime() - 1));
    const after = evaluateAll(registry, facts, T1);

    expect(before[0]?.matched).toBe(true);
    expect(after[0]?.matched).toBe(false);
  });

  it('and each result names the version that produced it', () => {
    const before = evaluateAll(registry, facts, new Date(T1.getTime() - 1));
    const after = evaluateAll(registry, facts, T1);

    expect(before[0]?.ruleStamp).toBe('a@1');
    expect(after[0]?.ruleStamp).toBe('a@2');
    // The stamp is what makes the disagreement explainable rather than a mystery.
    expect(before[0]?.ruleStamp).not.toBe(after[0]?.ruleStamp);
  });

  it('a stored decision can be REPLAYED exactly from its stamp', () => {
    const stored = evaluateAll(registry, facts, new Date(T1.getTime() - 1))[0];
    const parsed = parseRuleStamp(stored?.ruleStamp ?? '');
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      return;
    }
    const replayed = evaluateRule(
      registry.resolveExact(parsed.code, parsed.version),
      facts,
      stored?.evaluatedAt ?? T0,
    );
    expect(replayed).toEqual(stored);
  });

  it('evaluates ONE version per code, never all of them', () => {
    expect(evaluateAll(registry, facts, T2)).toHaveLength(1);
  });
});

describe('evaluateAll — codes not yet active', () => {
  const registry = createRuleRegistry([rule('early', 1, 0, T0), rule('late', 1, 0, T2)]);

  it('SKIPS a code whose earliest version begins after the instant', () => {
    const result = evaluateAll(registry, { value: 1, label: 'x' }, T1);
    expect(result.map((r) => r.ruleCode)).toEqual(['early']);
  });

  it('includes it once it is active', () => {
    const result = evaluateAll(registry, { value: 1, label: 'x' }, T2);
    expect(result.map((r) => r.ruleCode)).toEqual(['early', 'late']);
  });

  it('but asking for it BY NAME still throws — that caller asserted it applies', () => {
    expect(() => registry.resolve('late', T1)).toThrow(NoActiveRuleVersionError);
  });

  it('activeVersionOrNull is the non-throwing form', () => {
    expect(activeVersionOrNull(registry, 'late', T1)).toBeNull();
    expect(activeVersionOrNull(registry, 'late', T2)?.version).toBe(1);
    expect(activeVersionOrNull(registry, 'ghost', T2)).toBeNull();
  });

  it('returns nothing at all when no rule is active yet, rather than failing', () => {
    expect(evaluateAll(registry, { value: 1, label: 'x' }, new Date('2020-01-01T00:00:00Z'))).toEqual(
      [],
    );
  });
});

describe('matchedOnly', () => {
  it('keeps the matches in the same stable order', () => {
    const registry = createRuleRegistry([rule('a', 1, 5, T0), rule('b', 1, 500, T0)]);
    const all = evaluateAll(registry, { value: 42, label: 'x' }, T1);
    expect(matchedOnly(all).map((r) => r.ruleCode)).toEqual(['a']);
  });

  it('returns an empty list when nothing matched', () => {
    const registry = createRuleRegistry([rule('a', 1, 5000, T0)]);
    expect(matchedOnly(evaluateAll(registry, { value: 1, label: 'x' }, T1))).toEqual([]);
  });
});
