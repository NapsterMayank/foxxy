import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/i18n-provider';
import type { LanguageCode } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * RENDER HELPERS FOR TESTS.
 *
 * Two of them, because the application now has two kinds of component and they
 * cannot be rendered the same way.
 *
 * `renderClient` wraps in `I18nProvider`. Any component calling `useT()` throws
 * without it — deliberately, since a default provider would silently render
 * English inside an unwrapped subtree, which is the exact bug the dictionary
 * system exists to prevent. Tests pay for that strictness with one wrapper.
 *
 * `renderServer` AWAITS the component and renders what it returned. An async
 * server component is a function returning a promise of an element; React's
 * test renderer cannot mount it, and passing `<Component />` produces a promise
 * where an element was expected. Calling it directly is not a workaround — it
 * is what the framework does with it.
 * ===========================================================================
 */

interface ClientOptions extends Omit<RenderOptions, 'wrapper'> {
  readonly language?: LanguageCode;
}

export function renderClient(ui: ReactElement, options: ClientOptions = {}): RenderResult {
  const { language = 'en', ...rest } = options;

  function Wrapper({ children }: { children: ReactNode }) {
    return <I18nProvider initialLanguage={language}>{children}</I18nProvider>;
  }

  return render(ui, { wrapper: Wrapper, ...rest });
}

/**
 * Renders an async server component's output. See the header.
 *
 * WRAPPED IN THE PROVIDER TOO, because a server component's output routinely
 * contains client components — the auth screens hold a form, the shell holds
 * the language switch — and those call `useT()` when React reaches them, not
 * when the server component was awaited.
 */
export async function renderServer(
  element: Promise<ReactElement>,
  options: ClientOptions = {},
): Promise<RenderResult> {
  return renderClient(await element, options);
}
