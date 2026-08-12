import { describe, expect, it } from 'vitest';
import { DependencyError, ValidationError } from '../../errors/index';
import { FAKE_LLM_MODEL, createFakeLlm, fakeTokenCount } from '../fake-llm';
import type { LlmRequest } from '../llm.port';

/**
 * The scripted fake, pinned.
 *
 * These are not tests of a model. They are tests of the four properties every
 * `foxy` test leans on: it is DETERMINISTIC, it RECORDS what it was asked, it
 * records EAGERLY (so "the model was never called" means what it says), and its
 * two failure injectors fail where they claim to.
 */

const REQUEST: LlmRequest = {
  messages: [{ role: 'user', content: 'what is refraction' }],
  maxTokens: 256,
};

async function collect(iterable: AsyncIterable<{ readonly text: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) out.push(chunk.text);
  return out;
}

describe('the scripted language-model fake', () => {
  it('streams the same frames for the same request, every time', async () => {
    const first = await collect(createFakeLlm().stream(REQUEST));
    const second = await collect(createFakeLlm().stream(REQUEST));
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
  });

  it('reassembles byte for byte — the separator is kept, not dropped', async () => {
    const llm = createFakeLlm({ respond: () => 'light bends at a boundary' });
    expect((await collect(llm.stream(REQUEST))).join('')).toBe('light bends at a boundary');
  });

  it('lets a test vary the answer BY REQUEST', async () => {
    const llm = createFakeLlm({
      respond: (req) => `echo:${req.messages.at(-1)?.content ?? ''}`,
    });
    expect((await collect(llm.stream(REQUEST))).join('')).toBe('echo:what is refraction');
  });

  it('records the request EAGERLY, before anything consumes the stream', () => {
    const llm = createFakeLlm();
    llm.stream(REQUEST);
    expect(llm.recorder.callCount()).toBe(1);
    expect(llm.recorder.requests[0]).toEqual(REQUEST);
  });

  it('refuses an empty message list rather than answering it', async () => {
    const llm = createFakeLlm();
    expect(() => llm.stream({ messages: [], maxTokens: 10 })).toThrow(ValidationError);
    await expect(llm.complete({ messages: [], maxTokens: 10 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('returns a completion with stable token counts and the fake model name', async () => {
    const completion = await createFakeLlm({ respond: () => 'a b c' }).complete(REQUEST);
    expect(completion.text).toBe('a b c');
    expect(completion.outputTokens).toBe(3);
    expect(completion.inputTokens).toBe(3);
    expect(completion.model).toBe(FAKE_LLM_MODEL);
  });

  it('failImmediately rejects before a single token — the "nothing to show" case', async () => {
    const llm = createFakeLlm({ failImmediately: true });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of llm.stream(REQUEST)) seen.push(chunk.text);
      })(),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(seen).toEqual([]);
    await expect(llm.complete(REQUEST)).rejects.toBeInstanceOf(DependencyError);
  });

  it('failAfter cuts the stream MID-SENTENCE, keeping what already arrived', async () => {
    const llm = createFakeLlm({ respond: () => 'one two three four', failAfter: 2 });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of llm.stream(REQUEST)) seen.push(chunk.text);
      })(),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(seen.join('')).toBe('one two ');
  });

  it('failAfter beyond the answer length still fails, at the end', async () => {
    const llm = createFakeLlm({ respond: () => 'one two', failAfter: 2 });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of llm.stream(REQUEST)) seen.push(chunk.text);
      })(),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(seen.join('')).toBe('one two');
  });
});

describe('fakeTokenCount', () => {
  it('counts words, and counts nothing as zero', () => {
    expect(fakeTokenCount('one two three')).toBe(3);
    expect(fakeTokenCount('   ')).toBe(0);
  });
});
