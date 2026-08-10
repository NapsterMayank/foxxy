# Frontend Progress

**Last verified:** 10 August 2026  
**Scope:** product application in `frontend/` and public marketing application in `website/`  
**Status:** frontend-only preview is healthy; API/session, CMS and production content approval remain pending

## Completed in this wave

### Product application (`app.<domain>`)

- Independent Next.js 16 App Router application with React 19, strict TypeScript and Tailwind CSS 3.
- Responsive role selection plus `/login`, `/signup`, `/verify`, `/forgot-password`, `/reset-password` and `/onboarding` presentation flows.
- Responsive `/student` and `/parent` preview dashboards with desktop side navigation and mobile bottom navigation.
- Explicit sample/preview labels; no API calls, fake database, mock service worker or invented backend wire contracts.
- Shared four-value learning-evidence type: `Strong evidence`, `Developing`, `Needs another session`, `Not assessed yet`.
- Product-wide `noindex` metadata, crawler-blocking `robots.txt`, `X-Robots-Tag` and baseline response-security headers.
- Custom 404, loading UI and error boundary without leaking raw errors or promising unsaved work is persistent.
- Reduced-motion behavior keeps non-spatial feedback, mobile safe-area padding and sticky-header anchor offsets.
- Partial architecture lint gates for cross-feature imports, arbitrary Tailwind values and direct brand-colour utilities.

### Marketing application (main domain)

- Separate npm application under `website/`; marketing deployments cannot import, rebuild or restart the product application.
- Responsive static routes: `/`, `/features`, `/for-parents`, `/for-schools`, `/pricing` and `/about`.
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
| Product | `npm test` | Pass: 10 tests in 6 files |
| Product | `npm run build` | Pass: 12 generated routes; preview dashboards static |
| Product | `npm run test:e2e` | Pass: 8 tests across mobile and desktop production builds |
| Product | `npm audit --omit=dev` | Pass: 0 vulnerabilities |
| Marketing | `npm run typecheck` | Pass |
| Marketing | `npm run lint` | Pass, zero warnings |
| Marketing | `npm run build` | Pass: all 10 generated routes static |
| Marketing | live HTTP smoke test | Pass: 8/8 requests returned 200 |
| Marketing | `npm audit --omit=dev` | Pass: 0 vulnerabilities |

## Still blocked by backend/database contracts

1. Auth forms are intentionally presentational: no session creation, authenticated redirect, verification token, reset token, logout or current-user bootstrap exists yet.
2. `/student` and `/parent` are public preview routes until the authoritative API session/role check is available. They must not be treated as protected data screens.
3. The future browser API client must send `credentials: 'include'`; the API must use credentialed CORS with an explicit product origin, never `*`.
4. Onboarding values, parent/child linking, progress evidence and dashboard activity do not persist yet.
5. Foxy streaming, practice, billing, notifications and failure-state integration remain future phases. SSE work must include abort/reconnect handling and proxy buffering/timeouts.

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

1. Freeze the identity/session and shared response contracts with the backend team.
2. Add one credentialed API client and wire auth/current-user behavior without duplicating server state.
3. Protect role layouts with authoritative session/role handling, then replace preview fixtures incrementally.
4. Implement the marketing CMS/editor preview and independent deployment pipeline.
5. Complete i18n, legal content, approved assets and launch-content review.
6. Implement Foxy, practice, progress, parent reporting and billing only as their backend contracts become stable.
