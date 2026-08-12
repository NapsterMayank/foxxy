import { screen } from '@testing-library/react';
import { renderServer } from '@test/setup/render';
import { createTranslator } from '@/lib/i18n/translate';
import { describe, expect, it, vi } from 'vitest';
import { ProgressSummary } from '@/features/progress/components/progress-summary';

/*
 * `getServerT` reaches for `next/headers`, which only exists inside a request.
 * The REAL dictionary is still used — only the cookie read is replaced — so
 * these tests assert the strings a user actually sees.
 */
vi.mock('@/lib/i18n/server', () => ({
  getServerT: () => Promise.resolve(createTranslator('en')),
  getServerLanguage: () => Promise.resolve('en'),
}));


describe('ProgressSummary', () => {
  it('describes progress as evidence without presenting a mastery percentage', async () => {
    await renderServer(
      ProgressSummary({
        items: [
          {
            subject: 'Mathematics',
            evidence: 'Strong evidence',
            detail: 'Consistent recent explanations.',
          },
        ],
        title: 'Learning progress',
      }),
    );

    expect(screen.getByRole('heading', { name: 'Learning progress' })).toBeInTheDocument();
    expect(screen.getByText('Strong evidence')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});
