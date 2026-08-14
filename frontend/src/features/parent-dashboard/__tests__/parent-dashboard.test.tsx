import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParentDashboard } from '../parent-dashboard';

/**
 * ===========================================================================
 * THE PARENT DASHBOARD, END TO END WITHOUT A NETWORK — build-order step 12.
 *
 * §10.4's row for this feature: "snapshot numbers render · the digest shows the
 * misconception and the action · the transcript is read-only · THE CHILD'S
 * VISIBILITY INDICATOR IS ALWAYS PRESENT". The last one is the reason several
 * of these tests exercise paths that render nothing else.
 * ===========================================================================
 */

const CHILD = '11111111-1111-4111-8111-111111111111';
const SIBLING = '22222222-2222-4222-8222-222222222222';

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const children = {
  children: [
    {
      linkId: '33333333-3333-4333-8333-333333333333',
      childUserId: CHILD,
      displayName: 'Aarav',
      grade: '7',
      approvedAt: '2026-08-01T09:00:00.000Z',
    },
  ],
};

const snapshot = {
  childUserId: CHILD,
  weekStart: '2026-08-10',
  headlines: [
    { key: 'days_practised', value: 4, label: { en: 'Days practised', hi: 'अभ्यास के दिन' } },
    { key: 'sessions', value: 6, label: { en: 'Sessions', hi: 'सत्र' } },
    { key: 'questions_answered', value: 38, label: { en: 'Questions', hi: 'सवाल' } },
    { key: 'chapters_touched', value: 3, label: { en: 'Chapters', hi: 'अध्याय' } },
  ],
  trend: 'more',
  summary: { en: 'Aarav practised on four days.', hi: 'आरव ने चार दिन अभ्यास किया।' },
  trendLine: { en: 'More than last week.', hi: 'पिछले सप्ताह से ज़्यादा।' },
};

const digest = {
  digest: {
    weekStart: '2026-08-10',
    summary: { en: 'Fractions are becoming steadier.', hi: 'भिन्न अब बेहतर हो रहे हैं।' },
    suggestedAction: {
      en: 'Ask Aarav to explain one fraction question out loud.',
      hi: 'आरव से एक भिन्न वाला सवाल ज़ोर से समझाने को कहें।',
    },
    misconceptionCode: null,
    sessionsCount: 6,
    questionsAnswered: 38,
    daysPractised: 4,
    generatedAt: '2026-08-16T03:30:00.000Z',
  },
};

const transcript = {
  childUserId: CHILD,
  source: 'foxy',
  sessions: [
    {
      sessionId: '44444444-4444-4444-8444-444444444444',
      mode: 'doubt',
      startedAt: '2026-08-12T09:00:00.000Z',
      lastMessageAt: '2026-08-12T09:05:00.000Z',
      messages: [
        {
          id: 'm1',
          role: 'student',
          text: 'What is a fraction?',
          createdAt: '2026-08-12T09:00:00.000Z',
        },
        {
          id: 'm2',
          role: 'foxy',
          text: 'A fraction is a part of a whole.',
          createdAt: '2026-08-12T09:00:20.000Z',
        },
      ],
    },
  ],
  visibility: {
    parentCanView: true,
    childIsTold: true,
    disclosure: {
      en: 'Aarav can see that you read these conversations.',
      hi: 'आरव देख सकता है कि आप ये बातचीत पढ़ते हैं।',
    },
  },
  readOnly: true,
};

const consent = {
  childUserId: CHILD,
  linkId: children.children[0].linkId,
  status: 'approved',
  approvedAt: '2026-08-01T09:00:00.000Z',
  canView: ['snapshot', 'digest', 'transcript'],
  childIsInformed: true,
  notice: {
    en: 'You can see Aarav’s weekly learning.',
    hi: 'आप आरव की साप्ताहिक पढ़ाई देख सकते हैं।',
  },
};

const fetchMock = vi.fn();

