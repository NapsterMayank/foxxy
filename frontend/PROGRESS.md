# Frontend Progress

**Last verified:** 12 August 2026  
**Scope:** product application in `frontend/` and public marketing application in `website/`  
> **THIS FILE IS A 12 AUGUST SNAPSHOT AND HAS NOT BEEN MAINTAINED SINCE.**
> Everything from build-order step 9 onward — Foxy chat, practice, progress,
> parent, billing, the responsive pass, study, the profile screen and the live
> student dashboard — is recorded in the ROOT `PROGRESS.md`, which is the live
> register, with the reasoning in `docs/03-DECISION-LOG.md`. Read those first;
> this file is kept for the step 0-8 detail they do not repeat. **Nothing below
> should be treated as current state.**

**Status:** build-order steps 0-8 closed. Auth and onboarding call the live backend; the remaining screens (Foxy chat, practice, progress, parent, billing) are still fixtures. The production build runs in the container — see "The build blocker is gone" below. CMS and production content approval remain pending

## Build-order step 0 and step 6 — 12 August 2026

Build-order steps 0, 1-5 and 6 are closed. **Tests 10 → 236 unit and 28 end-to-end at this point** — 252 and 32 after steps 7-8, below.

| Piece | Files | What is load-bearing |
|---|---|---|
| Contract bridge | `scripts/sync-contracts.mjs`, `src/lib/api/generated/` | The backend's `shared/contracts` and `ERROR_CODES` are copied and committed; `contracts-drift.test.ts` runs the generator in `--check` mode. A direct cross-package import cannot work — `Dockerfile` copies `frontend/` alone, so `../backend/src` does not exist in the image and the build would fail on a path that resolves on every developer machine |
| Error table (§5.6) | `src/lib/api/errors.ts` | Exhaustive switch over the GENERATED union, so a new backend code is a type error here. **A 403 on POST/PUT/PATCH/DELETE is `action-blocked`, never `session-expired`** — the backend returns 403 before 401 on state-changing requests, because the CSRF verdict must not depend on who the caller claims to be |
| Typed client (§5.2) | `src/lib/api/client.ts` | `credentials: 'include'` on every request; the response is parsed against its Zod contract, so a backend change surfaces at the boundary instead of three components deep. It throws on 401 rather than redirecting — the redirect needs the query cache cleared in the same step, which a module-scope `location` assignment cannot do |
| Session (§5.5) | `src/lib/session/`, `src/app/providers.tsx`, `src/components/layout/session-gate.tsx` | One bootstrap query, `loading \| authenticated \| unauthenticated`. **`loading` renders a skeleton and never redirects** — redirecting during bootstrap signs out every user on every refresh. Any 401 anywhere clears the cache and redirects with `?next=` |
| Foxy streaming (§7) | `src/features/foxy/lib/sse.ts`, `hooks/use-foxy-stream.ts` | `fetch` + `ReadableStream` (the endpoint is a POST and `EventSource` is GET-only). Frames are buffered across chunk boundaries; unknown frame types are ignored so the backend can add a sixth. **All seven cases in §7 are tests.** The assistant bubble is created lazily on the first token, which is what makes "error before any token" an error state rather than an empty bubble |
| Design tokens (§9.1) | `tailwind.config.ts`, `src/app/globals.css` | Spacing, type, radius, elevation and motion scales are REPLACED, not extended — an off-scale utility does not exist. Tailwind is silent about that (it emits nothing and the element renders with no spacing), so `architecture/spacing-scale-only` makes it a build failure. It caught ELEVEN real breakages on existing screens, each of which was rendering with no size at all |

### The CI gates — §10.7, closed 12 August 2026

`npm run gates` runs everything that needs no build. The rest run in `frontend-ci.yml` after `npm run build`.

