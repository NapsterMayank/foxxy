import Link from 'next/link';
import { Icon } from './icons';
import { features, highlights } from '@/content/site';

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.alfanumrik.com';

export function SectionHeading({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <div className="section-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
    </div>
  );
}

export function FeatureGrid({ limit }: { limit?: number }) {
  return (
    <div className="feature-grid">
      {features.slice(0, limit).map((feature) => (
        <article className="feature-card" key={feature.title}>
          <span className="icon-wrap"><Icon name={feature.icon} /></span>
          <h3>{feature.title}</h3>
          <p>{feature.description}</p>
        </article>
      ))}
    </div>
  );
}

export function Highlights() {
  return (
    <div className="highlights" aria-label="Alfanumrik at a glance">
      {highlights.map((item) => (
        <div key={item.label}><strong>{item.value}</strong><span>{item.label}</span></div>
      ))}
    </div>
  );
}

export function FinalCta({ title = 'A smarter learning day starts here.', text = 'Join learners and families building confidence one clear step at a time.' }: { title?: string; text?: string }) {
  return (
    <section className="section section--tight">
      <div className="shell cta-panel">
        <div><span className="eyebrow eyebrow--light">Start learning</span><h2>{title}</h2><p>{text}</p></div>
        <div className="cta-panel__actions">
          <a className="button button--light" href={`${appUrl}/signup`}>Get started free</a>
          <Link className="button button--ghost-light" href="/features">Explore features</Link>
        </div>
      </div>
    </section>
  );
}

export function CheckList({ items }: { items: readonly string[] }) {
  return <ul className="check-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}
