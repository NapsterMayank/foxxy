/**
 * ===========================================================================
 * PAISE → A PRICE SOMEBODY READS.
 *
 * `amountMinorUnits` is an INTEGER NUMBER OF PAISE and stays one everywhere
 * except the moment it is displayed. Money in a float is how ₹299.00 becomes
 * ₹298.99999999999994, and the division happens here, once, on a value nothing
 * downstream stores.
 *
 * ---------------------------------------------------------------------------
 * `Intl.NumberFormat` WITH THE READER'S LANGUAGE, AND THE INDIAN GROUPING.
 *
 * `en-IN` and `hi-IN` both group as 2,99,000 rather than 299,000 — the lakh
 * grouping is what this audience reads, and a Western-grouped figure on a
 * pricing page reads as a foreign product. The currency comes from the SERVER
 * (`currency: 'INR'` on the plan), not from a constant here, so a second
 * currency ever added is rendered rather than silently mislabelled as rupees.
 *
 * ---------------------------------------------------------------------------
 * NO DECIMALS ON A WHOLE AMOUNT. Every plan today is a whole number of rupees,
 * and "₹299" is what a price looks like; "₹299.00" reads as a system printing a
 * database column. A plan with paise in it still shows them.
 * ===========================================================================
 */
export function formatMoney(
  amountMinorUnits: number,
  currency: string,
  language: string,
): string {
  const major = amountMinorUnits / 100;
  const whole = Number.isInteger(major);

  try {
    return new Intl.NumberFormat(language === 'hi' ? 'hi-IN' : 'en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    /*
     * An unknown currency code makes `Intl` THROW — a RangeError, from a value
     * that came off the wire. A pricing screen that crashes because the backend
     * added a currency is worse than one that prints "SGD 299", so the code is
     * shown beside the number and the page survives.
     */
    return `${currency} ${String(major)}`;
  }
}

/**
 * "per month" / "per year", from the plan's own period.
 *
 * DERIVED FROM `periodDays` rather than from the plan CODE. The codes today are
 * `monthly` and `yearly` and a switch on them would read correctly right up to
 * the first `term` or `winter_offer` plan, which would then render with no
 * period at all — the price of a year shown as if it were the price of nothing.
 */
export type BillingPeriod = 'month' | 'year' | 'days';

export function periodOf(periodDays: number): BillingPeriod {
  if (periodDays >= 28 && periodDays <= 31) return 'month';
  if (periodDays >= 360 && periodDays <= 366) return 'year';
  return 'days';
}
