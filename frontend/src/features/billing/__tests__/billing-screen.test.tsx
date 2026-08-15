import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingScreen } from '../billing-screen';

/**
 * ===========================================================================
 * THE BILLING SCREEN, END TO END WITHOUT A NETWORK — build-order step 13.
 *
 * §10.4 asks only that "subscribe and status" work. The assertions that matter
 * beyond that are about MONEY: that the price rendered is the one the server
 * quoted, that a school-paid seat is never shown a price at all, and that a
 * refused checkout says nothing was charged.
 * ===========================================================================
 */

const SUBSCRIPTION_ID = '11111111-1111-4111-8111-111111111111';

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const plans = {
  plans: [
    {
      code: 'monthly',
      amountMinorUnits: 29_900,
      currency: 'INR',
      periodDays: 30,
      features: ['practice.basic', 'foxy.basic', 'foxy.unlimited'],
    },
    {
      code: 'yearly',
      amountMinorUnits: 2_99_000,
      currency: 'INR',
      periodDays: 365,
      features: ['practice.basic', 'foxy.basic', 'foxy.unlimited', 'parent.digest'],
    },
  ],
};

const freeStatus = {
  subscription: null,
  entitlements: {
    planCode: 'free',
    isPaid: false,
    features: ['practice.basic', 'foxy.basic'],
    activeUntil: null,
  },
};

const paidStatus = {
  subscription: {
    id: SUBSCRIPTION_ID,
    planCode: 'monthly',
    status: 'active',
    payer: { kind: 'user' },
    currentPeriodEnd: '2026-09-14T09:00:00.000Z',
    cancelledAt: null,
  },
  entitlements: {
    planCode: 'monthly',
    isPaid: true,
    features: ['practice.basic', 'foxy.basic', 'foxy.unlimited'],
    activeUntil: '2026-09-14T09:00:00.000Z',
  },
};

const fetchMock = vi.fn();
const assign = vi.fn();

