import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LearningEvidence } from '@/types/learning-evidence';
import { ConfirmDialog } from '../confirm-dialog';
import { EvidenceLabel } from '../evidence-label';
import { FormField } from '../form-field';
import { OfflineBanner } from '../offline-banner';
import { PageHeader } from '../page-header';
import { StatCard } from '../stat-card';
import { EmptyState, ErrorState, LoadingState } from '../states';

/**
 * THE TIER-2 PATTERNS — plan §4, "build these on day one, before any screen".
 *
 * Every assertion here is about a property a screen would otherwise have to
 * remember: the busy region a screen reader needs, the error that announces
 * itself, the retry that is absent when retrying cannot help, the confirm
 * button that cannot be pressed twice.
 */

describe('LoadingState', () => {
  it('announces itself once, and the skeletons stay silent', () => {
    render(<LoadingState label="Loading your progress" rows={3} />);

    const region = screen.getByText('Loading your progress').parentElement;
    expect(region).toHaveAttribute('aria-busy', 'true');
    // One announcement for the block, not one per grey box.
    expect(region?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
  });

  it('draws as many rows as the caller expects content', () => {
    const { container } = render(<LoadingState label="Loading" rows={5} />);
    expect(container.querySelectorAll('[data-shape]')).toHaveLength(5);
  });
});

describe('EmptyState', () => {
  it('renders its message and its action', () => {
    render(
      <EmptyState
        action={<Button>Start practising</Button>}
        description="Practice a chapter to see progress here."
        title="Nothing yet"
      />,
    );

    expect(screen.getByText('Nothing yet')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start practising' })).toBeVisible();
  });

  it('does not introduce a heading that breaks the page outline', () => {
    // An empty state can appear inside a section that already has one.
    render(<EmptyState description="d" title="t" />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('hides a decorative icon from assistive technology', () => {
    const { container } = render(<EmptyState description="d" icon={<svg />} title="t" />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('ErrorState', () => {
  it('announces itself, because nothing else signals the region changed', () => {
    render(<ErrorState description="d" retryLabel="Try again" title="Could not load" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
  });

  it('offers retry and calls back', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState description="d" onRetry={onRetry} retryLabel="Try again" title="t" />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders NO button when retrying cannot help', () => {
    /*
     * A 403 will not become a 200. A button that does nothing makes a dead end
     * look recoverable, and the user presses it repeatedly.
     */
    render(<ErrorState description="d" retryLabel="Try again" title="t" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('PageHeader', () => {
  it('renders the page h1 and its subtitle', () => {
    render(<PageHeader subtitle="Class 8 · Science" title="Your progress" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Your progress' })).toBeVisible();
    expect(screen.getByText('Class 8 · Science')).toBeVisible();
  });

  it('puts the title before the actions in reading order', () => {
    // Reading order follows the DOM: a keyboard user meets the page title
    // before the buttons that act on it.
    render(<PageHeader actions={<Button>Export</Button>} title="Your progress" />);

    const heading = screen.getByRole('heading', { level: 1 });
    const action = screen.getByRole('button', { name: 'Export' });
    expect(heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('StatCard', () => {
  it('reads the label before the value', () => {
    const { container } = render(<StatCard label="Sessions this week" value="12" />);
    expect(container.textContent?.indexOf('Sessions this week')).toBeLessThan(
      container.textContent?.indexOf('12') ?? -1,
    );
  });

  it('never conveys a trend by colour alone', () => {
    // Colour-only status fails for a colour vision deficiency, a monochrome
    // display and every screen reader.
    render(<StatCard label="Practice" trend="down" trendLabel="Down from last week" value="3" />);

    expect(screen.getByText('Down from last week')).toHaveClass('sr-only');
    expect(screen.getByText('↓')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows a downward trend as a warning, never as a danger', () => {
    /*
     * A child having a slower week is not an emergency. Colouring it like one
     * is what makes a parent dashboard feel like a report card.
     */
    render(<StatCard label="Practice" trend="down" trendLabel="Down" value="3" />);
    expect(screen.getByText('↓').closest('[data-tone]')).toHaveAttribute('data-tone', 'warning');
  });

  it('renders no trend badge when the caller gave no words for it', () => {
    render(<StatCard label="Practice" trend="up" value="9" />);
    expect(screen.queryByText('↑')).toBeNull();
  });
});

describe('EvidenceLabel', () => {
  it.each([
    ['Strong evidence', 'success'],
    ['Developing', 'brand'],
    ['Needs another session', 'info'],
    ['Not assessed yet', 'neutral'],
  ] as const)('renders %s with the %s tone', (evidence, tone) => {
    render(<EvidenceLabel evidence={evidence as LearningEvidence} />);
    expect(screen.getByText(evidence)).toHaveAttribute('data-tone', tone);
  });

  it('never renders "needs another session" as a failure', () => {
    // §9.1: no harsh red. Red says "you failed"; the sentence says "do this
    // again", which is the actual meaning.
    render(<EvidenceLabel evidence="Needs another session" />);
    expect(screen.getByText('Needs another session')).not.toHaveAttribute('data-tone', 'danger');
  });
});

describe('FormField', () => {
  it('associates the label with the control it wraps', () => {
    render(
      <FormField label="Email address">
        <Input />
      </FormField>,
    );
    expect(screen.getByLabelText('Email address')).toBeVisible();
  });

  it('describes the control with its hint', () => {
    render(
      <FormField hint="We never share this." label="Email address">
        <Input />
      </FormField>,
    );

    const control = screen.getByLabelText('Email address');
    const hintId = screen.getByText('We never share this.').id;
    expect(control.getAttribute('aria-describedby')).toContain(hintId);
  });

  it('announces an error and marks the control invalid', () => {
    render(
      <FormField error="Enter a valid email address." label="Email address">
        <Input />
      </FormField>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
    expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true');
  });

  it('lists the error BEFORE the hint, because it matters more', () => {
    // A screen reader reads `aria-describedby` in the order listed.
    render(
      <FormField error="Too short." hint="At least 8 characters." label="Password">
        <Input type="password" />
      </FormField>,
    );

    const described = screen.getByLabelText('Password').getAttribute('aria-describedby') ?? '';
    const errorId = screen.getByText('Too short.').id;
    const hintId = screen.getByText('At least 8 characters.').id;
    expect(described.indexOf(errorId)).toBeLessThan(described.indexOf(hintId));
  });

  it('marks a required field for both audiences', () => {
    render(
      <FormField label="Full name" required>
        <Input />
      </FormField>,
    );

    /*
     * A regex, not an exact string: the label element also contains the
     * required marker. A real screen reader skips it — the marker is
     * `aria-hidden`, and hidden content is excluded from the accessible name —
     * but Testing Library matches raw text content, so an exact query would
     * fail for a reason no user experiences.
     */
    expect(screen.getByLabelText(/Full name/)).toBeRequired();
    // The asterisk is decoration; "required" is carried by the control.
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });

  it('describes nothing when there is nothing to say', () => {
    render(
      <FormField label="Full name">
        <Input />
      </FormField>,
    );
    expect(screen.getByLabelText('Full name')).not.toHaveAttribute('aria-describedby');
  });
});

describe('ConfirmDialog', () => {
  function renderConfirm(onConfirm: () => void | Promise<void>) {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        cancelLabel="Keep access"
        confirmLabel="Revoke access"
        description="Your child's progress will no longer be visible to you."
        onCancel={onCancel}
        onConfirm={onConfirm}
        open
        title="Revoke access?"
      />,
    );
    return { onCancel };
  }

  it('focuses CANCEL first, so Enter on an unread dialog does the harmless thing', () => {
    renderConfirm(vi.fn());
    expect(screen.getByRole('button', { name: 'Keep access' })).toHaveFocus();
  });

  it('confirms once and reports back', async () => {
    const onConfirm = vi.fn();
    renderConfirm(onConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cannot be double-pressed while the action is in flight', async () => {
    /*
     * A revoke that takes a second on a slow connection gets pressed twice, and
     * the second press hits an API that already succeeded — which returns 404
     * or 409 and renders as "it did not work" for an action that did.
     */
    let settle: () => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    renderConfirm(onConfirm);

    const confirm = screen.getByRole('button', { name: 'Revoke access' });
    await userEvent.click(confirm);
    expect(confirm).toBeDisabled();

    settle();
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('re-enables itself after a failure rather than becoming a dead end', async () => {
    /*
     * A rejected `onConfirm` used to ESCAPE the component: nothing awaits the
     * click handler, so it became an unhandled promise rejection — a console
     * error in the user's browser and noise in whatever collects them, while
     * the person saw the dialog re-enable with no explanation. The suite caught
     * it by refusing to pass with an unhandled rejection in the run.
     */
    const failure = new Error('network');
    const onConfirm = vi.fn(() => Promise.reject(failure));
    const onError = vi.fn();
    render(
      <ConfirmDialog
        cancelLabel="Keep access"
        confirmLabel="Revoke access"
        description="d"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        onError={onError}
        open
        title="Revoke access?"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Revoke access' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke access' })).toBeEnabled();
    });
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('swallows a failure when the caller has its own error surface', async () => {
    // The intended integration is a TanStack mutation, whose error state
    // already renders the message. Rethrowing would report it twice.
    const onConfirm = vi.fn(() => Promise.reject(new Error('network')));
    renderConfirm(onConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'Revoke access' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke access' })).toBeEnabled();
    });
  });

  it('cancels on Escape', async () => {
    const { onCancel } = renderConfirm(vi.fn());
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('OfflineBanner', () => {
  function setOnline(value: boolean): void {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
  }

  it('renders nothing while online', () => {
    setOnline(true);
    render(<OfflineBanner message="You are offline." />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('appears when the connection drops, and goes when it returns', async () => {
    setOnline(true);
    render(<OfflineBanner message="You are offline." />);

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('You are offline.');
    });

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('starts optimistic, so the server and client agree on the first render', () => {
    /*
     * Reading `navigator.onLine` during render is a hydration mismatch — it does
     * not exist on the server — and React resolves a mismatch by throwing the
     * tree away. One frame of optimism beats a hydration error on every load.
     */
    setOnline(false);
    render(<OfflineBanner message="You are offline." />);
    // The effect corrects it immediately after mount.
    expect(screen.getByRole('status')).toBeVisible();
  });
});
