import { cleanup, fireEvent,  screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingForm } from '@/features/onboarding/onboarding-form';

afterEach(cleanup);

describe('onboarding presentation', () => {
  it('shows learning preferences for students', () => {
    render(<OnboardingForm role="student" />);

    expect(screen.getByLabelText('Grade')).toBeRequired();
    /*
     * GRADES 6 TO 12, from the backend's generated constant.
     *
     * This test used to assert that Grade 11 was ABSENT, pinning a hardcoded
     * 6-10 list — root PROGRESS.md open item 34. The syllabus runs to 12 and
     * the database CHECK accepts 12, so the form offering less was a defect the
     * test was protecting. Sourcing the options from `GRADES` fixed both.
     */
    expect(screen.getByRole('option', { name: 'Grade 10' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Grade 12' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Preferred language' })).toBeInTheDocument();
    /*
     * THE VALUES ARE `en` AND `hi`, not `english`/`hindi` — the other half of
     * open item 34. The learner contract rejects the long forms, so the first
     * real submission would have 400'd.
     */
    expect(screen.getByRole('radio', { name: 'English' })).toHaveAttribute('value', 'en');
    expect(screen.getByRole('radio', { name: 'हिन्दी' })).toHaveAttribute('value', 'hi');
    expect(screen.getByRole('group', { name: 'Subjects to begin with' })).toBeInTheDocument();
  });

  it('collects only parent linking details in the parent journey', () => {
    render(<OnboardingForm role="parent" />);

    expect(screen.getByLabelText('Child invitation code')).toBeRequired();
    expect(screen.queryByLabelText('Grade')).not.toBeInTheDocument();

    const form = screen.getByRole('button', { name: 'Save and continue' }).closest('form')!;
    fireEvent.submit(form);
    expect(screen.getByRole('status')).toHaveTextContent('not saved yet');
  });
});
