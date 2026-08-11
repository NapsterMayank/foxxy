# Frontend Progress

**Last verified:** 12 August 2026  
**Scope:** product application in `frontend/` and public marketing application in `website/`  
**Status:** the data layer is live — the product makes real, typed, credentialed API calls. Screens are still presentational; CMS and production content approval remain pending

## Build-order step 0 and step 6 — 12 August 2026

Four of the five foundation gaps in `docs/02-FRONTEND-IMPLEMENTATION-PLAN.md` §11 step 0 are closed, plus step 6 in full. **Tests 10 → 57.**

| Piece | Files | What is load-bearing |
|---|---|---|
| Contract bridge | `scripts/sync-contracts.mjs`, `src/lib/api/generated/` | The backend's `shared/contracts` and `ERROR_CODES` are copied and committed; `contracts-drift.test.ts` runs the generator in `--check` mode. A direct cross-package import cannot work — `Dockerfile` copies `frontend/` alone, so `../backend/src` does not exist in the image and the build would fail on a path that resolves on every developer machine |
| Error table (§5.6) | `src/lib/api/errors.ts` | Exhaustive switch over the GENERATED union, so a new backend code is a type error here. **A 403 on POST/PUT/PATCH/DELETE is `action-blocked`, never `session-expired`** — the backend returns 403 before 401 on state-changing requests, because the CSRF verdict must not depend on who the caller claims to be |
| Typed client (§5.2) | `src/lib/api/client.ts` | `credentials: 'include'` on every request; the response is parsed against its Zod contract, so a backend change surfaces at the boundary instead of three components deep. It throws on 401 rather than redirecting — the redirect needs the query cache cleared in the same step, which a module-scope `location` assignment cannot do |
| Session (§5.5) | `src/lib/session/`, `src/app/providers.tsx`, `src/components/layout/session-gate.tsx` | One bootstrap query, `loading \| authenticated \| unauthenticated`. **`loading` renders a skeleton and never redirects** — redirecting during bootstrap signs out every user on every refresh. Any 401 anywhere clears the cache and redirects with `?next=` |
| Foxy streaming (§7) | `src/features/foxy/lib/sse.ts`, `hooks/use-foxy-stream.ts` | `fetch` + `ReadableStream` (the endpoint is a POST and `EventSource` is GET-only). Frames are buffered across chunk boundaries; unknown frame types are ignored so the backend can add a sixth. **All seven cases in §7 are tests.** The assistant bubble is created lazily on the first token, which is what makes "error before any token" an error state rather than an empty bubble |
| Design tokens (§9.1) | `tailwind.config.ts`, `src/app/globals.css` | Spacing, type, radius, elevation and motion scales are REPLACED, not extended — an off-scale utility does not exist. Tailwind is silent about that (it emits nothing and the element renders with no spacing), so `architecture/spacing-scale-only` makes it a build failure. It caught five real breakages on existing screens the moment it was enabled |

**Still open from step 0: the CI gates (§10.7)** — per-route and shared bundle budgets, Lighthouse LCP/TBT, axe on both journeys, contrast in both themes, visual regression, coverage floors. None has been proven to fail on a deliberate violation, which is the bar the backend's eight gates met.

### Two plan corrections this work forced

1. **The session bootstrap moved to a new backend endpoint.** §5.5 named `GET /me/profile` as the single source of truth for "am I authenticated". It cannot be: it returns a student profile, so a signed-in **parent gets 403** and an **un-onboarded student gets 404**, and neither response carries the role §5.5 needs for navigation and theme. `GET /api/v1/auth/me` now exists on the identity module, returns the same shape as login, and 401s without a session. Pinned by `backend/tests/integration/session-bootstrap.test.ts`.
2. **There is no `proxy.ts` cookie presence check, deliberately.** §5.5 specifies one as a UX optimisation. The session cookie is host-only — the API sets no `Domain` — so the Next server on `app.<domain>` never receives it and the check would bounce every signed-in user to login. It would appear to work locally, where both apps are `localhost` and cookies ignore the port. Making it work means widening the cookie to `Domain=.<domain>`, handing it to the marketing site and every future subdomain. Declined; the cost is one skeleton render on a cold load. Recorded at the top of `session-gate.tsx`.

## Completed in this wave

### Product application (`app.<domain>`)