function route(
  handlers: {
    children?: () => Response;
    snapshot?: () => Response;
    digest?: () => Response;
    transcript?: () => Response;
    consent?: () => Response;
    revoke?: () => Response;
  } = {},
) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);

    if (target.includes('/consent/revoke')) {
      return Promise.resolve(
        (handlers.revoke ??
          (() =>
            json({
              childUserId: CHILD,
              linkId: children.children[0].linkId,
              status: 'revoked',
              revokedAt: '2026-08-16T09:00:00.000Z',
            })))(),
      );
    }
    if (target.includes('/consent')) {
      return Promise.resolve((handlers.consent ?? (() => json(consent)))());
    }
    if (target.includes('/snapshot')) {
      return Promise.resolve((handlers.snapshot ?? (() => json(snapshot)))());
    }
    if (target.includes('/digest')) {
      return Promise.resolve((handlers.digest ?? (() => json(digest)))());
    }
    if (target.includes('/transcript')) {
      return Promise.resolve((handlers.transcript ?? (() => json(transcript)))());
    }
    void init;
    return Promise.resolve((handlers.children ?? (() => json(children)))());
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the weekly snapshot', () => {
  it('renders the counts and the server’s own summary sentence', async () => {
    route();
    render(<ParentDashboard />);

    expect(await screen.findByText('Aarav practised on four days.')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('38')).toBeInTheDocument();
    expect(screen.getByText('Days practised')).toBeInTheDocument();
  });

  /*
   * There is no score on this response and there must never be one. §8.7: "60
   * percent in Science" is exactly what a parent cannot use.
   */
  it('shows no score and no percentage anywhere', async () => {
    route();
    const { container } = render(<ParentDashboard />);

    await screen.findByText('Aarav practised on four days.');
    expect(container.textContent).not.toContain('%');
  });

  it('carries the trend in words, not only as an arrow', async () => {
    route();
    render(<ParentDashboard />);

    expect(await screen.findByText('More practice than last week')).toBeInTheDocument();
  });

  /*
   * A first week has nothing to be a trend against, so no arrow is drawn at
   * all — an arrow would imply a comparison the data cannot support.
   */
  it('draws no trend in a first week', async () => {
    route({ snapshot: () => json({ ...snapshot, trend: 'first_week' }) });
    render(<ParentDashboard />);

    await screen.findByText('Days practised');
    expect(screen.queryByText('More practice than last week')).not.toBeInTheDocument();
  });
});

describe('the weekly digest', () => {
  it('shows the summary and the one suggested action', async () => {
    route();
    render(<ParentDashboard />);

    expect(await screen.findByText('Fractions are becoming steadier.')).toBeInTheDocument();
    expect(
      screen.getByText('Ask Aarav to explain one fraction question out loud.'),
    ).toBeInTheDocument();
  });

  /*
   * `misconceptionCode` is null for essentially every real week (D-077), and
   * the contract says a client must render the digest without it because that
   * is the NORMAL case. A heading with nothing under it, or "no misconception
   * detected", would report an absence every week — of content generation, not
   * of a misconception.
   */
  it('reads normally with no misconception, and says nothing about one', async () => {
    route();
    const { container } = render(<ParentDashboard />);

    await screen.findByText('Fractions are becoming steadier.');
    expect(container.textContent).not.toContain('Reference:');
  });

  it('names the misconception as a reference when there is one', async () => {
    route({
      digest: () => json({ digest: { ...digest.digest, misconceptionCode: 'FRAC_DENOM_ADD' } }),
    });
    render(<ParentDashboard />);

    expect(await screen.findByText('Reference: FRAC_DENOM_ADD')).toBeInTheDocument();
  });

  /* A GET never generates one, so an absent digest is the ordinary Tuesday. */
  it('says the summary is not written yet rather than reporting a failure', async () => {
    route({ digest: () => json({ digest: null }) });
    render(<ParentDashboard />);

    expect(await screen.findByText('This week’s summary is not written yet')).toBeInTheDocument();
  });
});

