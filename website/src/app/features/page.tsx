import type { Metadata } from 'next';
import { DashboardArt } from '@/components/brand-art';
import { FeatureGrid, FinalCta, SectionHeading } from '@/components/marketing-blocks';

export const metadata: Metadata = {
  title: 'Features',
  description: 'Explore Alfanumrik’s AI tutor, CBSE-aligned practice, progress evidence, mock tests and bilingual learning tools.',
  alternates: { canonical: '/features' },
};

export default function FeaturesPage() {
  return (
    <>
      <main>
        <section className="page-hero page-hero--center">
          <div className="shell">
            <SectionHeading eyebrow="Features" title="Powerful tools for better learning outcomes" text="Every feature exists to make learning clearer, practice more focused and progress easier to understand." />
          </div>
        </section>
        <section className="section section--no-top"><div className="shell"><FeatureGrid /></div></section>
        <section className="section section--wash">
          <div className="shell split-layout">
            <div><span className="eyebrow">One connected experience</span><h2>Less switching. More learning.</h2><p className="lead">Tutor guidance, practice and progress share the same learning context, so the next step always makes sense.</p></div>
            <DashboardArt />
          </div>
        </section>
      </main>
      <FinalCta />
    </>
  );
}
