import Link from 'next/link';
import { BrandMark } from './brand-mark';
import { primaryNavigation } from '@/content/site';

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.alfanumrik.com';

function Navigation() {
  return (
    <nav aria-label="Primary navigation">
      {primaryNavigation.map((item) => <Link href={item.href} key={item.href}>{item.label}</Link>)}
    </nav>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <BrandMark />
        <div className="site-header__desktop"><Navigation /></div>
        <div className="site-header__actions">
          <a className="button button--quiet" href={`${appUrl}/login`}>Log in</a>
          <a className="button button--primary" href={`${appUrl}/signup`}>Sign up</a>
        </div>
        <details className="mobile-menu">
          <summary aria-label="Open navigation"><span /><span /><span /></summary>
          <div className="mobile-menu__panel">
            <Navigation />
            <a className="button button--quiet" href={`${appUrl}/login`}>Log in</a>
            <a className="button button--primary" href={`${appUrl}/signup`}>Sign up</a>
          </div>
        </details>
      </div>
    </header>
  );
}
