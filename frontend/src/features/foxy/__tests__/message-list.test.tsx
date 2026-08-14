import { cleanup, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageList } from '../components/message-list';
import type { FoxyStreamMessage } from '../hooks/use-foxy-stream';

afterEach(cleanup);

/**
 * ===========================================================================
 * §7's RENDERING RULE, TESTED AS WRITTEN: "hand it an array, assert what
 * appears."
 *
 * Not one of these tests touches `fetch`, a hook or a query client. That is the
 * property the rule buys, and a test file that needed a network to check a
 * bubble's colour would be evidence the rule had been broken.
 * ===========================================================================
 */

function message(overrides: Partial<FoxyStreamMessage> = {}): FoxyStreamMessage {
  return {
    localId: 'local-1',
    serverId: null,
    role: 'assistant',
    text: 'A plant makes its own food.',
    citations: [],
    abstained: false,
    status: 'complete',
    truncated: false,
    ...overrides,
  };
}

describe('the transcript', () => {
  it('is a labelled log region, so it is reachable by landmark', () => {
    render(<MessageList messages={[]} />);

    expect(screen.getByRole('log', { name: 'Conversation with Foxy' })).toBeInTheDocument();
  });

  it('names who said what, rather than relying on which side it sits on', () => {
    render(
      <MessageList
        messages={[
          message({ localId: 'local-1', role: 'user', text: 'What is photosynthesis?' }),
          message({ localId: 'local-2' }),
        ]}
      />,
    );

    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Foxy')).toBeInTheDocument();
    expect(screen.getByText('What is photosynthesis?')).toBeInTheDocument();
  });

  /*
   * THE aria-busy TEST IS THE IMPORTANT ONE IN THIS FILE.
   *
   * Without it the polite live region announces on every token frame, which
   * arrive milliseconds apart — a screen-reader user hears a stuttering word
   * salad instead of an answer. `aria-busy` holds the announcement until the
   * turn settles, so it must be present WHILE streaming and gone afterwards.
   */
  it('holds the announcement while the answer is still arriving', () => {
    const { rerender } = render(
      <MessageList messages={[message({ status: 'streaming', text: 'A plant' })]} />,
    );

    const streaming = screen.getByRole('article');
    expect(streaming).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('foxy-streaming')).toHaveTextContent('Foxy is answering');

    rerender(<MessageList messages={[message({ status: 'complete' })]} />);

    expect(screen.getByRole('article')).not.toHaveAttribute('aria-busy');
    expect(screen.queryByTestId('foxy-streaming')).not.toBeInTheDocument();
  });

  /*
   * An abstention is a SUCCESSFUL ANSWER. Rendering it as a failure — red, or
   * with a retry button — teaches a student that the tutor being honest about
   * the limits of their textbook is the tutor breaking, which is the opposite
   * of what the grounding rail is for.
   */
  it('renders an abstention as an answer and never as a failure', () => {
    render(
      <MessageList
        messages={[
          message({ abstained: true, text: 'I could not find this in your textbook.' }),
        ]}
      />,
    );

    expect(screen.getByText('Not found in your textbook')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveAttribute('data-status', 'complete');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows where the answer came from', () => {
    render(
      <MessageList
        messages={[
          message({
            citations: [
              { chunkId: 'c1', chapterNumber: 6, chapterTitle: 'Life Processes' },
              { chunkId: 'c2', chapterNumber: null, chapterTitle: null },
            ],
          }),
        ]}
      />,
    );

    expect(screen.getByText('From your textbook')).toBeInTheDocument();
    expect(screen.getByText('Chapter 6: Life Processes')).toBeInTheDocument();
    // A chunk with no chapter metadata still gets a row: it WAS used, and
    // dropping it would make the answer look less grounded than it is.
    expect(screen.getByText('Your textbook')).toBeInTheDocument();
  });

  it('says so when the cap stopped the answer growing', () => {
    render(<MessageList messages={[message({ truncated: true })]} />);

    expect(
      screen.getByText('This answer was longer than Foxy can show. Ask again for a shorter one.'),
    ).toBeInTheDocument();
  });

  /*
   * §7: "keep the partial text visible and offer retry. NEVER SILENTLY DISCARD
   * IT." The text staying on screen is half of that promise, and this is the
   * half the list owns.
   */
  it('keeps the partial text of a failed turn on screen', () => {
    render(<MessageList messages={[message({ status: 'failed', text: 'A plant makes' })]} />);

    expect(screen.getByText('A plant makes')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveAttribute('data-status', 'failed');
  });

  it('renders every message it is given, keyed so nothing is dropped', () => {
    render(
      <MessageList
        messages={[
          message({ localId: 'stored-a', text: 'first' }),
          message({ localId: 'local-1', text: 'second' }),
          message({ localId: 'local-2', text: 'third' }),
        ]}
      />,
    );

    expect(screen.getAllByRole('article')).toHaveLength(3);
  });

  it('renders the same transcript in Hindi', () => {
    render(<MessageList messages={[message({ abstained: true })]} />, { language: 'hi' });

    expect(screen.getByRole('log', { name: 'Foxy के साथ बातचीत' })).toBeInTheDocument();
    expect(screen.getByText('यह आपकी किताब में नहीं मिला')).toBeInTheDocument();
  });
});