function route(
  handlers: {
    plans?: () => Response;
    status?: () => Response;
    subscribe?: () => Response;
    cancel?: () => Response;
  } = {},
) {
  fetchMock.mockImplementation((url: string) => {
    const target = String(url);
    if (target.includes('/billing/plans')) {
      return Promise.resolve((handlers.plans ?? (() => json(plans)))());
    }
    if (target.includes('/billing/subscribe')) {
      return Promise.resolve(
        (handlers.subscribe ??
          (() =>
            json(
              {
                subscriptionId: SUBSCRIPTION_ID,
                status: 'pending',
                planCode: 'monthly',
                checkoutUrl: 'https://rzp.io/i/abc123',
                payer: { kind: 'user' },
              },
              201,
            )))(),
      );
    }
    if (target.includes('/billing/cancel')) {
      return Promise.resolve(
        (handlers.cancel ??
          (() =>
            json({
              subscriptionId: SUBSCRIPTION_ID,
              status: 'cancelled',
              accessUntil: '2026-09-14T09:00:00.000Z',
            })))(),
      );
    }
    return Promise.resolve((handlers.status ?? (() => json(freeStatus)))());
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // `window.location` is not writable in jsdom; only the method is needed.
  vi.stubGlobal('location', { ...window.location, assign });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('what the account has', () => {
  it('names the free plan without inventing an expiry', async () => {
    route();
    const { container } = render(<BillingScreen />);

    expect(await screen.findByText('Free plan')).toBeInTheDocument();
    // `activeUntil` is null on the free tier, which never lapses. Rendering
    // "expires: —" would suggest something is missing when nothing is.
    expect(container.textContent).not.toContain('Renews on');
  });

  it('shows a paid plan, its status and when it renews', async () => {
    route({ status: () => json(paidStatus) });
    render(<BillingScreen />);

    expect(await screen.findByText('Paid plan')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Renews on 14 September.')).toBeInTheDocument();
  });

  /*
   * A subscription is created in `pending` and GRANTS NOTHING until the
   * provider confirms payment. Saying "subscribed" here would tell somebody
   * they had bought something before any money moved.
   */
  it('says a pending subscription is waiting for payment, not that it is active', async () => {
    route({
      status: () =>
        json({
          subscription: { ...paidStatus.subscription, status: 'pending' },
          entitlements: { ...freeStatus.entitlements },
        }),
    });
    render(<BillingScreen />);

    expect(await screen.findByText('Waiting for payment')).toBeInTheDocument();
    expect(screen.getByText('Free plan')).toBeInTheDocument();
  });
});

describe('the catalogue', () => {
  it('renders the price the server quoted, in rupees', async () => {
    route();
    render(<BillingScreen />);

    expect(await screen.findByText('₹299')).toBeInTheDocument();
    expect(screen.getByText('per month')).toBeInTheDocument();
    // 299,000 paise. The rupee figure, not the minor units — the division
    // happens once, here, and nothing stores the result.
    expect(screen.getByText('₹2,990')).toBeInTheDocument();
    expect(screen.getByText('per year')).toBeInTheDocument();
  });

  it('says what each plan grants, from the served feature list', async () => {
    route();
    render(<BillingScreen />);

    expect(await screen.findByText('Weekly summary for a parent')).toBeInTheDocument();
    expect(screen.getAllByText('Unlimited questions for Foxy')).toHaveLength(2);
  });

  /*
   * THIS TEST FOUND A REAL DEFECT. `planSummarySchema.features` is a closed
   * enum, so validating the catalogue against it made ONE unknown feature
   * reject the WHOLE response — the pricing page rendered "plans could not be
   * loaded" because the backend had added an entitlement. The feature list is
   * now read as strings and the unknown one is dropped; everything that decides
   * money stays strict.
   */
  it('survives a feature this build has never heard of, and drops it', async () => {
    route({
      plans: () =>
        json({
          plans: [{ ...plans.plans[0], features: ['practice.basic', 'school.reporting'] }],
        }),
    });
    const { container } = render(<BillingScreen />);

    expect(await screen.findByText('Daily practice')).toBeInTheDocument();
    expect(container.textContent).not.toContain('school.reporting');
  });

  /*
   * The backend refuses a second live subscription with a 409, so a live button
   * on the current plan would be a button whose only outcome is an error the
   * customer cannot act on.
   */
  it('offers nothing to press on the plan already held', async () => {
    route({ status: () => json(paidStatus) });
    render(<BillingScreen />);

    await screen.findByText('₹299');
    const monthly = document.querySelector('[data-plan="monthly"]');
    expect(monthly?.textContent).toContain('This is the plan you are on.');
    expect(monthly?.querySelector('button')).toBeNull();
    // The other plan is still buyable.
    expect(
      document.querySelector('[data-plan="yearly"]')?.querySelector('button'),
    ).not.toBeNull();
  });

  /*
   * The current plan still renders when the catalogue fails: "what am I paying
   * for" is answerable without knowing what else is for sale.
   */
  it('keeps the current plan when the catalogue fails', async () => {
    route({ plans: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<BillingScreen />);

    expect(await screen.findByText('Free plan')).toBeInTheDocument();
    expect(screen.getByText('Plans could not be loaded')).toBeInTheDocument();
  });
});

describe('starting a checkout', () => {
  it('sends the plan code and nothing else, then follows the payment page', async () => {
    route();
    render(<BillingScreen />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Choose this plan' }))[0]);

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://rzp.io/i/abc123');
    });

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/billing/subscribe'));
    // NO `payer`, NO subject. A client choosing who to charge is a client
    // choosing whose card to use.
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ planCode: 'monthly' });
  });

  /*
   * `checkoutUrl` is a plain `z.string()` on the contract, so the schema has not
   * established that it is safe to navigate to.
   */
  it('refuses a checkout URL that is not http, and says nothing was charged', async () => {
    route({
      subscribe: () =>
        json(
          {
            subscriptionId: SUBSCRIPTION_ID,
            status: 'pending',
            planCode: 'monthly',
            checkoutUrl: 'javascript:alert(1)',
            payer: { kind: 'user' },
          },
          201,
        ),
    });
    render(<BillingScreen />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Choose this plan' }))[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing has been charged.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('tells a customer who already has a plan that they already have it', async () => {
    route({ subscribe: () => json({ error: { code: 'CONFLICT', message: 'x' } }, 409) });
    render(<BillingScreen />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Choose this plan' }))[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You already have an active plan.');
    // Never "try again": the thing they would try again is a payment.
    expect(alert).not.toHaveTextContent('Try again');
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('a school-paid seat', () => {
  const schoolStatus = {
    subscription: { ...paidStatus.subscription, payer: { kind: 'school' } },
    entitlements: paidStatus.entitlements,
  };

  /*
   * The contract carries `payer.kind` for exactly this: such a student "must
   * not be shown 'you will be charged ₹299'". A catalogue below their status is
   * that sentence in a different font.
   */
  it('is shown no prices at all', async () => {
    route({ status: () => json(schoolStatus) });
    const { container } = render(<BillingScreen />);

    expect(await screen.findByText(/Your school pays for this account/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('₹');
    expect(screen.queryByText('Plans')).not.toBeInTheDocument();
  });

  it('is offered no cancel button, because that contract is not theirs to end', async () => {
    route({ status: () => json(schoolStatus) });
    render(<BillingScreen />);

    await screen.findByText('Paid plan');
    expect(screen.queryByRole('button', { name: 'Cancel my plan' })).not.toBeInTheDocument();
  });
});

describe('cancelling', () => {
  it('confirms first, and says access continues to the end of the period', async () => {
    route({ status: () => json(paidStatus) });
    render(<BillingScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel my plan' }));

    expect(await screen.findByText('Cancel your plan?')).toBeInTheDocument();
    expect(screen.getByText(/You keep everything you have now until 14 September/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel the plan' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/billing/cancel'))).toBe(
        true,
      );
    });
  });

  it('cancels nothing when the customer backs out', async () => {
    route({ status: () => json(paidStatus) });
    render(<BillingScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel my plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep my plan' }));

    await waitFor(() => {
      expect(screen.queryByText('Cancel your plan?')).not.toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/billing/cancel'))).toBe(
      false,
    );
  });

  /* Already cancelled: nothing more to end, and the date is what matters. */
  it('offers no cancel on a plan that is already cancelled', async () => {
    route({
      status: () =>
        json({
          subscription: { ...paidStatus.subscription, cancelledAt: '2026-08-16T09:00:00.000Z' },
          entitlements: paidStatus.entitlements,
        }),
    });
    render(<BillingScreen />);

    expect(await screen.findByText('This plan will not renew.')).toBeInTheDocument();
    expect(screen.getByText('You keep access until 14 September.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel my plan' })).not.toBeInTheDocument();
  });
});

describe('when the status itself fails', () => {
  /*
   * A customer who cannot see what they already have must not be shown a row of
   * buy buttons — they would buy a plan they are on, and the 409 would be the
   * first they heard of it.
   */
  it('shows no plans, because buying blind is how somebody buys twice', async () => {
    route({ status: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<BillingScreen />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your plan could not be loaded');
    expect(screen.queryByRole('button', { name: 'Choose this plan' })).not.toBeInTheDocument();
  });

  it('reads in Hindi', async () => {
    route({ status: () => json(paidStatus) });
    render(<BillingScreen />, { language: 'hi' });

    expect(await screen.findByText('सशुल्क योजना')).toBeInTheDocument();
    expect(screen.getByText('चालू')).toBeInTheDocument();
  });
});
