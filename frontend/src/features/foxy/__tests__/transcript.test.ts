import { describe, expect, it } from 'vitest';
import type { FoxyMessageDto } from '@/lib/api/generated/contracts/foxy.contract';
import { historyToMessages } from '../lib/transcript';

const stored: FoxyMessageDto = {
  id: 'server-1',
  role: 'assistant',
  text: 'Photosynthesis is how a plant makes food.',
  action: null,
  citations: [{ chunkId: 'chunk-1', chapterNumber: 6, chapterTitle: 'Life Processes' }],
  abstained: false,
  createdAt: '2026-08-14T09:00:00.000Z',
};

describe('stored history', () => {
  it('is empty for a session with no messages', () => {
    expect(historyToMessages([])).toEqual([]);
  });

  it('carries the text, the citations and the abstention through unchanged', () => {
    const [message] = historyToMessages([stored]);

    expect(message?.text).toBe(stored.text);
    expect(message?.citations).toEqual(stored.citations);
    expect(message?.role).toBe('assistant');
    expect(message?.abstained).toBe(false);
  });

  /*
   * The stored and live halves are rendered as ONE list with `localId` as the
   * React key, and the live half counts from `local-1`. An unprefixed stored id
   * would eventually collide and React would reuse the wrong DOM node — a
   * defect that appears as one message wearing another's text.
   */
  it('namespaces the key so it cannot collide with a live message', () => {
    const [message] = historyToMessages([stored]);

    expect(message?.localId).toBe('stored-server-1');
    expect(message?.localId).not.toMatch(/^local-/);
  });

  /** A stored turn has finished by definition — never `streaming`. */
  it('marks everything complete and untruncated', () => {
    const [message] = historyToMessages([stored]);

    expect(message?.status).toBe('complete');
    expect(message?.truncated).toBe(false);
  });

  it('keeps the server id, because citations match on it', () => {
    const [message] = historyToMessages([stored]);

    expect(message?.serverId).toBe('server-1');
  });

  it('preserves an abstention as an abstention', () => {
    const [message] = historyToMessages([{ ...stored, abstained: true, citations: [] }]);

    expect(message?.abstained).toBe(true);
    expect(message?.status).toBe('complete');
  });
});
