import type { Metadata } from 'next';
import { FoxyArt } from '@/components/brand-art';
import { FinalCta, Highlights, SectionHeading } from '@/components/marketing-blocks';
import { values } from '@/content/site';

export const metadata: Metadata = {
  title: 'About us',
  description: 'Alfanumrik is building accessible, engaging and effective learning support for every CBSE learner in India.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <>
      <main>
        <section className="page-hero">
          <div className="shell split-layout">
            <div className="page-hero__copy"><span className="eyebrow eyebrow--plum">About us</span><h1>Built with a mission to transform education in India.</h1><p>We believe excellent learning support should be clear, encouraging and accessible—wherever a learner begins.</p></div>
            <FoxyArt compact />
          </div>
          <div className="shell"><Highlights /></div>
        </section>
        <section className="section">
          <div className="shell"><SectionHeading eyebrow="What guides us" title="Technology with a human point of view" /></div>
          <div className="shell three-up">
            {values.map(([title, description], index) => <article className="value-card" key={title}><span className="value-card__number">0{index + 1}</span><h2>{title}</h2><p>{description}</p></article>)}
          </div>
        </section>
      </main>
      <FinalCta title="Help us make confident learning available to more students." />
    </>
  );
}
