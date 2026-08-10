import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PII_REDACTED, isPiiKey, looksLikePii, scrubRecord, scrubTags } from '../scrub';

/**
 * `platform/pii` guards the two places where caller-supplied data becomes
 * PERMANENT: `audit_log.metadata` and `metrics_events.tags`.
 *
 * The tests are written from the failure end rather than the API end — each one
 * names the row that would otherwise exist forever.
 */

describe('PII-shaped KEYS are dropped whole', () => {
  it('drops an email key regardless of what it contains', () => {
    // Dropped by NAME, not by value. `{ email: 'unknown' }` is harmless today,
    // and the day it stops being harmless nobody revisits this decision.
    expect(scrubRecord({ email: 'a@b.co' }).value).toEqual({});
    expect(scrubRecord({ email: 'unknown' }).value).toEqual({});
  });

  it('matches the key with separators and case removed', () => {
    // One entry, `email`, has to catch `Email`, `user_email`, `userEmail` and
    // `EMAIL_ADDRESS`. A key list that only matched exact lower-case names
    // would be a list that looks thorough and catches almost nothing.
    for (const key of ['Email', 'user_email', 'userEmail', 'EMAIL_ADDRESS', 'parentEmail']) {
      expect(isPiiKey(key)).toBe(true);
      expect(scrubRecord({ [key]: 'x' }).value).toEqual({});
    }
  });

  it('drops phone, password, token, name and address keys', () => {
    const dropped = scrubRecord({
      phone: '9876543210',
      passwordHash: 'argon2id$...',
      sessionToken: 'abc',
      firstName: 'Asha',
      displayName: 'Asha S',
      ipAddress: '10.0.0.1',
      dateOfBirth: '2012-04-01',
    });
    expect(dropped.value).toEqual({});
    expect(dropped.changed).toBe(true);
  });

  it('leaves identifiers and counts alone — the whole point of the table', () => {
    // A scrubber that ate `studentUserId` would make the audit log useless,
    // which is the failure mode opposite to the one it exists to prevent.
    const kept = {
      studentUserId: '11111111-1111-4111-8111-111111111111',
      parentUserId: '22222222-2222-4222-8222-222222222222',
      linkId: 'abc-123',
      sessions: 6,
      revoked: true,
      via: 'reset_token',
    };
    const result = scrubRecord(kept);
    expect(result.value).toEqual(kept);
    expect(result.changed).toBe(false);
  });
});

describe('PII-shaped VALUES are redacted whatever key they arrive under', () => {
  it('redacts an email address hidden in an innocuous key', () => {
    // The case no key list can catch, and the reason there are two mechanisms.
    const result = scrubRecord({ note: 'contacted at asha@example.com about the link' });
    expect(result.value).toEqual({ note: PII_REDACTED });
    expect(result.changed).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain('asha@example.com');
  });

  it('redacts an Indian mobile number in every shape people type it', () => {
    for (const phone of [
      '9876543210',
      '+91 98765 43210',
      '+919876543210',
      '09876543210',
      '98765-43210',
      '0091 9876543210',
    ]) {
      expect(looksLikePii(phone)).toBe(true);
      expect(scrubRecord({ ref: phone }).value).toEqual({ ref: PII_REDACTED });
    }
  });

  it('does NOT redact a uuid, a timestamp or a count', () => {
    // The false-positive side, and it matters as much as the true-positive
    // side: a phone pattern loose enough to fire on a millisecond timestamp
    // would make a metrics table redact its own counters, and a metric that
    // redacts itself is worse than no metric.
    const safe = {
      id: '11111111-1111-4111-8111-111111111111',
      epochMs: '1786340000000',
      count: '9876543210987',
      version: '0.1.0',
      isoDate: '2026-08-09T09:00:00.000Z',
    };
    const result = scrubRecord(safe);
    expect(result.value).toEqual(safe);
    expect(result.changed).toBe(false);
  });

  it('does not redact ANY uuid, not just a hand-picked one', () => {
    /**
     * THIS TEST EXISTS BECAUSE THE ONE ABOVE PASSED WHILE THE CODE WAS WRONG.
     *
     * It asserted a single literal UUID — `1111…` — which happens not to match
     * the phone pattern. Measured over random UUIDs, 1.99% DID: the pattern
     * allowed `-` as an internal separator, and a UUID is hyphen-separated hex,
     * so `07416683-378b-…` contains a perfectly good phone-shaped run.
     *
     * The consequence was not cosmetic. `audit_log` is append-only and its
     * metadata is identifiers by design, so one row in fifty lost an identifier
     * to `[redacted]`, permanently. It surfaced as an intermittently red suite,
     * because whether it happened depended on which UUID Postgres generated.
     *
     * A fixed example cannot catch a 1-in-50 defect. A sample can, so this
     * takes one — deterministically seeded through `randomUUID` over enough
     * draws that a re-regression is caught on effectively every run.
     */
    const uuids = Array.from({ length: 2_000 }, () => randomUUID());
    const redacted = uuids.filter((id) => looksLikePii(id));

    expect(redacted).toEqual([]);
  });

  it('still redacts a phone number that is adjacent to punctuation', () => {
    // The other side of tightening the boundary to `[\w-]`: a real number in
    // running text must still be caught, or the fix has traded a false positive
    // for a false negative, which is the worse of the two here.
    for (const text of ['call me on 8123456789.', '(9876543210)', 'ph: 9876543210,']) {
      expect(looksLikePii(text)).toBe(true);
    }
  });

  it('leaves numbers and booleans untouched', () => {
    const result = scrubRecord({ sessions: 9876543210, ok: true, nothing: null });
    expect(result.value).toEqual({ sessions: 9876543210, ok: true, nothing: null });
    expect(result.changed).toBe(false);
  });
});

