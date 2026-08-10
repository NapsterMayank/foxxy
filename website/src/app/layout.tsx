import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { MobileCta, SiteHeader } from '@/components/site-header';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://alfanumrik.com';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Alfanumrik — Learn smarter. Achieve greater.', template: '%s | Alfanumrik' },
  description: 'Thoughtful AI-powered, CBSE-aligned learning for students in Classes 6–10, families and schools across India.',
  applicationName: 'Alfanumrik',
  openGraph: {
    type: 'website',
    siteName: 'Alfanumrik',
    title: 'Alfanumrik — Learn smarter. Achieve greater.',
    description: 'Thoughtful AI-powered, CBSE-aligned learning for students in Classes 6–10, families and schools across India.',
  },
  twitter: { card: 'summary', title: 'Alfanumrik', description: 'Learn smarter. Achieve greater.' },
};

export const viewport: Viewport = { colorScheme: 'light', themeColor: '#fffaf5' };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body><SiteHeader />{children}<SiteFooter /><MobileCta /></body></html>;
}
