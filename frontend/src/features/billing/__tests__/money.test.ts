import { describe, expect, it } from 'vitest';
import { formatMoney, periodOf } from '../lib/money';

describe('a price somebody reads', () => {
  it('divides paise by a hundred, once, at the point of display', () => {
    expect(formatMoney(29_900, 'INR', 'en')).toBe('₹299');
  });

  /*
   * `en-IN` and `hi-IN` group as 2,99,000 rather than 299,000. The lakh
   * grouping is what this audience reads; a Western-grouped figure on a pricing
   * page reads as a foreign product.
   */
  it('groups the Indian way', () => {
    expect(formatMoney(29_90_000, 'INR', 'en')).toContain('29,900');
  });

  /* "₹299.00" reads as a system printing a database column. */
  it('shows no decimals on a whole amount, and both on a part one', () => {
    expect(formatMoney(29_900, 'INR', 'en')).not.toContain('.');
    expect(formatMoney(29_950, 'INR', 'en')).toContain('299.5');
  });

  it('follows the reader’s language', () => {
    expect(formatMoney(29_900, 'INR', 'hi')).toContain('299');
  });

  /*
   * The currency comes off the wire, and an unknown code makes `Intl` THROW a
   * RangeError. A pricing screen that crashes because the backend added a
   * currency is worse than one that prints the code beside the number.
   */
  it('survives a currency Intl does not know', () => {
    expect(formatMoney(29_900, 'NOT_A_CURRENCY', 'en')).toBe('NOT_A_CURRENCY 299');
  });

  it('renders a second real currency rather than assuming rupees', () => {
    expect(formatMoney(29_900, 'USD', 'en')).toContain('299');
    expect(formatMoney(29_900, 'USD', 'en')).not.toContain('₹');
  });
});

describe('the billing period', () => {
  /*
   * DERIVED FROM `periodDays`, not from the plan code. A switch on
   * `monthly`/`yearly` reads correctly right up to the first `term` plan, which
   * would then render with no period at all — the price of a year shown as if
   * it were the price of nothing.
   */
  it('reads a month and a year from the day count', () => {
    expect(periodOf(30)).toBe('month');
    expect(periodOf(365)).toBe('year');
  });

  it('tolerates the real calendar', () => {
    expect(periodOf(28)).toBe('month');
    expect(periodOf(31)).toBe('month');
    expect(periodOf(366)).toBe('year');
  });

  it('names the days for a period that is neither', () => {
    expect(periodOf(90)).toBe('days');
    expect(periodOf(7)).toBe('days');
  });
});
