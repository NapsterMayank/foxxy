import Link from 'next/link';
import type { Metadata } from 'next';
import { DashboardArt, FoxyArt } from '@/components/brand-art';
import { CheckList, FeatureGrid, FinalCta, Highlights, SectionHeading } from '@/components/marketing-blocks';

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.alfanumrik.com';

export const metadata: Metadata = { alternates: { canonical: '/' } };

export default function HomePage() {
  return (
    <>
      <main>
        <section className="home-hero">
          <div className="shell home-hero__grid">
            <div className="home-hero__copy">
              <span className="eyebrow">CBSE learning for Classes 6–10</span>
              <h1>Learn smarter.<br />Achieve <em>greater.</em></h1>
              <p>Clear explanations, aligned practice and honest progress signals—in one calm place for every learner.</p>
              <div className="button-row">
                <a className="button button--primary button--large" href={`${appUrl}/signup`}>Get started free</a>
                <Link className="button button--quiet button--large" href="/features"><span aria-hidden="true">▶</span> See how it works</Link>
              </div>
              <small>Built for students, parents and schools across India.</small>
            </div>
            <div className="home-hero__visual">
              <FoxyArt />
              <div className="float-card float-card--tutor"><span>✦</span><b>AI Tutor</b><small>Step-by-step help</small></div>
              <div className="float-card float-card--progress"><span>↗</span><b>Track progress</b><small>Clear learning evidence</small></div>
            </div>
          </div>
          <div className="shell"><Highlights /></div>
        </section>

        <section className="section">
          <div className="shell">
            <SectionHeading eyebrow="Powerful by design" title="Everything learners need to move forward" text="Purpose-built tools work together, so learners spend less time navigating and more time understanding." />
            <FeatureGrid />
            <div className="center-action"><Link className="button button--soft button--large" href="/features">Explore every feature</Link></div>
          </div>
        </section>

        <section className="section section--wash">
          <div className="shell split-layout">
            <div>
              <span className="eyebrow">For families</span>
              <h2>Support that feels helpful, not intrusive.</h2>
              <p className="lead">See meaningful learning evidence, celebrate steady progress and know when a little extra support can help.</p>
              <CheckList items={['Clear weekly learning picture', 'Useful next steps—not noisy dashboards', 'Simple family and subscription controls']} />
              <Link className="button button--primary" href="/for-parents">Explore for parents</Link>
            </div>
            <DashboardArt variant="parent" />
          </div>
        </section>

        <section className="section">
          <div className="shell split-layout split-layout--reverse">
            <DashboardArt variant="school" />
            <div>
              <span className="eyebrow eyebrow--plum">For schools</span>
              <h2>Smart learning support that respects teachers.</h2>
              <p className="lead">Aligned content, useful classroom signals and a simple experience that fits the work schools already do.</p>
              <CheckList items={['Teacher-friendly workflows', 'Class and learner summaries', 'Flexible access for growing schools']} />
              <Link className="button button--plum" href="/for-schools">Explore for schools</Link>
            </div>
          </div>
        </section>
      </main>
      <FinalCta />
    </>
  );
}
