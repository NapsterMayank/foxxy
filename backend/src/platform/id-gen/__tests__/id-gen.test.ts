import { describe, expect, it } from 'vitest';
import { CounterIdGen, createUuidGen } from '../index';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the real id generator', () => {
  it('produces version-4 UUIDs', () => {
    expect(createUuidGen().uuid()).toMatch(UUID_V4);
  });

  it('produces a different value each call', () => {
    const gen = createUuidGen();
    expect(gen.uuid()).not.toBe(gen.uuid());
  });
});

describe('CounterIdGen', () => {
  it('produces a predictable, ordered sequence', () => {
    const gen = new CounterIdGen();
    expect(gen.uuid()).toBe('00000000-0000-4000-8000-000000000001');
    expect(gen.uuid()).toBe('00000000-0000-4000-8000-000000000002');
    expect(gen.uuid()).toBe('00000000-0000-4000-8000-000000000003');
  });

  it('produces values a uuid column will accept', () => {
    expect(new CounterIdGen().uuid()).toMatch(UUID_V4);
  });

  it('keeps the sequence sortable in string order', () => {
    const gen = new CounterIdGen();
    const ids = [gen.uuid(), gen.uuid(), gen.uuid()];
    expect([...ids].sort()).toEqual(ids);
  });

  it('can start from an offset', () => {
    expect(new CounterIdGen(41).uuid()).toBe('00000000-0000-4000-8000-00000000002a');
  });

  it('reports how many ids it has issued', () => {
    const gen = new CounterIdGen();
    gen.uuid();
    gen.uuid();
    expect(gen.issued).toBe(2);
  });

  it('resets', () => {
    const gen = new CounterIdGen();
    gen.uuid();
    gen.reset();
    expect(gen.uuid()).toBe('00000000-0000-4000-8000-000000000001');
    gen.reset(10);
    expect(gen.issued).toBe(10);
  });

  it('stays a valid uuid past 16 counts, where the hex digit rolls over', () => {
    const gen = new CounterIdGen(15);
    expect(gen.uuid()).toBe('00000000-0000-4000-8000-000000000010');
  });
});
