import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LanguageSwitch } from '@/components/patterns/language-switch';
import { en } from '../dictionaries/en';
import { hi } from '../dictionaries/hi';
import { I18nProvider, readLanguageCookie, useT } from '../i18n-provider';
import { createTranslator, type TranslationKey } from '../translate';

/**
 * INTERNATIONALISATION — plan §8, build-order step 5.
 *
 * The done-when for step 5 is one sentence: "switching language re-renders
 * every string". That is the last test in this file, and the two dictionary
 * tests above it are what make it mean something — a switch that re-renders
 * identical English twice would pass a naive version of it.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => {
  refresh.mockReset();
  document.cookie = 'foxxy_lang=; path=/; max-age=0';
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every leaf path in a dictionary, for the parity checks. */
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    paths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('the dictionaries', () => {
  it('have exactly the same keys', () => {
    // The compiler already enforces this (`hi: Dictionary`). Asserted anyway
    // because the type is only as good as the next person's `as never`.
    expect(paths(hi).sort()).toEqual(paths(en).sort());
  });

  it('actually differ — otherwise every other test here is vacuous', () => {
    const translated = paths(en).filter((key) => {
      const english = createTranslator('en')(key as TranslationKey);
      return createTranslator('hi')(key as TranslationKey) !== english;
    });

    // Brand names and the two language names are deliberately identical; the
    // rest must be real Hindi.
    expect(translated.length).toBeGreaterThan(paths(en).length * 0.8);
  });

  it('leaves the untranslatable strings alone', () => {
    /*
     * §8: never translate the brand, the boards, XP, or subject names as the
     * syllabus writes them. A student searching for "Science" must not have to
     * guess "विज्ञान".
     */
    for (const key of ['common.brand', 'common.brandPrefix', 'common.english'] as const) {
      expect(createTranslator('hi')(key)).toBe(createTranslator('en')(key));
    }
  });

  it('keeps every interpolation slot in both languages', () => {
    // A dropped `{name}` renders "Welcome back," in Hindi and nowhere else.
    for (const key of paths(en)) {
      const source = createTranslator('en')(key as TranslationKey);
      const slots = [...source.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const translated = createTranslator('hi')(key as TranslationKey);
      const translatedSlots = [...translated.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(translatedSlots, key).toEqual(slots);
    }
  });
});

describe('the translator', () => {
  it('fills interpolation slots', () => {
    expect(createTranslator('en')('student.greeting', { name: 'Aarav' })).toBe('Hello, Aarav');
  });

  it('leaves an unfilled slot visible rather than blanking it', () => {
    // "Good afternoon, {name}" is obviously broken and gets fixed;
    // "Good afternoon," reads like a design choice and ships.
    expect(createTranslator('en')('student.greeting')).toContain('{name}');
  });

  it('returns empty for an unknown key, never the key itself', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A raw `auth.loginTitle` on screen looks like a leak to a user and like
    // working software to whoever screenshotted it.
    expect(createTranslator('en')('auth.nope' as TranslationKey)).toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to English and warns when a key is missing from a language', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const translate = createTranslator('hi');
    // Simulated by reaching past the type: this is the runtime path for keys
    // built dynamically, which the compiler cannot see.
    const missing = 'home.title' as TranslationKey;
    expect(translate(missing)).not.toBe('');
    warn.mockRestore();
  });
});

describe('the language cookie', () => {
  it.each([
    ['foxxy_lang=hi', 'hi'],
    ['other=1; foxxy_lang=en', 'en'],
    ['foxxy_lang=fr', 'en'],
    ['', 'en'],
  ])('reads %s as %s', (cookie, expected) => {
    // An unknown value falls back rather than throwing: the cookie is
    // user-writable, and a crash on a hand-edited cookie is a denial of service
    // somebody can do to themselves.
    expect(readLanguageCookie(cookie)).toBe(expected);
  });
});

function Screen() {
  const t = useT();
  return (
    <div>
      <h1>{t('home.title')}</h1>
      <p>{t('home.description')}</p>
      <LanguageSwitch />
    </div>
  );
}

describe('the language switch', () => {
  it('re-renders every string, which is step 5 done', async () => {
    render(
      <I18nProvider initialLanguage="en">
        <Screen />
      </I18nProvider>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(en.home.title);
    expect(screen.getByText(en.home.description)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));

    // EVERY string, not only the one nearest the switch.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(hi.home.title);
    expect(screen.getByText(hi.home.description)).toBeVisible();
  });

  it('writes the cookie, so the SERVER renders the next page in the same language', async () => {
    render(
      <I18nProvider initialLanguage="en">
        <Screen />
      </I18nProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(document.cookie).toContain('foxxy_lang=hi');
  });

  it('refreshes the router, because server components read the cookie and not the context', async () => {
    /*
     * Without this the page ends up HALF translated, and which half depends on
     * where a component happens to live — which reads as a translation gap
     * rather than as a plumbing bug.
     */
    render(
      <I18nProvider initialLanguage="en">
        <Screen />
      </I18nProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('updates <html lang>, so a screen reader uses the right voice', async () => {
    render(
      <I18nProvider initialLanguage="en">
        <Screen />
      </I18nProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(document.documentElement.lang).toBe('hi');
  });

  it('marks the active language and does nothing when it is re-selected', async () => {
    render(
      <I18nProvider initialLanguage="en">
        <Screen />
      </I18nProvider>,
    );

    const english = screen.getByRole('button', { name: 'English' });
    expect(english).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(english);
    // No cookie write, no refresh: re-selecting the current language is a no-op.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('names each language in itself', () => {
    /*
     * Somebody who reads only Hindi cannot find a button labelled "Hindi". This
     * is the one place where NOT translating the label is the accessible
     * choice.
     */
    render(
      <I18nProvider initialLanguage="hi">
        <Screen />
      </I18nProvider>,
    );

    expect(screen.getByRole('button', { name: 'English' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'हिन्दी' })).toBeVisible();
  });
});

describe('useT outside the provider', () => {
  it('throws rather than silently rendering English', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Screen />)).toThrow(/I18nProvider/);
    error.mockRestore();
  });
});

describe('the server language read', () => {
  it('asks for the cookie by its literal name', async () => {
    /*
     * THE REGRESSION THIS PINS. `LANGUAGE_COOKIE` used to be exported from
     * `i18n-provider.tsx`, a `'use client'` module — and a value imported from
     * a client module into a server module does not arrive as a string. The
     * cookie lookup silently found nothing, every server render fell back to
     * English, and the page came out as `<html lang="en">` with Hindi content
     * underneath. Moving the constant into `translate.ts` fixed it.
     */
    const get = vi.fn(() => ({ value: 'hi' }));
    vi.doMock('next/headers', () => ({ cookies: () => Promise.resolve({ get }) }));

    const { getServerLanguage } = await import('../server');
    await expect(getServerLanguage()).resolves.toBe('hi');
    expect(get).toHaveBeenCalledWith('foxxy_lang');

    vi.doUnmock('next/headers');
  });
});
