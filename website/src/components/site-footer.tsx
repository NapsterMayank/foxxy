import Link from 'next/link';
import { BrandMark } from './brand-mark';
import { primaryNavigation } from '@/content/site';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__grid">
        <div>
          <BrandMark />
          <p>India’s thoughtful AI learning companion for CBSE students.</p>
        </div>
        <div>
          <strong>Explore</strong>
          {primaryNavigation.slice(1).map((item) => <Link href={item.href} key={item.href}>{item.label}</Link>)}
        </div>
        <div>
          <strong>Support</strong>
          <a href="mailto:hello@alfanumrik.com">Contact us</a>
          <span>Help centre — coming soon</span>
          <span>Privacy — publishing soon</span>
        </div>
        <div>
          <strong>For schools</strong>
          <Link href="/for-schools">School solutions</Link>
          <a href="mailto:schools@alfanumrik.com">Book a conversation</a>
        </div>
      </div>
      <div className="shell site-footer__bottom">
        <span>© {new Date().getUTCFullYear()} Alfanumrik Learning. All rights reserved.</span>
        <span>Made with care in India</span>
      </div>
    </footer>
  );
}
