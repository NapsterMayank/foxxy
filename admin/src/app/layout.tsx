import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Alfanumrik operations',
  // Belt and braces with the `X-Robots-Tag` header in `next.config.ts`. An
  // operations panel showing masked learner data must never be indexed, and
  // the two mechanisms fail independently.
  robots: { index: false, follow: false },
};

/** Every screen, and the one place they are named. */
const SECTIONS = [
  { group: 'Monitoring', links: [
    ['/', 'Overview'],
    ['/monitoring', 'Signals and rules'],
    ['/jobs', 'Jobs'],
    ['/workers', 'Workers'],
  ] },
  { group: 'People', links: [
    ['/users', 'Users'],
  ] },
  { group: 'Learning', links: [
    ['/practice', 'Practice'],
    ['/foxy', 'Foxy'],
  ] },
  { group: 'Record', links: [
    ['/billing', 'Billing'],
    ['/audit', 'Audit'],
    ['/content', 'Content coverage'],
  ] },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="layout">
          <nav className="side">
            <h1>Alfanumrik ops</h1>
            {SECTIONS.map((section) => (
              <div key={section.group}>
                <div className="group">{section.group}</div>
                {section.links.map(([href, label]) => (
                  <a key={href} href={href}>{label}</a>
                ))}
              </div>
            ))}
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
