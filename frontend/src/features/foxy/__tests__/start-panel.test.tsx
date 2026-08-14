import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartPanel } from '../components/start-panel';

afterEach(cleanup);

const modes = [{ code: 'doubt' }, { code: 'explain' }, { code: 'practice' }];

describe('opening a conversation', () => {
  it('offers the three modes and the pilot subjects', () => {
    render(<StartPanel isPending={false} modes={modes} onStart={vi.fn()} />);

    expect(screen.getByRole('option', { name: 'Ask me anything' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Walk me through a topic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Quiz me' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Mathematics' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Science' })).toBeInTheDocument();
  });

  /*
   * THE GRADE IS NOT ON THIS FORM AND MUST NEVER BE. The contract is explicit:
   * it comes from the student's profile, because "a grade a caller could choose
   * is a grade a caller could choose wrongly" — and a wrong grade grounds every
   * answer in the wrong textbook with no signal that anything is off.
   */
  it('does not ask for a grade', () => {
    render(<StartPanel isPending={false} modes={modes} onStart={vi.fn()} />);

    expect(screen.queryByLabelText('Grade')).not.toBeInTheDocument();
  });

  it('starts with the chosen mode and subject', () => {
    const onStart = vi.fn();
    render(<StartPanel isPending={false} modes={modes} onStart={onStart} />);

    fireEvent.change(screen.getByLabelText('How would you like to work?'), {
      target: { value: 'explain' },
    });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'science' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(onStart).toHaveBeenCalledWith({ mode: 'explain', subject: 'science' });
  });

  /*
   * A mode this build cannot label is DROPPED rather than shown blank. A
   * nameless option is unpickable, and a student who picks it lands in a mode
   * they did not choose.
   */
  it('drops a mode it has no label for', () => {
    render(
      <StartPanel isPending={false} modes={[...modes, { code: 'debate' }]} onStart={vi.fn()} />,
    );

    expect(screen.getAllByRole('option', { name: /me|through/ })).toHaveLength(3);
    expect(screen.queryByRole('option', { name: '' })).not.toBeInTheDocument();
  });

  it('refuses a second press while the first is in flight', () => {
    const onStart = vi.fn();
    render(<StartPanel isPending modes={modes} onStart={onStart} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('announces a failure to start where a screen reader will hear it', () => {
    render(
      <StartPanel
        error="The conversation could not be started. Try again."
        isPending={false}
        modes={modes}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('could not be started');
  });
});
