import type { Metadata, Viewport } from 'next';
import { Noto_Sans_Devanagari } from 'next/font/google';
import type { ReactNode } from 'react';
import { getServerLanguage } from '@/lib/i18n/server';
import { Providers } from './providers';
import './globals.css';

/**
 * ===========================================================================
 * THE DEVANAGARI FONT — plan §8: "Devanagari needs a font that supports it.
 * Load with `next/font`, `display: swap`, and SUBSET IT — an unsubset
 * Devanagari font is heavy, and this app targets 4G."
 *
 * `subsets: ['devanagari']` and `preload: false` together mean an ENGLISH user
 * never downloads it. The generated `@font-face` carries a `unicode-range`
 * covering Devanagari only, and a browser fetches a webfont solely when a glyph
 * inside that range is actually rendered — so the cost lands on the readers who
 * need it and on nobody else. Preloading would defeat exactly that.
 *
 * The variable is appended AFTER the system stack in `globals.css`, so Latin
 * text keeps rendering in the system font and only Devanagari falls through.
 * ===========================================================================
 */
const devanagari = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  display: 'swap',
  preload: false,
  variable: '--font-devanagari',
  weight: ['400', '600', '700', '800'],
});

export const metadata: Metadata = {
  title: {
    default: 'Alfanumrik',
    template: '%s · Alfanumrik',
  },
  description: 'The Alfanumrik learning product for students and parents.',
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#faf9f7',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  /*
   * READ ON THE SERVER, so the first paint is already in the right language and
   * `<html lang>` is correct from the first byte. A client-side language read
   * would render English and then flip — a visible flash on every page load for
   * every Hindi reader, and a screen reader announcing the first sentence in
   * the wrong voice.
   */
  const language = await getServerLanguage();

  return (
    <html className={devanagari.variable} lang={language}>
      <body className="font-sans antialiased">
        <Providers initialLanguage={language}>{children}</Providers>
      </body>
    </html>
  );
}
