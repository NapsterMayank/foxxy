import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  /** Pass one to inspect the cache after a mutation; otherwise a fresh client. */
  readonly queryClient?: QueryClient;
}

/**
 * A client with RETRY OFF.
 *
 * The application retries a 5xx once (`providers.tsx`), which is right in a
 * browser and wrong in a test: a test asserting an error state would wait out
 * a backoff first, and the fake it installed would be called twice for reasons
 * that have nothing to do with what it is testing.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function renderClient(ui: ReactElement, options: ClientOptions = {}): RenderResult {
  const { language = 'en', queryClient = createTestQueryClient(), ...rest } = options;

  /*
   * BOTH PROVIDERS, IN THE SAME ORDER AS `app/providers.tsx` — language
   * outside the data layer. Every feature from build-order step 7 on calls
   * `useQuery` or `useMutation` somewhere in its tree, and a test that wrapped
   * only the translator would fail with "No QueryClient set" from a component
   * three levels below the one under test.
   */
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider initialLanguage={language}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </I18nProvider>
    );
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