- Independent Next.js 16 App Router application with React 19, strict TypeScript and Tailwind CSS 3.
- Responsive role selection plus `/login`, `/signup`, `/verify`, `/forgot-password`, `/reset-password` and `/onboarding` presentation flows.
- Responsive `/student` and `/parent` preview dashboards with desktop side navigation and mobile bottom navigation.
- Mobile-first student UX for Classes 6–10: 44 px touch targets, primary actions above the fold, press feedback, current-location navigation, safe-area support and concise learning language without childish decoration or fake gamification.
- Explicit sample/preview labels; no API calls, fake database, mock service worker or invented backend wire contracts.
- Shared four-value learning-evidence type: `Strong evidence`, `Developing`, `Needs another session`, `Not assessed yet`.
- Product-wide `noindex` metadata, crawler-blocking `robots.txt`, `X-Robots-Tag` and baseline response-security headers.
- Custom 404, loading UI and error boundary without leaking raw errors or promising unsaved work is persistent.
- Reduced-motion behavior keeps non-spatial feedback, mobile safe-area padding and sticky-header anchor offsets.
- Partial architecture lint gates for cross-feature imports, arbitrary Tailwind values and direct brand-colour utilities.

### Marketing application (main domain)

- Separate npm application under `website/`; marketing deployments cannot import, rebuild or restart the product application.
- Responsive static routes: `/`, `/features`, `/for-parents`, `/for-schools`, `/pricing` and `/about`.
- Persistent mobile account CTA with safe-area spacing; the main marketing message now explicitly targets Classes 6–10.
- Shared static Server Components for navigation, footer, audience sections, pricing, calls to action and code-native placeholder art.
- Indexable metadata, canonical URLs, `robots.txt`, sitemap and baseline response-security headers.
- Every published route is statically prerendered. A product API, product database or future CMS outage does not take down published marketing pages.
- No analytics, lead form, child-data collection, CMS, API or database dependency has been added.

## Bugs found and resolved

| Defect | Resolution |
|---|---|
| Advertised login and signup links returned 404 | Added all advertised auth routes and browser coverage. |
| Parent login-to-signup navigation lost the parent role | The role is preserved in the signup URL and covered by a unit test. |
| Dashboard evidence labels contradicted the approved plan | Replaced the invented labels/free text with one exact shared union. |
| Error UI claimed unsaved work was safe | Removed the unsupported persistence claim. |
| Reduced-motion mode still caused spatial movement | Spatial transforms are removed while short colour/shadow feedback remains. |
| Mobile test used desktop browser capabilities | The 360 px project now uses a real mobile Chromium device profile. |
| Dashboard hero copy failed WCAG contrast at 4.32:1 | Raised it to solid white; the full axe route matrix now passes. |
| Hash navigation could land below the sticky header | Added semantic scroll margin to product anchors. |
| Mobile bottom navigation ignored device safe areas | Added `env(safe-area-inset-bottom)` padding. |

## Architecture and SOLID assessment

The implemented scope follows SOLID appropriately without adding premature service containers or frontend repositories.

| Principle | Result | Evidence |
|---|---|---|
| Single responsibility | Pass | Route files compose screens; shells own layout; feature components own feature presentation; shared controls own interaction styling. |
| Open/closed | Pass | Narrow view-model props allow content changes without rewriting shared shells. Closed role and evidence unions reject invalid variants. |
| Liskov substitution | Not materially applicable | There is no inheritance or substitutable implementation hierarchy. |
| Interface segregation | Pass | Auth, onboarding, progress and parent summary components receive only the state they render. |
| Dependency inversion | Pass for current scope | Static Server Components depend on props and shared types. API abstractions are intentionally deferred until backend contracts are stable. |

Feature folders do not import each other in the current implementation. The lint gate catches alias-based cross-feature imports, but it is not yet the complete gate promised by the plan: relative-path bypasses, computed class expressions and user-facing JSX literals are not fully enforced.

## Production dry run

### Product application

The release-style Playwright command builds the optimized application, starts `next start`, and checks mobile Chromium at 360 px plus desktop Chromium at 1280 px.

The route matrix covers `/`, all six auth/onboarding routes, `/student`, `/parent` and `/robots.txt`. Every route returned 200, every page had no horizontal overflow, product responses carried `noindex`, keyboard navigation passed, reduced-motion behavior passed, and axe reported zero serious or critical violations.

### Marketing application

The optimized production server was queried directly. `/`, all five secondary landing pages, `/robots.txt` and `/sitemap.xml` returned 200. HTML, text and XML content types were correct; `nosniff` and frame-denial headers were present; no product `noindex` header leaked onto the marketing site.

