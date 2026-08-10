import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChildSummary } from '@/features/parent-dashboard/components/child-summary';

describe('ChildSummary', () => {
  it('presents activity, evidence and suggested focus from its view model', () => {
    render(
      <ChildSummary
        child={{
          childName: 'Aarav',
          classLabel: 'Class 7',
          recentActivity: 'Practised fractions',
          latestEvidence: 'Developing',
          latestEvidenceDetail: 'Recent answers are becoming more consistent.',
          focusArea: 'Reading main ideas',
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Aarav' })).toBeInTheDocument();
    expect(screen.getByText('Practised fractions')).toBeInTheDocument();
    expect(screen.getByText('Developing')).toBeInTheDocument();
    expect(screen.getByText('Recent answers are becoming more consistent.')).toBeInTheDocument();
    expect(screen.getByText('Reading main ideas')).toBeInTheDocument();
  });
});
