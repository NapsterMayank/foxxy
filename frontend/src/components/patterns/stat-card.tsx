import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * A SINGLE NUMBER, WITH ITS MEANING ATTACHED — plan §4, used by the parent
 * home and the progress screen.
 *
 * `value` IS A STRING, NOT A NUMBER, and that is a product decision rather than
 * a typing convenience. §9.1: the client forbids showing mastery percentages,
 * and mastery is reported with the four-value evidence union instead. A numeric
 * prop invites `value={mastery * 100}`; a string makes the caller write what
 * the parent will actually read, and `EvidenceLabel` exists for the case this
 * component must not serve.
 *
 * ---------------------------------------------------------------------------
 * A TREND IS NEVER COLOUR ALONE.
 *
 * Every trend carries an arrow AND a `trendLabel` sentence. Colour-only status
 * fails for the ~8% of boys with a colour vision deficiency — a large slice of
 * the audience here — and for anyone on a monochrome display or a screen
 * reader. The arrow is `aria-hidden`; the sentence is what is announced.
 *
 * DOWN IS `warning`, NEVER `danger`. §9.1's rule about no harsh red for a wrong
 * answer is the same rule one level up: a child having a slower week is not an
 * emergency, and colouring it like one is what makes a parent dashboard feel
 * like a report card.
 * ===========================================================================
 */

export type StatTrend = 'up' | 'down' | 'flat';

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  readonly trend?: StatTrend;
  /** The trend in words. REQUIRED whenever `trend` is set — see the header. */
  readonly trendLabel?: string;
  readonly className?: string;
}

const trendMarks: Readonly<Record<StatTrend, string>> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

const trendTones = {
  up: 'success',
  down: 'warning',
  flat: 'neutral',
} as const;

export function StatCard({ className, label, trend, trendLabel, value }: StatCardProps) {
  const showTrend = trend !== undefined && trendLabel !== undefined;

  return (
    <Card className={cx('flex flex-col gap-2', className)}>
      {/*
        The LABEL is read before the value. A screen reader meeting "12" with no
        context has to hunt for what it counts.
      */}
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="text-3xl font-extrabold tracking-tight text-ink">{value}</p>
      {showTrend ? (
        <Badge className="self-start" srLabel={trendLabel} tone={trendTones[trend]}>
          {trendMarks[trend]}
        </Badge>
      ) : null}
    </Card>
  );
}
