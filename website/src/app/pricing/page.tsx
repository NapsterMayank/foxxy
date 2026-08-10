import type { Metadata } from 'next';
import { FinalCta, SectionHeading } from '@/components/marketing-blocks';
import { pricingPlans } from '@/content/site';

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.alfanumrik.com';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple Alfanumrik plans for learners, families and schools. Choose monthly, yearly or a custom school plan.',
  alternates: { canonical: '/pricing' },
};

export default function PricingPage() {
  return (
    <>
      <main>
        <section className="page-hero page-hero--center"><div className="shell"><SectionHeading eyebrow="Pricing" title="Simple pricing for every learner" text="Choose the plan that fits. Cancel anytime." /></div></section>
        <section className="section section--no-top">
          <div className="shell pricing-grid">
            {pricingPlans.map((plan) => (
              <article className={plan.featured ? 'pricing-card pricing-card--featured' : 'pricing-card'} key={plan.name}>
                {plan.featured ? <span className="pricing-card__badge">Most popular</span> : null}
                <h2>{plan.name}</h2><p>{plan.description}</p>
                <div className="price"><strong>{plan.price}</strong><span>{plan.suffix}</span></div>
                <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
                <a className={plan.featured ? 'button button--primary' : 'button button--quiet'} href={plan.name === 'School or bulk' ? 'mailto:schools@alfanumrik.com' : `${appUrl}/signup`}>{plan.action}</a>
              </article>
            ))}
          </div>
          <p className="pricing-note">All learner plans include access on web and mobile web. Secure payments. No hidden charges.</p>
        </section>
      </main>
      <FinalCta title="Ready to make every study session count?" />
    </>
  );
}