## Verification

| Application | Check | Result |
|---|---|---|
| Product | `npm run typecheck` | Pass |
| Product | `npm run lint` | Pass, zero warnings |
| Product | `npm test` | Pass: **57 tests in 11 files** (12 August) |
| Product | `npm run build` | Pass: 12 generated routes; preview dashboards static |
| Product | `npm run test:e2e` | Pass: 8 tests across mobile and desktop production builds |
| Product | `npm audit --omit=dev` | Pass: 0 vulnerabilities |
| Marketing | `npm run typecheck` | Pass |
| Marketing | `npm run lint` | Pass, zero warnings |
| Marketing | `npm run build` | Pass: all 10 generated routes static |
| Marketing | live HTTP smoke test | Pass: 8/8 requests returned 200 |
| Marketing | `npm audit --omit=dev` | Pass: 0 vulnerabilities |

## Still blocked by backend/database contracts

1. Auth forms are still presentational: no login, signup, verification-resend or reset call is wired to the client yet. **The current-user bootstrap now exists** (`GET /api/v1/auth/me`) and the session context consumes it.
2. ~~`/student` and `/parent` are public preview routes~~ — **both route groups are now behind `SessionGate`**, which reads the session context, redirects an unauthenticated visitor with `?next=`, and refuses the wrong role. The authoritative check remains the API's, on every request.
3. ~~The future browser API client must send `credentials: 'include'`~~ — **it does, on every request, and a test asserts it.** The API must still use credentialed CORS with an explicit product origin, never `*`; `CORS_READ_ORIGINS`/`CORS_WRITE_ORIGINS` must name the deployed product origin.
4. Onboarding values, parent/child linking, progress evidence and dashboard activity do not persist yet — the screens are not wired to the client.
5. **Foxy streaming is built and tested** (abort on unmount, retry after a mid-stream drop, no reconnect loop by design). Practice, billing, notifications and their failure states remain future phases. **Proxy buffering is still an unverified deployment risk**: the backend sends `X-Accel-Buffering: no`, and nothing has yet observed a real socket to confirm Caddy honours it — see the root progress file on the wire boundary.
6. **Onboarding submits `english`/`hindi` where the generated contract accepts `en`/`hi`, and hardcodes grades 6-10.** Latent until the form is wired; the generated contract is now in the repository, so the disagreement is checkable.

## Still required before main-domain launch

1. Add the editor workflow/CMS with previews and independent deployment. Today marketing content is static and requires a code change, so marketing-team self-service is not complete.
2. Validate every public claim, statistic, price, email address and legal statement. The current values reproduce the supplied direction and are not independently verified launch facts.
3. Publish real Terms, Privacy and child-safety pages before requiring agreement or accepting leads. The marketing site must never collect a child's personal data.
4. Set real `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_APP_URL` values from `website/.env.example` in build environments.
5. Replace the labeled code-native artwork/dashboard placeholders with approved brand assets.
6. Add approved first-party analytics or explicitly choose no analytics at launch; no tracking is present now.
7. Complete Hindi dictionaries, language switching and user-facing-string lint enforcement.
8. Decide whether CSP is nonce-based in Next.js or owned and tested at Caddy; no static CSP was added because it could block Next.js inline bootstrap scripts.
9. Upgrade local Node from 22.11 to the declared minimum 22.13 before strict CI/release builds.

## Next implementation order

1. ✅ ~~Freeze the identity/session and shared response contracts~~ — generated from the backend, with a drift test.
2. ✅ ~~Add one credentialed API client and wire current-user behavior~~ — done; the auth FORMS still need wiring to it.
3. ✅ ~~Protect role layouts with session/role handling~~ — `SessionGate` on both route groups. Preview fixtures still need replacing screen by screen.
4. **Close the CI gates (§10.7).** Bundle budgets, Lighthouse, axe, contrast, visual regression, coverage floors — and prove each one fails on a deliberate violation before trusting it. `@vitest/coverage-v8` is still not installed, so the floors cannot even be measured. **The build environment must set `NEXT_PUBLIC_API_URL`** — `lib/config/env.ts` throws without it, which is deliberate and will fail a CI build that does not.
5. `components/ui` primitives and `components/patterns`, then the auth screens onto the live client.
6. Implement the marketing CMS/editor preview and independent deployment pipeline.
7. Complete i18n, legal content, approved assets and launch-content review.
8. Build the Foxy chat UI on top of `useFoxyStream`, then practice, progress, parent reporting and billing.
