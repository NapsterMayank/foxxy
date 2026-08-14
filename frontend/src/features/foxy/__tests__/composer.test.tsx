import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_QUESTION_CHARS } from '@/lib/api/generated/constants/foxy';
import { Composer } from '../components/composer';

afterEach(cleanup);

function setup(overrides: { isStreaming?: boolean; isExhausted?: boolean } = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();

  render(
    <Composer
      isExhausted={overrides.isExhausted ?? false}
      isStreaming={overrides.isStreaming ?? false}
      onSend={onSend}
      onStop={onStop}
    />,
  );

  return { onSend, onStop, box: screen.getByLabelText('Your question') };
}

describe('the composer', () => {
  it('refuses to send an empty question', () => {
    const { onSend } = setup();

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('refuses whitespace, and sends the trimmed question', () => {
    const { box, onSend } = setup();

    fireEvent.change(box, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(box, { target: { value: '  What is photosynthesis?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('What is photosynthesis?');
  });

  it('clears the box on send, so a second press cannot resend the same question', () => {
    const { box } = setup();

    fireEvent.change(box, { target: { value: 'Explain fractions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(box).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  /*
   * §7: "user sends again while streaming — block or queue. Never interleave
   * two streams into one message." The hook refuses silently; the composer is
   * what makes the refusal visible, so a student is not left pressing a button
   * that appears to do nothing.
   */
  it('blocks a second send while an answer is arriving, and offers stop instead', () => {
    const { box, onStop } = setup({ isStreaming: true });

    fireEvent.change(box, { target: { value: 'Another question' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('offers no stop button when nothing is streaming', () => {
    setup();

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('closes the box entirely when today’s messages are gone', () => {
    const { box } = setup({ isExhausted: true });

    expect(box).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  /*
   * The limit comes from the GENERATED constant, which the backend applies
   * twice — the Zod contract rejects a longer body, and the safety classifier
   * refuses it independently. A client limit that disagreed would lose a
   * question the student watched themselves type.
   */
  it('stops typing at the backend’s own limit and counts down to it', () => {
    const { box } = setup();

    expect(box).toHaveAttribute('maxLength', String(MAX_QUESTION_CHARS));
    expect(screen.getByText(`${MAX_QUESTION_CHARS} characters left`)).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'abcde' } });
    expect(screen.getByText(`${MAX_QUESTION_CHARS - 5} characters left`)).toBeInTheDocument();
  });
});