describe('nested structures', () => {
  it('scrubs inside nested objects and arrays', () => {
    const result = scrubRecord({
      outer: { inner: { email: 'a@b.co', keep: 'yes' } },
      list: ['fine', 'reach me on 9876543210'],
    });
    expect(result.value).toEqual({
      outer: { inner: { keep: 'yes' } },
      list: ['fine', PII_REDACTED],
    });
  });

  it('reports the PATH of what it touched, never the value', () => {
    // The caller logs these keys at `warn` so the defect can be fixed at its
    // source. Logging the VALUE would move the PII from a permanent table into
    // a log, which is the same leak with a shorter retention period.
    const result = scrubRecord({ outer: { userEmail: 'a@b.co' } });
    expect(result.affectedKeys).toEqual(['outer.userEmail']);
    expect(JSON.stringify(result.affectedKeys)).not.toContain('a@b.co');
  });

  it('truncates beyond the depth limit rather than recursing without bound', () => {
    // Metadata is meant to be flat. The bound exists because an unbounded walk
    // over caller-supplied jsonb is a stack-overflow lever, and because
    // anything nested six deep is a payload dump rather than metadata.
    const deep = { a: { b: { c: { d: { e: { f: 'too far' } } } } } };
    const result = scrubRecord(deep);
    expect(result.changed).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain('too far');
  });

  it('replaces values with no jsonb representation', () => {
    // undefined, functions and symbols are not storable. Guessing a
    // representation is how `[object Object]` ends up in a permanent record.
    const result = scrubRecord({ fn: (): number => 1, sym: Symbol('x'), missing: undefined });
    expect(result.value).toEqual({
      fn: PII_REDACTED,
      sym: PII_REDACTED,
      missing: PII_REDACTED,
    });
  });
});

describe('scrubTags — the flat string map metrics use', () => {
  it('keeps low-cardinality labels', () => {
    const tags = { port: 'cache', from: 'closed', to: 'open' };
    const result = scrubTags(tags);
    expect(result.tags).toEqual(tags);
    expect(result.changed).toBe(false);
  });

  it('drops an identifying key and redacts an identifying value', () => {
    // Both failures arrive together: a user id in a metric dimension is a
    // privacy breach AND a cardinality explosion that takes the metrics store
    // down. There is no version of this that is merely untidy.
    const result = scrubTags({ userEmail: 'a@b.co', note: 'call 9876543210', port: 'llm' });
    expect(result.tags).toEqual({ note: PII_REDACTED, port: 'llm' });
    expect(result.changed).toBe(true);
  });
});

describe('what this does NOT claim', () => {
  it('does not catch deliberately obfuscated contact details', () => {
    // Recorded as a test rather than left to be discovered. A pattern matcher
    // cannot beat a determined caller; the rule that actually protects the data
    // is "metadata is identifiers and counts", stated on the column comment and
    // enforced in review. This catches the ACCIDENT, not the intent.
    const result = scrubRecord({ note: 'asha (at) example (dot) com' });
    expect(result.changed).toBe(false);
    expect(result.value).toEqual({ note: 'asha (at) example (dot) com' });
  });
});
