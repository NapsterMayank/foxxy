import { describe, expect, it } from 'vitest';
import { maskEmail, maskName, redactMessage, redactText } from '../domain/masking';

/**
 * =============================================================================
 * THE MASKS, PINNED.
 *
 * These are four small pure functions and they are the difference between an
 * operations screen and a data breach with a login page. The tests below are
 * mostly about what must NOT come out, because that is the property that decays
 * — somebody widens a mask to make a screen more useful, and nothing fails.
 * =============================================================================
 */

describe('maskEmail', () => {
  it('keeps the first character and the TLD, and nothing else', () => {
    expect(maskEmail('aarav.sharma@gmail.com')).toBe('a•••@g•••.com');
  });

  it('keeps a test TLD recognisable, which is why the TLD survives at all', () => {
    // A synthetic account mistaken for a real learner has cost time before.
    expect(maskEmail('seed42@example.test')).toBe('s•••@e•••.test');
  });

  it('does not leak the length of the local part', () => {
    // Always three dots. One dot per character would disclose the length, which
    // is a real signal about the underlying value for no benefit at all.
    expect(maskEmail('a@x.com')).toBe(maskEmail('averylonglocalpart@x.com'));
  });

  it('is stable, so the same person reads as the same person', () => {
    // The mask is a pseudonym on purpose: an operator must be able to tell two
    // rows apart and recognise a return visit.
    expect(maskEmail('a@b.com')).toBe(maskEmail('a@b.com'));
  });

  it('distinguishes different addresses', () => {
    expect(maskEmail('aarav@gmail.com')).not.toBe(maskEmail('bhavna@gmail.com'));
  });

  it('masks the whole value when it is not shaped like an address', () => {
    // An unparseable value is the one most likely to be something unexpected,
    // and unexpected is not a reason to disclose it.
    expect(maskEmail('not-an-address')).toBe('n•••');
    expect(maskEmail('@nothing')).toBe('@•••');
    expect(maskEmail('trailing@')).toBe('t•••');
  });

  it('handles a domain with no dot', () => {
    expect(maskEmail('a@localhost')).toBe('a•••@l•••');
  });

  it('renders nothing as a dash rather than as an empty mask', () => {
    expect(maskEmail(null)).toBe('—');
    expect(maskEmail('   ')).toBe('—');
  });

  it.each([
    'aarav.sharma@gmail.com',
    'seed42@example.test',
    'a@localhost',
  ])('never contains the local part of %s', (email) => {
    const local = email.slice(0, email.lastIndexOf('@'));
    const masked = maskEmail(email);
    if (local.length > 1) {
      expect(masked).not.toContain(local);
    }
  });
});

describe('maskName', () => {
  it('reduces a name to initials', () => {
    expect(maskName('Aarav Sharma')).toBe('A.S.');
  });

  it('handles one name and three', () => {
    expect(maskName('Aarav')).toBe('A.');
    expect(maskName('Aarav Kumar Sharma')).toBe('A.K.S.');
  });

  it('does not return the first name', () => {
    // A first name plus a school plus a grade identifies a child, and an
    // operations list shows all three together.
    expect(maskName('Aarav Sharma')).not.toContain('Aarav');
  });

  it('works on non-Latin scripts by code point, not by byte', () => {
    expect(maskName('आरव शर्मा')).toBe('आ.श.');
  });

  it('collapses stray whitespace rather than emitting empty initials', () => {
    expect(maskName('  Aarav   Sharma  ')).toBe('A.S.');
  });

  it('renders nothing as a dash', () => {
    expect(maskName(null)).toBe('—');
    expect(maskName('   ')).toBe('—');
  });
});

describe('redactMessage', () => {
  it('returns no text at all — not a truncation, an absence', () => {
    const redacted = redactMessage({
      role: 'user',
      content: 'My name is Aarav and I do not understand fractions',
      createdAt: new Date('2026-08-25T10:00:00.000Z'),
    });

    expect(redacted).toEqual({
      role: 'user',
      length: 50,
      createdAt: '2026-08-25T10:00:00.000Z',
    });
    // The shape carries no field that could hold prose. A partial mask of a
    // sentence is not a mask: the first characters routinely contain the name,
    // the question and the distress.
    expect(JSON.stringify(redacted)).not.toContain('Aarav');
    expect(JSON.stringify(redacted)).not.toContain('fractions');
  });

  it('keeps length, which is operational and discloses nothing alone', () => {
    const short = redactMessage({ role: 'user', content: 'x', createdAt: new Date(0) });
    const long = redactMessage({ role: 'user', content: 'x'.repeat(900), createdAt: new Date(0) });
    expect(short.length).toBe(1);
    expect(long.length).toBe(900);
  });
});

describe('redactText', () => {
  it('reports presence and length, never content', () => {
    expect(redactText('why does a negative times a negative become positive')).toEqual({
      present: true,
      length: 52,
    });
  });

  it('distinguishes absent from empty', () => {
    // A trace with no prompt and a trace with an empty prompt are different
    // failures, and `length: 0` alone cannot tell them apart.
    expect(redactText(null)).toEqual({ present: false, length: 0 });
    expect(redactText('')).toEqual({ present: true, length: 0 });
  });
});
