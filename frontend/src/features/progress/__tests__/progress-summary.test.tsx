import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressSummary } from '@/features/progress/components/progress-summary';

describe('ProgressSummary', () => {
  it('describes progress as evidence without presenting a mastery percentage', () => {
    render(
      <ProgressSummary
        items={[{ subject: 'Mathematics', evidence: 'Strong evidence', detail: 'Consistent recent explanations.' }]}
        title="Learning progress"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Learning progress' })).toBeInTheDocument();
    expect(screen.getByText('Strong evidence')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});
