import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingForm } from '@/features/onboarding/onboarding-form';

afterEach(cleanup);

describe('onboarding presentation', () => {
  it('shows learning preferences for students', () => {
    render(<OnboardingForm role="student" />);

    expect(screen.getByLabelText('Grade')).toBeRequired();
    expect(screen.getByRole('option', { name: 'Grade 10' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Grade 11' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Preferred language' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Subjects to begin with' })).toBeInTheDocument();
  });

  it('collects only parent linking details in the parent journey', () => {
    render(<OnboardingForm role="parent" />);

    expect(screen.getByLabelText('Child invitation code')).toBeRequired();
    expect(screen.queryByLabelText('Grade')).not.toBeInTheDocument();

    const form = screen.getByRole('button', { name: 'Continue' }).closest('form')!;
    fireEvent.submit(form);
    expect(screen.getByRole('status')).toHaveTextContent('backend integration');
  });
});
