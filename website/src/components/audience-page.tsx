import type { Metadata } from 'next';
import { DashboardArt } from './brand-art';
import { CheckList, FinalCta } from './marketing-blocks';
import { audiencePages } from '@/content/site';

type Audience = keyof typeof audiencePages;

export function audienceMetadata(audience: Audience): Metadata {
  const page = audiencePages[audience];
  return { title: page.eyebrow, description: page.intro, alternates: { canonical: audience === 'parents' ? '/for-parents' : '/for-schools' } };
}

export function AudiencePage({ audience }: { audience: Audience }) {
  const page = audiencePages[audience];
  return (
    <>
      <main>
        <section className="page-hero">
          <div className="shell split-layout">
            <div className="page-hero__copy">
              <span className="eyebrow">{page.eyebrow}</span>
              <h1>{page.title}</h1>
              <p>{page.intro}</p>
              <CheckList items={page.points} />
              <a className="button button--primary button--large" href={audience === 'schools' ? 'mailto:schools@alfanumrik.com' : `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.alfanumrik.com'}/signup`}>{audience === 'schools' ? 'Talk to our school team' : 'Explore for parents'}</a>
            </div>
            <DashboardArt variant={audience === 'schools' ? 'school' : 'parent'} />
          </div>
        </section>
        <section className="section">
          <div className="shell three-up">
            {page.cards.map(([title, description], index) => (
              <article className="value-card" key={title}>
                <span className="value-card__number">0{index + 1}</span>
                <h2>{title}</h2><p>{description}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
      <FinalCta title={audience === 'schools' ? 'Bring focused learning support to your school.' : 'Support their progress without taking over.'} />
    </>
  );
}
