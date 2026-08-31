'use client';

import { useState } from 'react';
import { Failure, useAdminData } from '@/components/screen';
import { adminSubscriptionsResponseSchema } from '@/lib/api/generated/contracts/admin.contract';
import { adminPaths } from '@/lib/api/paths';

/**
 * =============================================================================
 * BILLING — subscriptions, in the units the ledger actually keeps them.
 *
 * THE ONE THING THIS SCREEN MUST NOT GET WRONG IS THE AMOUNT.
 *
 * `amountMinorUnits` is minor units — paise for INR, cents for USD — because an
 * integer is the only representation of money that adds up without a rounding
 * argument. Rendering that integer as rupees would overstate every figure on
 * the page by 100x, and it would look entirely plausible while doing it:
 * "29900 INR" is a number a yearly plan could cost. Nobody would query it.
 *
 * So the division happens in exactly one place, below, and the currency CODE is
 * printed next to every figure rather than a symbol — partly because the panel
 * may hold more than one currency, and partly because the divisor is a property
 * of the currency, so naming it is what makes the number checkable.
 * =============================================================================
 */

/*
 * Grouped digits, pinned to en-US rather than the operator's locale.
 *
 * Not a style choice: en-IN groups as 1,23,456 and en-US as 123,456, and a
 * panel that renders one or the other depending on who opened it is a panel
 * where two people reading the same row disagree about the number.
 */
const MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Minor units to major units.
 *
 * The /100 is correct for INR and every other two-decimal currency, which is
 * all this product bills in today. It is NOT universal — JPY has no minor unit
 * — so the code travels with the number, and if a zero-decimal currency ever
 * appears here this function is the one thing that has to change.
 */
function amount(minorUnits: number, currency: string): string {
  return `${MONEY.format(minorUnits / 100)} ${currency}`;
}

/**
 * Colour carries the states an operator is looking for, and nothing else.
 *
 * `past_due` is the actionable one — a payment that failed and a subscription
 * still live — so it is `.warn`. `cancelled` and `expired` are settled history:
 * `.muted`, because dimming them is what stops them competing for attention
 * with the rows that need it. `active` and `pending` are left at body colour;
 * colouring every row would make colour mean nothing.
 */
function statusClass(status: string): string {
  if (status === 'past_due') return 'warn';
  if (status === 'cancelled' || status === 'expired') return 'muted';
  return '';
}

/** A nullable timestamp. `—` reads as "not set"; a blank cell reads as a bug. */
function stamp(value: string | null): React.ReactNode {
  if (value === null) return <span className="muted">—</span>;
  // Trim the milliseconds only. The rest stays ISO so the column sorts by eye
  // and pastes into a query unchanged.
  return value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export default function BillingPage() {
  /*
   * PAGING IS A TRAIL, NOT A PAGE NUMBER.
   *
   * The cursor is keyset and opaque: it points at the last row of the page that
   * produced it and only goes forward. There is no "cursor for the previous
   * page" to ask for, so going back means re-requesting the cursor that opened
   * the page before — which is what this stack holds. Empty stack is page one.
   */
  const [trail, setTrail] = useState<readonly string[]>([]);
  const cursor = trail.at(-1);
  const path =
    cursor === undefined
      ? adminPaths.subscriptions
      : `${adminPaths.subscriptions}?cursor=${encodeURIComponent(cursor)}`;

  const { data, error, loading } = useAdminData(path, adminSubscriptionsResponseSchema);

  const advance = (): void => {
    const next = data?.nextCursor;
    if (next === undefined || next === null) return;
    setTrail((pages) => [...pages, next]);
  };
  const back = (): void => { setTrail((pages) => pages.slice(0, -1)); };

  return (
    <>
      <h2>Billing</h2>
      <p className="sub">
        Subscriptions as the billing tables hold them. Amounts are stored in minor
        units and shown here divided into major units, with the currency code.
      </p>

      {loading ? <p className="muted">Loading subscriptions…</p> : null}
      {error === null ? null : <Failure error={error} />}

      {/*
        The table renders only on a clean load. `useAdminData` keeps the last
        good page in `data` when a request fails, and rendering those rows under
        a failed refresh would present stale money as current money.
      */}
      {!loading && error === null && data !== null ? (
        <>
          {data.items.length === 0 ? (
            <p className="muted">No subscriptions on this page.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Subject user</th>
                  <th>Payer</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th className="num">Amount</th>
                  <th>Period end</th>
                  <th>Cancelled</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id}>
                    {/* Ids are shown whole. Truncating them would defeat the one
                        thing an operator does with an id: copy it into a query. */}
                    <td>{row.id}</td>
                    <td>{row.subjectUserId}</td>
                    <td>{row.payerKind}</td>
                    <td>{row.planCode}</td>
                    <td className={statusClass(row.status)}>{row.status}</td>
                    <td>{row.provider}</td>
                    <td className="num">{amount(row.amountMinorUnits, row.currency)}</td>
                    <td>{stamp(row.currentPeriodEnd)}</td>
                    <td>{stamp(row.cancelledAt)}</td>
                    <td>{stamp(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" onClick={back} disabled={trail.length === 0}>
              Previous
            </button>
            <button type="button" onClick={advance} disabled={data.nextCursor === null}>
              Next
            </button>
            <span className="muted">
              Page {trail.length + 1}
              {data.nextCursor === null ? ' — last page' : ''}
            </span>
          </div>
        </>
      ) : null}
    </>
  );
}
