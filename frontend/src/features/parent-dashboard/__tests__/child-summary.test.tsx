import { screen } from '@testing-library/react';
import { renderServer } from '@test/setup/render';
import { createTranslator } from '@/lib/i18n/translate';
import { describe, expect, it, vi } from 'vitest';
import { ChildSummary } from '@/features/parent-dashboard/components/child-summary';

/*
 * `getServerT` reaches for `next/headers`, which only exists inside a request.
 * The REAL dictionary is still used — only the cookie read is replaced — so
 * these tests assert the strings a user actually sees.
 */
vi.mock('@/lib/i18n/server', () => ({
  getServerT: () => Promise.resolve(createTranslator('en')),
  getServerLanguage: () => Promise.resolve('en'),
}));


describe('ChildSummary', () => {
  it('presents activity, evidence and suggested focus from its view model', async () => {
    await renderServer(
      ChildSummary({
        child: {
          childName: 'Aarav',
          classLabel: 'Class 7',
          recentActivity: 'Practised fractions',
          latestEvidence: 'developing',
          latestEvidenceDetail: 'Recent answers are becoming more consistent.',
          focusArea: 'Reading main ideas',
        },
      }),
    );

    expect(screen.getByRole('heading', { name: 'Aarav' })).toBeInTheDocument();
    expect(screen.getByText('Practised fractions')).toBeInTheDocument();
    expect(screen.getByText('Developing')).toBeInTheDocument();
    expect(screen.getByText('Recent answers are becoming more consistent.')).toBeInTheDocument();
    expect(screen.getByText('Reading main ideas')).toBeInTheDocument();
  });
});