| Gate | Command | Deliberately broken? |
|---|---|---|
| Type check | `npm run typecheck` | ✅ failed twice during this work |
| Lint — boundaries · arbitrary values · brand literals · **off-scale spacing** | `npm run lint` | ✅ **eleven real breakages** the moment the spacing rule ran |
| Contracts match the backend | `npm run contracts:check` | ✅ edited a generated file → red |
| Deployable isolation | `npm run check:isolation` | ✅ imported `../../../backend/src` → exit 1 |
| Coverage floors, per area | `npm run test:coverage` | ✅ deleted a test file → `components/ui` 71% vs 90% |
| Contrast, WCAG AA, **both themes** | `playwright test` | ✅ lightened `--muted` → both dashboards failed |
| Visual regression | `playwright test` | ✅ changed the parent `--brand` → screenshot failed |
| axe, zero serious or critical | `playwright test` | pre-existing |
| No user-facing string literals (JSX text · `aria-label` · `alt` · `placeholder` · `title`) | `npm run lint` | ✅ probe component with both → 2 errors |
| Bundle budgets — 180 kB route, 120 kB shared | `npm run check:bundle` | ❌ **BROKEN — 12 August.** It reads `.next/app-build-manifest.json`, which Next 16.3 does not emit; `APP_BUILD_MANIFEST` is gone from the framework's constants. Its ten unit tests pass against a SYNTHETIC `.next` the script's own author defined, so the shape was never checked against a build. Root item 41 |
| LCP ≤ 2.5s · TBT ≤ 200ms, throttled 4G | `npm run check:lighthouse` | ✅ **RUN — 12 August, and two URLs failed.** `/` passes; `/login?role=student` 2870 ms and `/onboarding?role=student` 2873 ms against 2500 ms. TBT and CLS pass everywhere. Root item 42 |

**Both build-dependent gates now execute** — see "The build blocker is gone" below. `next build` was never the problem; a Windows host was. Running them for the first time is what exposed the broken bundle gate and the LCP failures, neither of which was visible while they could not run.

**Visual baselines are per platform.** The committed ones are `win32`. The first Linux CI run writes its own, and those must be committed from that run's artifact before the gate means anything in CI.

**All four visual-regression axes are now real** — breakpoints (two Playwright projects), themes (the two route groups), journeys (the two dashboards) and languages (the cookie the switch writes and the server reads). A Hindi horizontal-overflow check sits beside them, because Hindi runs longer than English and every screen was laid out against the English string.

## Internationalisation — build-order step 5, 12 August 2026

| Piece | Where | What is load-bearing |
|---|---|---|
| Dictionaries | `src/lib/i18n/dictionaries/{en,hi}.ts` | English is the SHAPE; `hi: Dictionary` makes a missing Hindi key a COMPILE error rather than a silent English sentence in a Hindi screen. No `as const`, or Hindi would have to repeat the English strings to type-check |
| Keys | `TranslationKey` in `translate.ts` | A dotted-path union over the dictionary, so `t('auth.loginTitel')` fails the build instead of rendering an empty heading |
| Server and client | `server.ts` · `i18n-provider.tsx` | Two entry points, ONE translator. Server components cannot use hooks and most pages here are server components; making them client components to reach a hook would ship the whole dictionary to a 4G phone for static text |
| The switch | `patterns/language-switch.tsx` | Updates the context AND calls `router.refresh()` — server components read the cookie, not the context, so without the refresh the page ends up half translated. Each language is named in itself ("English", "हिन्दी"): somebody who reads only Hindi cannot find a button labelled with an English word for their language |
| Font | `app/layout.tsx` | Noto Sans Devanagari, `subsets: ['devanagari']`, `preload: false`. The `unicode-range` means a browser fetches it only when a Devanagari glyph is actually rendered — an English reader never downloads it |
| Lint gate | `architecture/no-literal-jsx-text` | JSX text plus `aria-label`, `alt`, `placeholder`, `title`. Punctuation and digits pass — they carry no language |

**The Hindi is not launch copy.** It is correct, plain and consistent in register, and it has not been reviewed by a native speaker. That review is a launch blocker, listed below with the other content that needs approval.

### The framework trap this uncovered

