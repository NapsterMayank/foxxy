import Link from 'next/link';

export default function NotFound() {
  return <main className="not-found"><span className="eyebrow">404</span><h1>This page wandered off.</h1><p>Let’s get you back to learning.</p><Link className="button button--primary" href="/">Return home</Link></main>;
}