describe('the transcript', () => {
  it('renders the conversation and states that it is read only', async () => {
    route();
    render(<ParentDashboard />);

    expect(await screen.findByText('What is a fraction?')).toBeInTheDocument();
    expect(screen.getByText('A fraction is a part of a whole.')).toBeInTheDocument();
    expect(screen.getByText('Read only')).toBeInTheDocument();
    // No write path exists on the wire (`readOnly: z.literal(true)`), so the
    // screen must not imply one.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  /*
   * §10.4, and the most important assertion in this file. A parent reading a
   * child's conversations is separated from surveillance ONLY by the child
   * knowing.
   */
  it('always shows the visibility indicator, even with nothing to read', async () => {
    route({
      transcript: () => json({ ...transcript, sessions: [] }),
    });
    render(<ParentDashboard />);

    const notice = await screen.findByTestId('transcript-visibility');
    expect(notice).toHaveTextContent('Your child knows you can read these conversations.');
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
  });

  it('shows it even when the feature itself has not shipped', async () => {
    route({
      transcript: () => json({ ...transcript, source: 'not_yet_available', sessions: [] }),
    });
    render(<ParentDashboard />);

    expect(await screen.findByTestId('transcript-visibility')).toBeInTheDocument();
    /*
     * A DIFFERENT SENTENCE from "no conversations yet". Telling a parent their
     * child has asked nothing, when the truth is that nobody can see it yet, is
     * a false statement about their child.
     */
    expect(screen.getByText('Conversations are not available yet')).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
  });

  it('says so, in warning, when the child has not been told', async () => {
    route({
      transcript: () =>
        json({
          ...transcript,
          visibility: { ...transcript.visibility, childIsTold: false },
        }),
    });
    render(<ParentDashboard />);

    const notice = await screen.findByTestId('transcript-visibility');
    expect(notice).toHaveAttribute('data-child-told', 'false');
    expect(notice).toHaveTextContent('has not been told');
  });
});

describe('consent', () => {
  it('lists what the server grants, not a local guess', async () => {
    route({ consent: () => json({ ...consent, canView: ['snapshot'] }) });
    render(<ParentDashboard />);

    expect(await screen.findByText('The weekly snapshot')).toBeInTheDocument();
    expect(screen.queryByText('The weekly summary')).not.toBeInTheDocument();
  });

  /*
   * Irreversible from this screen — only the child can grant a new link — so it
   * gets the two-step, and the description says what WILL happen rather than
   * asking "are you sure?".
   */
  it('confirms before withdrawing access, and says what will happen', async () => {
    route();
    render(<ParentDashboard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw my access' }));

    expect(await screen.findByText('Withdraw your access?')).toBeInTheDocument();
    expect(screen.getByText(/Only your child can give access again/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw access' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/consent/revoke')),
      ).toBe(true);
    });
  });

  it('withdraws nothing when the parent backs out', async () => {
    route();
    render(<ParentDashboard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw my access' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep my access' }));

    await waitFor(() => {
      expect(screen.queryByText('Withdraw your access?')).not.toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/consent/revoke'))).toBe(
      false,
    );
  });
});

describe('which children are shown', () => {
  /*
   * A pending link is a request the CHILD has not answered. Offering it would
   * produce a dashboard whose every request 403s, and the parent would read
   * that as the app being broken rather than as their child not having replied.
   */
  it('does not offer a child who has not approved the link', async () => {
    route({
      children: () =>
        json({ children: [{ ...children.children[0], approvedAt: null }] }),
    });
    render(<ParentDashboard />);

    expect(await screen.findByText('Waiting for your child to approve')).toBeInTheDocument();
    expect(screen.queryByText('Days practised')).not.toBeInTheDocument();
  });

  it('tells a parent with no link at all how to get one', async () => {
    route({ children: () => json({ children: [] }) });
    render(<ParentDashboard />);

    expect(await screen.findByText('No child is linked yet')).toBeInTheDocument();
    expect(screen.getByText(/invitation code/)).toBeInTheDocument();
  });

  /* A "switch child" control above a single name is a control that does nothing. */
  it('offers no picker for a single child', async () => {
    route();
    render(<ParentDashboard />);

    await screen.findByText('Days practised');
    expect(screen.queryByRole('group', { name: 'Choose which child to view' })).not.toBeInTheDocument();
  });

  it('offers a picker once there are two', async () => {
    route({
      children: () =>
        json({
          children: [
            children.children[0],
            {
              linkId: '55555555-5555-4555-8555-555555555555',
              childUserId: SIBLING,
              displayName: 'Meera',
              grade: '9',
              approvedAt: '2026-08-02T09:00:00.000Z',
            },
          ],
        }),
    });
    render(<ParentDashboard />);

    const picker = await screen.findByRole('group', { name: 'Choose which child to view' });
    expect(picker).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Meera' })).toBeInTheDocument();
  });
});

describe('when a panel fails', () => {
  /*
   * Four endpoints, four independent failures. A parent whose transcript
   * request failed still reads the week's counts — and still reaches the
   * consent controls, which is the one part of this page they must always be
   * able to use.
   */
  it('keeps the rest of the page, including the consent controls', async () => {
    route({
      transcript: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
    });
    render(<ParentDashboard />);

    expect(await screen.findByText('Days practised')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw my access' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This section could not be loaded');
  });

  it('reads in Hindi throughout', async () => {
    route();
    render(<ParentDashboard />, { language: 'hi' });

    expect(await screen.findByText('आरव ने चार दिन अभ्यास किया।')).toBeInTheDocument();
    expect(screen.getByText('अभ्यास के दिन')).toBeInTheDocument();
    expect(screen.getByText('केवल पढ़ने के लिए')).toBeInTheDocument();
  });
});