`LANGUAGE_COOKIE` was exported from `i18n-provider.tsx`, which carries `'use client'`. A value imported from a client module into a SERVER module does not arrive as a string — so `cookies().get(LANGUAGE_COOKIE)` looked up a client reference, found nothing, and every server render fell back to English. The symptom was `<html lang="en">` wrapping Hindi content, with a page-level cookie read (which used the literal) working perfectly a few lines away. The constant now lives in `translate.ts`, which has no directive, and a test asserts the lookup uses the literal name.

### Two defects the gates found in this session's own code

1. **An infinite 401 loop in the session provider.** `expire` used `queryClient.clear()`, which removes the bootstrap query — whose live observer immediately refetches, 401s, publishes, and expires again, calling `router.replace` every cycle so the login page never painted. The browser test caught it at thirty-odd requests; the jsdom test had asserted "fetched once" and settled before the second cycle.
2. **Eleven layout utilities rendering with no size.** Closing the token scales makes an off-scale class not exist, and Tailwind emits nothing rather than warning. `pb-28` on the mobile bottom-nav clearance would have hidden the last card of every student screen behind the nav bar.

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
| Product | `npm run gates` | Pass: type-check · lint · contract sync · isolation · **236 tests with §10.5 coverage floors** (12 August) |
| Product | `npm run build` | Pass: 12 generated routes; preview dashboards static |
| Product | `npx playwright test` | Pass: **28 tests** across mobile and desktop — session gate, axe, contrast in both themes, visual regression (12 August, against the dev server; CI runs them against `next start`) |
| Product | `npm audit --omit=dev` | Pass: 0 vulnerabilities |
| Marketing | `npm run typecheck` | Pass |
| Marketing | `npm run lint` | Pass, zero warnings |
| Marketing | `npm run build` | Pass: all 10 generated routes static |
| Marketing | live HTTP smoke test | Pass: 8/8 requests returned 200 |
| Marketing | `npm audit --omit=dev` | Pass: 0 vulnerabilities |

## Still blocked by backend/database contracts

1. ✅ **Auth forms wired — 12 August 2026, build-order steps 7-8.** Login, signup, verify, resend, forgot, reset and both onboarding roles all call the backend. See "Build-order steps 7-8" below.
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
7. ✅ ~~Complete Hindi dictionaries, language switching and user-facing-string lint enforcement~~ — done 12 August. **The Hindi still needs a native-speaker review before launch.**
8. Decide whether CSP is nonce-based in Next.js or owned and tested at Caddy; no static CSP was added because it could block Next.js inline bootstrap scripts.
9. Upgrade local Node from 22.11 to the declared minimum 22.13 before strict CI/release builds.

## Next implementation order

1. ✅ ~~Freeze the identity/session and shared response contracts~~ — generated from the backend, with a drift test.
2. ✅ ~~Add one credentialed API client and wire current-user behavior~~ — done; the auth FORMS still need wiring to it.
3. ✅ ~~Protect role layouts with session/role handling~~ — `SessionGate` on both route groups. Preview fixtures still need replacing screen by screen.
4. ✅ ~~Close the CI gates (§10.7)~~ — **twelve exist, eight proven by deliberate breakage.** Bundle budgets (arithmetic only) and Lighthouse (never executed) stay unproven until `next build` completes on a machine here and CI runs at all. **The build environment must set `NEXT_PUBLIC_API_URL`** — `lib/config/env.ts` throws without it, deliberately, and will fail a CI build that forgets it.
5. ✅ ~~`components/ui` primitives and `components/patterns`, then the auth screens onto the live client~~ — **done 12 August 2026.** Six primitives and nine patterns (92 tests), then build-order steps 7-8: signup, login, verify, resend, forgot, reset, student onboarding and the parent link-code claim, all through the typed client. See "Steps 7-8" below.
6. Implement the marketing CMS/editor preview and independent deployment pipeline.
7. Complete i18n, legal content, approved assets and launch-content review.
8. Build the Foxy chat UI on top of `useFoxyStream`, then practice, progress, parent reporting and billing.

## Build-order steps 7-8 — auth and onboarding on the live client, 12 August 2026

**Tests 236 → 252 unit, 28 → 32 end-to-end. Every gate green.**

