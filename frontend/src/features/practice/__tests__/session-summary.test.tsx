import { cleanup, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubmissionResult } from '@/lib/api/generated/contracts/practice.contract';
import { SessionSummary } from '../components/session-summary';

afterEach(cleanup);

function result(overrides: Partial<SubmissionResult> = {}): SubmissionResult {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    scorePercent: 67,
    correctCount: 4,
    questionCount: 6,
    xpAwarded: 90,
    xpEarned: 90,
    dailyCapReached: false,
    isValid: true,
    invalidReason: null,
    evidence: 'developing',
    nextReviewAt: '2026-08-21T04:30:00.000Z',
    ...overrides,
  };
}

describe('the practice result', () => {
  it('shows the score and the XP — §10.4', () => {
    render(<SessionSummary result={result()} />);

    expect(screen.getByText('4 of 6 correct')).toBeInTheDocument();
    expect(screen.getByText('90 XP')).toBeInTheDocument();
  });

  /*
   * `scorePercent` IS ON THE WIRE AND IS DELIBERATELY NOT RENDERED. A session
   * score and a mastery percentage are indistinguishable to a child — both are
   * a number out of a hundred describing them — and §9.1 forbids the second.
   */
  it('never renders a percentage', () => {
    const { container } = render(<SessionSummary result={result()} />);

    expect(container.textContent).not.toContain('67');
    expect(container.textContent).not.toContain('%');
  });

  /*
   * D-283: `xpAwarded` is post-cap and `xpEarned` is pre-cap. Showing only the
   * awarded figure is how a student concludes the app miscounted.
   */
  it('says what the cap withheld rather than quietly showing a smaller number', () => {
    render(<SessionSummary result={result({ xpAwarded: 90, xpEarned: 110, dailyCapReached: true })} />);

    expect(screen.getByText('90 XP')).toBeInTheDocument();
    expect(screen.getByText('20 XP was not added — today’s cap is full.')).toBeInTheDocument();
  });

  it('says nothing about the cap when nothing was withheld', () => {
    const { container } = render(<SessionSummary result={result({ dailyCapReached: true })} />);

    expect(container.textContent).not.toContain('was not added');
  });

  /*
   * §10.4: "an invalid attempt shows its reason". The reason CODE is never
   * rendered, and the notice is worded as withheld XP rather than as an
   * accusation.
   */
  it('explains an invalid attempt without naming the rule that caught it', () => {
    render(<SessionSummary result={result({ isValid: false, invalidReason: 'too_fast', xpAwarded: 0 })} />);

    expect(screen.getByText('This attempt did not count')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Take your time');
    expect(screen.getByRole('status')).not.toHaveTextContent('too_fast');
  });

  it('shows the evidence as a word', () => {
    render(<SessionSummary result={result()} />);

    expect(screen.getByText('Developing')).toBeInTheDocument();
  });

  it('names the day the chapter comes back', () => {
    render(<SessionSummary result={result()} />);

    expect(screen.getByText(/21 August/)).toBeInTheDocument();
  });

  /*
   * The interface language and the device locale are chosen separately by every
   * browser. A Hindi reader must not get an English month in a Hindi sentence.
   */
  it('renders the date and the evidence in Hindi for a Hindi reader', () => {
    render(<SessionSummary result={result()} />, { language: 'hi' });

    expect(screen.getByText('बन रहा है')).toBeInTheDocument();
    expect(screen.getByText(/अगस्त/)).toBeInTheDocument();
  });
});