The screens made no requests. They now call the backend through the typed client,
validate with the backend's own generated schemas, and map every §5.6 treatment
onto copy that exists in both dictionaries.

| Screen | Endpoint |
|---|---|
| Login | `POST /auth/login` — seeds `sessionKeys.currentUser`, then `?next=` or the role home |
| Signup | `POST /auth/signup` — success line, no auto-navigation; the address is unverified |
| Verify | `GET /auth/verify?token=` read from the URL, plus resend |
| Forgot · Reset | `POST /auth/forgot-password` · `POST /auth/reset-password`, token from the URL |
| Onboarding (student) | `POST /me/onboarding` |
| Onboarding (parent) | `POST /links/submit` — the link starts `pending` and grants nothing |

### Six contract mismatches, each of which would have failed against every backend build

1. Login posted `identifier`; `loginRequestSchema` has `email`.
2. Signup collected a name and enforced 8 characters; the contract takes
   `{email, password, role}` and requires 10.
3. **Verify asked for a six-digit code. That endpoint has never existed** —
   verification is a link token. The screen had no path to success.
4. Onboarding offered English and Social Science; `SUBJECTS` is
   `['mathematics','science']`. Both would have written a subject with no chapters,
   no questions and no corpus, met as an empty practice screen rather than an error.
5. Parent onboarding collected a name nothing stores, and posted nowhere.
6. `?next=` was honoured verbatim — `//evil.example` is protocol-relative, so an
   open redirect on the screen where a password was just typed.

### Three defects in that same work, found by re-reading it rather than by a test

- `noValidate` disarmed the terms checkbox — the browser had been enforcing it.
- The post-login redirect read `?role=`, which anyone can type: a student opening
  `/login?role=parent` was sent to a route their own session gate refuses.
- "Remember me" promised something no request could carry; `loginRequestSchema` is
  `{email, password}` and nothing varies session lifetime.

### Two decisions worth knowing before touching these screens

- **Field errors come from the generated request schema, not from the 400.**
  `toClientPayload()` sends `{ error: { code, message } }` and drops `details`, so
  no field is named on the wire (D-344).
- **A 401 from `POST /auth/login` is a credential verdict, not an expired session.**
  `ApiError` carries the request path so `providers.tsx` can tell them apart (D-345).

## The build blocker is gone — 12 August 2026

`next build` never had anything wrong with it; a Windows host did. The same source
builds cleanly in `frontend/Dockerfile` and produces `.next/standalone` (D-348).

```bash
docker build -f Dockerfile -t foxxy/frontend:local \
  --build-arg NEXT_PUBLIC_API_URL=http://localhost:4000 .
docker run -d --name foxxy-fe -p 3000:3000 foxxy/frontend:local
npx playwright test                              # 26/26; reuses the running server
npx lhci autorun --collect.startServerCommand="" # LCP/TBT/CLS
```

**The first browser run against a production build found four real defects:**
`npm ci` refused to install on Linux (D-350); `--success` and `--warning` failed
WCAG AA on their own 10% tint (D-349); every auth screen scrolled sideways at 360px;
and the bundle-budget gate reads `app-build-manifest.json`, which Next 16.3 no longer
emits — its ten unit tests pass against a synthetic build.

**Visual baselines went 8 → 24.** The suite had been watching only the two dashboards,
neither of which anyone was changing. Login, signup and both onboarding roles are now
covered at two languages and two breakpoints.

### Still open here

| | |
|---|---|
| Bundle-budget gate | Measures a file Next 16.3 does not emit (root item 41) |
| LCP | 2870 ms on `/login`, 2873 ms on `/onboarding`, against 2500 ms. One run, developer hardware — a signal, not the verdict (root item 42) |
| 4 dashboard baselines | Stale: first production renders plus the token change. Need a human before re-recording (root item 43) |
| Hindi | Engineering-quality, not native-reviewed — including the ~20 strings added in this step |
| Steps 9-13 | Foxy chat UI, practice, progress, parent, billing. Both dashboards still render fixtures |
