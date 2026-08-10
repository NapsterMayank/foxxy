# Product Frontend Implementation Plan

**Scope:** this document covers only the authenticated product in `frontend/` at `app.<domain>`. The independently deployed marketing website and Payload CMS live under `website/` and are specified by `06-FRONTEND-SEPARATION-PLAN.md` (D-080).

**Prerequisite:** read `00-ARCHITECTURE.md`, `01-BACKEND-IMPLEMENTATION-PLAN.md`, then `06-FRONTEND-SEPARATION-PLAN.md`. The product frontend consumes contracts defined by the backend and must never redefine them.

---

## 1. Stack

| Concern | Choice | Package |
|---|---|---|
| Framework | Next.js 15, App Router | `next` |
| Language | TypeScript, `strict: true` | `typescript` |
| Styling | Tailwind CSS | `tailwindcss` |
| Component primitives | shadcn/ui — copied into the repo, not a dependency | `radix-ui` under the hood |
| Server state | TanStack Query | `@tanstack/react-query` |
| Forms | React Hook Form + Zod resolver | `react-hook-form`, `@hookform/resolvers` |
| Validation | Zod schemas **imported from the backend** | `zod` |
| Charts | Recharts | `recharts` |
| Unit and component tests | Vitest + Testing Library | `vitest`, `@testing-library/react` |
| API mocking in tests | Mock Service Worker | `msw` |
| End-to-end | Playwright | `@playwright/test` |

**Why shadcn/ui rather than a component library:** the components are copied into your repository, so you own them. No fighting a library's opinions, no version upgrades breaking your design, and every primitive is editable. For a solo developer this is the difference between shipping and yak-shaving.

**Why TanStack Query rather than a global store:** almost all state in this application is server state — the student's profile, chat history, practice results. Server state does not belong in a client store. TanStack Query handles caching, revalidation, loading and error states as a single concern. See Section 6.

---

## 2. Folder structure

**Feature-sliced.** Code is grouped by what it does for the user, not by what kind of file it is. A folder of every button in the app is useless; a folder containing everything about practice is where you actually work.

```
frontend/
├─ src/
│  ├─ app/                          ROUTING ONLY. thin.
│  │  ├─ (auth)/                    login · signup · verify · reset
│  │  ├─ (student)/                 home · foxy · practice · progress
│  │  ├─ (parent)/                  home · transcript · billing
│  │  ├─ layout.tsx                 providers
│  │  └─ api/                       BFF proxy only, if needed
│  │
│  ├─ features/                     THE APPLICATION
│  │  ├─ auth/
│  │  ├─ onboarding/
│  │  ├─ foxy/
│  │  ├─ practice/
│  │  ├─ progress/
│  │  ├─ parent-dashboard/
│  │  └─ billing/
│  │
│  ├─ components/                   SHARED, feature-agnostic
│  │  ├─ ui/                        primitives: Button, Input, Card, Dialog
│  │  ├─ layout/                    AppShell, Header, BottomNav, Container
│  │  └─ patterns/                  composed but generic: EmptyState,
│  │                                ErrorState, DataTable, ConfirmDialog
│  │
│  ├─ lib/
│  │  ├─ api/                       typed client, query keys, hooks
│  │  ├─ hooks/                     generic hooks: useMediaQuery, useDebounce
│  │  ├─ i18n/                      dictionaries and the translation hook
│  │  ├─ utils/                     pure helpers: format, cn, date
│  │  └─ config/                    typed public environment variables
│  │
│  ├─ styles/                       globals.css, Tailwind config extensions
│  └─ types/                        types NOT owned by the backend
│
└─ tests/
   ├─ e2e/                          Playwright specs
   └─ setup/                        test setup, MSW handlers
```

`website/` is a sibling deployable, not a route group or feature inside this tree. Neither application imports runtime code from the other, and a marketing change does not enter this application's build.

### Anatomy of a feature

Every feature folder has the same shape.

```
features/practice/
├─ index.ts                    PUBLIC. pages import only from here.
├─ components/
│  ├─ QuestionCard.tsx
│  ├─ AnswerOptions.tsx
│  ├─ PracticeProgress.tsx
│  └─ ResultSummary.tsx
├─ hooks/
│  ├─ usePracticeSession.ts    orchestrates the session
│  └─ useAnswerTimer.ts        anti-cheat timing capture
├─ api/
│  └─ practice.api.ts          query and mutation hooks for this feature
├─ lib/
│  └─ practice.utils.ts        pure helpers specific to practice
└─ __tests__/
   ├─ QuestionCard.test.tsx
   ├─ usePracticeSession.test.ts
   └─ practice.utils.test.ts
```

**A page component is thin.** It reads route parameters, renders a feature component, and does nothing else. If a page file passes 50 lines, logic has leaked into it that belongs in the feature.

**Features never import from each other.** If two need the same thing, it moves to `components/` or `lib/`. This is the same one-way dependency rule as the backend, and it is enforced by the same kind of ESLint rule.

---

## 3. SOLID, applied to React

SOLID is usually taught with classes. It maps onto components and hooks directly, and applying it is what keeps a React codebase from becoming a pile of 700-line components.

### S — Single Responsibility

**One component does one thing. One hook does one thing.**

Wrong: `PracticePage` fetches questions, tracks the timer, holds answers, calculates the score, renders the UI and submits.

Right:
| Unit | Sole responsibility |
|---|---|
| `usePracticeSession` | Session state and orchestration |
| `useAnswerTimer` | Measuring time per question |
| `QuestionCard` | Rendering one question |
| `AnswerOptions` | Rendering and selecting an option |
| `ResultSummary` | Rendering the outcome |
| `PracticePage` | Assembling the above |

The test: describe the component in one sentence. If the sentence needs "and", split it.

### O — Open for extension, closed for modification

A component should absorb new cases without being edited.

Wrong: `<Button variant="primary" isFoxy isDanger isSmallOnMobile />` — every new case edits the component.

Right: `<Button variant="primary" size="lg" />` with variants declared in one place (`cva`), and composition for anything else: `<Button asChild><Link/></Button>`.

**Rule:** if adding a new case means adding an `if` inside a shared component, the design is wrong. Pass it in as a prop, a variant, or `children`.

### L — Liskov substitution

Any component accepting a set of props must be replaceable by another accepting the same props.

Practically: every input-like component accepts the same base props — `value`, `onChange`, `disabled`, `error`, `label`. `TextInput`, `Select` and `RadioGroup` are then interchangeable inside a form wrapper, and a shared `FormField` works with all of them without knowing which it wrapped.

### I — Interface segregation

**Do not force a component to accept props it does not use.**

Wrong: `<QuestionCard student={student} session={session} question={question} />` when it only reads `question.text` and `question.options`.

Right: `<QuestionCard text={...} options={...} selected={...} onSelect={...} />`.

Two payoffs: the component is testable without constructing an entire student object, and it becomes reusable anywhere a question is shown.

### D — Dependency inversion

**Components depend on abstractions, not on concrete implementations.**

A component never calls `fetch` and never imports the API client. It receives data through a hook, and the hook is the seam. In tests you swap the hook or intercept at the network with MSW, and the component never knows.

Same principle for navigation, translation and toasts — each reached through a hook (`useRouter`, `useT`, `useToast`), never imported directly into a presentational component.

---

## 4. Reuse — the three tiers

Reuse is not "extract everything". Premature abstraction is worse than duplication. The rule below decides for you.

| Tier | Location | Knows about | Example |
|---|---|---|---|
| **1. Primitive** | `components/ui/` | Nothing. No business concept | `Button`, `Input`, `Card`, `Badge`, `Dialog`, `Skeleton` |
| **2. Pattern** | `components/patterns/` | Generic app concepts, not features | `EmptyState`, `ErrorState`, `LoadingState`, `PageHeader`, `ConfirmDialog`, `StatCard` |
| **3. Feature** | `features/*/components/` | Its own feature only | `QuestionCard`, `CitationChip`, `DigestSummary` |

**Promotion rule — the rule of three:** write it in the feature first. On the **third** place it is needed, promote it to `patterns/`. Not the second. Two usages are a coincidence; three is a pattern. Promoting too early produces a "generic" component with eleven boolean props that nobody can use.

**Never demote knowledge downward.** A `Button` must never know what a quiz is. The moment a primitive imports a feature type, the tier system has collapsed and every primitive becomes coupled to everything.

### What is definitely shared, and must be built once

| Concern | Component | Used by |
|---|---|---|
| Loading | `<LoadingState />` + `<Skeleton />` | every data screen |
| Empty | `<EmptyState icon title description action />` | every list |
| Error | `<ErrorState onRetry />` | every data screen |
| Offline | `<OfflineBanner />` | app shell |
| Page heading | `<PageHeader title subtitle actions />` | every page |
| Number display | `<StatCard label value trend />` | parent home, progress |
| Confirmation | `<ConfirmDialog />` | revoke link, cancel subscription |
| Form field | `<FormField label error hint>{children}</FormField>` | every form |

**Build these on day one, before any screen.** Building them after three screens exist means retrofitting three screens.

---

## 5. Data layer

### 5.1 Types come from the backend. Always.

```
backend/src/shared/contracts/practice.contract.ts   <- defined ONCE, here
frontend/src/lib/api/practice.api.ts                <- imports the inferred type
```

**Never hand-write a type on the frontend for data the backend returns.** Hand-written mirrors drift, and the drift is discovered in production. If the two packages cannot import from each other directly, generate the types from the backend contracts as a build step — but there is still exactly one definition.

### 5.2 One typed client

`lib/api/client.ts` — a single wrapper around `fetch` that:
- prefixes the base URL from typed config,
- sends `credentials: 'include'` on every request so the host-bound `SameSite=Lax` cookie travels from `app.<domain>` to the same-site, cross-origin `api.<domain>`,
- parses the response and **validates it against the Zod contract**,
- converts a non-2xx response into a typed `ApiError` carrying the backend's error code,
- redirects to login on a 401.

The backend must answer only the exact product origin with `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials: true`; `*` is forbidden. Email verification remains a top-level GET on the API followed by a 302 to `/onboarding`, which is why `SameSite=Lax` remains correct.

Validating the response is not paranoia. It is how a backend change that breaks the frontend surfaces as a clear error at the boundary instead of `undefined is not a function` three components deep.

### 5.3 Query keys are centralised

```
lib/api/query-keys.ts

practiceKeys.all
practiceKeys.session(id)
practiceKeys.history(studentId)
```

Scattered string keys make cache invalidation guesswork. One file means invalidation is a lookup, not a search.

### 5.4 One hook per operation

Every server interaction is a hook in `features/*/api/`. Components call the hook. Components never call the client.

```
useChapters(grade, subject)          query
usePracticeSession(sessionId)        query
useSubmitPractice()                  mutation
useFoxyStream(sessionId)             streaming, see Section 7
```

Mutations invalidate the affected query keys on success. Optimistic updates only where the operation genuinely cannot fail — not on practice submission, which can be rejected by anti-cheat.

---

### 5.5 Authentication and session state

The session is an `httpOnly` cookie, so **the frontend cannot read it.** Everything below follows from that single fact, and none of it is inferable — leave it unspecified and it gets invented three times inconsistently, with auth flicker on every page load.

**The bootstrap contract.** One endpoint, `GET /api/v1/me/profile`, is the single source of truth for "am I authenticated". It returns the profile on 200 and `UnauthenticatedError` on 401. There is no other way to ask.

**Session context.** A single `SessionProvider` at the root layout holds `{ status, user }` where status is `loading | authenticated | unauthenticated`. It is populated by one bootstrap query and by nothing else. **No component calls the bootstrap endpoint directly** — they read the context.

**Route protection — the decision, and why.** Next.js middleware cannot validate the session cheaply, because the cookie is bound to the API host and validating it means a network round trip on every navigation. Middleware therefore performs a **presence check only** — cookie absent means redirect to login — and the **authoritative check is server-side on the API**, on every request, where it already is.

This is deliberate: the middleware check is a user-experience optimisation, not a security boundary. **A forged cookie passes middleware and is rejected by the API**, which is the correct division. Never move an authorisation decision into the frontend.

**Layout guards.** `(student)` and `(parent)` route groups each have a layout that reads the session context, redirects an unauthenticated user, and — for the parent group — verifies the role. Individual pages assume an authenticated actor and never re-check.

**Loading.** While status is `loading`, protected layouts render a skeleton, **never a redirect**. Redirecting during bootstrap logs out every user on every refresh, and it is the single most common bug in cookie-session applications.

**Mid-session expiry.** A 401 from any request sets the context to `unauthenticated`, clears the query cache, and redirects to login carrying a `?next=` parameter. **The query cache must be cleared** — otherwise the next user on a shared device sees the previous one's cached data. On a shared family device this is not hypothetical.

**Role.** It arrives from the bootstrap response and is used only to choose navigation and theme. It is **never** used to decide whether data may be shown; that decision belongs to the API.

### 5.6 Backend error codes map to UI treatments

The typed `ApiError` from 5.2 carries the backend's error code. Every code has exactly one treatment, defined here rather than improvised per screen.

| Code / status | Treatment |
|---|---|
| `401 UNAUTHENTICATED` | Clear session context, clear query cache, redirect to login with `?next=` |
| **`403 FORBIDDEN` on a POST, PUT, PATCH or DELETE** | **May be a CSRF origin rejection, not an expired session.** The backend deliberately returns 403 before 401 on state-changing requests, because the CSRF verdict must not depend on who the caller claims to be. Show a generic "could not complete that action, please refresh" — **do not** treat it as a logout |
| `403 FORBIDDEN` on a GET | Not permitted. Show a not-found or no-access state carrying no detail about what exists |
| `EMAIL_NOT_VERIFIED` | Not a login failure. Show a resend-verification affordance |
| `409 CONFLICT` | Retryable and expected — for example a link code minted concurrently. Show "please try again", not an error |
| `429 RATE_LIMITED` | Show the wait, disable the trigger until it elapses. Never retry automatically |
| `502 DEPENDENCY_ERROR` | Use the degradation copy from resilience plan section 6, naming what is unavailable and what still works |
| `400 VALIDATION` | Map field errors onto the form. Never a page-level error |
| `500` and anything unrecognised | Generic error state with retry. **Never render a server message to a user** |
| **Foxy abstention** | **Not an error.** It arrives as a successful response with `abstained: true`. It renders as an answer, in the answer's own styling. Rendering it as an error destroys the trust the abstention exists to build |

**Enforcement:** the code union lives in `shared/contracts/`, so backend and frontend share one list, and a `switch` over it fails the build when the backend adds a code the frontend does not handle.

## 6. State — four kinds, four tools

Most React complexity comes from treating all state as one thing. It is four things.

| Kind | Example | Tool | Never |
|---|---|---|---|
| **Server state** | profile, chapters, history, digest | TanStack Query | Copy it into `useState`. That creates two sources of truth, and they will disagree |
| **URL state** | current chapter, filter, tab | Route and search params | Duplicate it in component state — it breaks the back button and breaks sharing a link |
| **Local UI state** | dialog open, option selected | `useState` in the nearest owner | Lift it higher than necessary |
| **Cross-cutting client state** | language, theme, toasts | React Context, one per concern | Put server data in Context |

**There is no global store, and none is needed.** If some state feels like it needs one, it is almost always server state that got copied into a component. Fix the copy instead.

**The one genuine exception:** an in-flight Foxy stream is client state that outlives a component. Keep it in a context owned by the `foxy` feature — not in a global store shared with everything else.

---

## 7. The Foxy streaming client

The most delicate part of the frontend, specified in detail because streaming is where partial-state bugs live.

`features/foxy/hooks/useFoxyStream.ts` owns all of it.

**Responsibilities:**
**Implementation — read this before writing a line of it.** The endpoint is a **POST**, and `EventSource` is **GET-only**. There is no server-sent-events-over-POST in the browser API. Reaching for `EventSource` is the default instinct and it cannot work here.

Use `fetch` with a `ReadableStream` body reader:
- `fetch(url, { method: 'POST', body, credentials: 'include', signal })`
- Read `response.body.getReader()`, decode with `TextDecoderStream`, and parse SSE frames by hand — events are separated by a blank line, fields are `event:` and `data:`
- **Buffer partial frames across chunk boundaries.** A chunk can split a frame mid-field; a parser that assumes whole frames per chunk works in development and corrupts under real network conditions
- Cancellation is an `AbortController`, not `EventSource.close()`
- **There is no automatic reconnection.** `EventSource` gives that for free; `fetch` does not. Reconnection and its backoff are ours to write

Frame types the client must handle: `token`, `citation`, `abstention`, `done`, `error`. An unrecognised event type is ignored rather than thrown — the backend must be able to add a frame type without breaking deployed clients.

1. Open the stream by POSTing to `/foxy/sessions/:id/messages`, per the approach above.
2. Append tokens to the in-progress assistant message as they arrive.
3. Parse citation frames and attach them to the right message.
4. Expose `{ messages, isStreaming, error, send, cancel }`.
5. On completion, write the final message into the query cache so a page refresh shows the same history.

**Cases that must be handled — each one is a test:**

| Case | Required behaviour |
|---|---|
| Connection drops mid-stream | Keep the partial text visible and offer retry. **Never silently discard it** |
| User navigates away | Cancel the request. No state update on an unmounted component |
| User sends again while streaming | Block or queue. Never interleave two streams into one message |
| Server abstains | Render the abstention clearly. It is a valid answer, not an error |
| Server errors before any token | Error state with retry, not an empty bubble |
| Citations arrive after the text | Attach by message id, never by position |
| Very long answer | Virtualise or cap. Must not jank on a low-end Android device |

**Rendering rule:** the component that renders messages is purely presentational and receives `messages` as a prop. It knows nothing about SSE. That is what makes it testable without a network — hand it an array, assert what appears.

---

## 8. Internationalisation

Hindi and English. Not an afterthought — retrofitting translation into finished screens costs more than doing it from the first one.

**Structure:** `lib/i18n/dictionaries/{en,hi}.ts`, nested by feature, with `useT()` returning the translation function.

**Rules:**
- **No literal user-facing string in a component. Ever.** Enforced by an ESLint rule rejecting string literals in JSX text nodes.
- Keys namespaced by feature: `practice.results.title`.
- **Never translate:** CBSE, XP, NCERT, Bloom's, or subject names as the syllabus writes them.
- Numbers and dates through `Intl` with an Indian locale.
- Devanagari needs a font that supports it. Load with `next/font`, `display: swap`, and **subset it** — an unsubset Devanagari font is heavy, and this app targets 4G.
- A missing key falls back to English and warns in development. It must never render a raw key to a user.
- **Hindi runs longer than English. Test every layout in both.** A button that fits "Submit" may not fit its Hindi equivalent.

---

## 9. Responsive and design

**Mobile-first, without exception.** The primary device is a mid-range Android phone on 4G. Design at 360 px and scale up.

| Breakpoint | Width | Layout |
|---|---|---|
| base | 360+ | single column, bottom navigation |
| `md` | 768+ | wider content, side padding |
| `lg` | 1024+ | two columns where it helps, sidebar navigation |

**Rules:**
- Every interactive element is at least 44 by 44 pixels. Thumbs are not mouse pointers.
- Bottom navigation on mobile, sidebar on desktop — one `AppShell` handles both.
- No horizontal scroll at 360 px, on any screen, in either language.
- Tables become cards on mobile. A horizontally scrolling table is a failure, not a solution.
- Dialogs become bottom sheets on mobile.
- Test on a real device, not only in the browser's emulator.

**Design tokens live in the Tailwind config** — colours, spacing, radius, typography. No arbitrary values such as `text-[13px]` in components. If a value is needed twice, it becomes a token.

### 9.1 Design tokens — actual values, before the first primitive

"Tokens live in the Tailwind config" is an instruction, not a system. Two brand themes, four breakpoints and two languages means **sixteen renderings per screen**; without defined scales, twenty screens produce twenty variants and no manual review catches it.

**Two themes, one semantic layer.** Student is purple, parent is orange. Components **never** reference a brand colour directly — they reference a semantic token, and the theme supplies the value.

| Semantic token | Student | Parent |
|---|---|---|
| `--brand` | purple 600 | orange 600 |
| `--brand-hover` | purple 700 | orange 700 |
| `--brand-subtle` | purple 50 | orange 50 |
| `--brand-fg` | white on brand | white on brand |

Applied by a `data-theme` attribute on the route-group layout. **A component that hard-codes `purple-600` is a defect** — it renders wrong in the parent app — and an ESLint rule rejects brand colour literals in `components/` and `features/`.

**Semantic status colours, shared across both themes.** `--success`, `--warning`, `--danger`, `--info`, `--muted`. Note the client's constraint: **no harsh red "Wrong"**. The incorrect-answer state uses `--info` with "Not yet" copy, never `--danger`.

**Scales — fixed, no arbitrary values.**

| Scale | Values |
|---|---|
| Spacing | 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 px. Nothing between |
| Type | 12 · 14 · 16 · 18 · 20 · 24 · 30 · 36 px. **Body is 16 minimum** — the primary users are children on small phones |
| Line height | 1.25 headings · 1.5 body · 1.6 Hindi body. **Devanagari needs more leading than Latin** |
| Radius | 4 · 8 · 12 · 16 · full |
| Elevation | 3 levels only: raised, overlay, modal |
| Motion | 150 ms micro · 250 ms transition · 400 ms page. All disabled under `prefers-reduced-motion` |

`text-[13px]` and every other arbitrary value is rejected by lint. If a value is needed twice, it becomes a token.

**Evidence labels are a shared type, not free text.** The client requires exactly four — Strong evidence, Developing, Needs another session, Not assessed yet — and forbids showing mastery percentages. The union lives in `shared/contracts/`, so the frontend cannot invent a fifth label and cannot render a number.

### Product SEO boundary

Every route on `app.<domain>` is non-indexable: root metadata sets `robots: { index: false, follow: false }`, responses carry `X-Robots-Tag: noindex, nofollow, noarchive`, and the product `robots.txt` disallows crawling. The marketing site alone owns sitemap, canonical URLs, indexable landing pages and social metadata.

---

## 10. Testing

### 10.1 Levels

| Level | Covers | Where | Proportion |
|---|---|---|---|
| **Unit** | pure functions in `lib/utils` and `features/*/lib` | beside the file | ~30% |
| **Hook** | custom hooks, with faked API responses | `features/*/__tests__/` | ~25% |
| **Component** | rendering and interaction, via Testing Library | `features/*/__tests__/` | ~40% |
| **End-to-end** | the two full user journeys | `tests/e2e/` | ~5% |

### 10.2 The rule for component tests

**Test what a user experiences, not how the component is built.**

- Query by role, label and text — the way a user and a screen reader find things.
- Never query by CSS class or test id unless there is genuinely no accessible alternative.
- Never assert on internal state. Assert on what appears on screen.
- Mock at the network with MSW, not by stubbing modules. Then refactoring the API client does not break 40 tests.

The payoff: these tests survive refactoring. Tests coupled to implementation break every time you improve the code, and a suite that punishes improvement eventually gets deleted.

### 10.3 What every component test must cover

1. Renders with valid data.
2. Loading state.
3. Empty state.
4. Error state, including retry.
5. Every interaction — click, type, select — and its result.
6. Keyboard access: reachable by tab, activated by Enter or Space.
7. **Both languages**, for anything containing text.

### 10.4 Specific tests that must exist

| Area | Tests |
|---|---|
| Auth | login validation errors · a wrong password shows the generic message · an unverified email offers resend · redirect after login |
| Onboarding | grade options are the strings `"6"` to `"12"` · cannot continue without a subject · is resumable |
| Foxy | text appears while streaming · citation chips render and are clickable · abstention renders as an answer, not an error · cancel stops the stream · a dropped connection preserves partial text · a second send is blocked while streaming |
| Practice | one option selectable at a time · cannot submit before all are answered · the timer records per question · the result shows score and XP · an invalid attempt shows its reason |
| Progress | mastery bars reflect the data · empty state before any practice |
| Parent | snapshot numbers render · the digest shows the misconception and the action · the transcript is read-only · **the child's visibility indicator is always present** |
| Shared | every primitive renders each variant · `EmptyState`, `ErrorState` and `LoadingState` render correctly |

### 10.5 Coverage floors

| Area | Minimum |
|---|---|
| Pure functions in `lib/utils`, `features/*/lib` | **95%** |
| Feature hooks | 85% |
| Feature components | 80% |
| `components/ui` primitives | 90% |

### 10.6 End-to-end — exactly two specs

1. **Student:** sign up → verify → onboarding → ask Foxy → see a cited answer → practise → see the score → see progress.
2. **Parent:** sign up → enter the link code → child approves → see the snapshot → open the digest → view the transcript.

Keep it to two. End-to-end tests are slow and brittle, and a large suite of them stops being run. These two prove the product works.

---

### 10.7 CI gates — enforced numbers, not prose

The backend fails its build on a violated rule. The frontend must do the same, or every target in this document is decorative. **Each gate is proven by deliberately breaking it once**, exactly as the backend's gates were — a gate that has never failed is not known to work.

| Gate | Threshold | Fails the build when |
|---|---|---|
| Type check | — | any type error |
| Lint | — | any boundary violation, arbitrary Tailwind value, brand-colour literal, or user-facing string literal in JSX |
| Unit and component tests | coverage floors in 10.5 | below floor |
| **First-load JS, per route** | **≤ 180 kB gzipped** | any route exceeds it |
| **Shared chunk** | **≤ 120 kB gzipped** | exceeded |
| **Largest Contentful Paint**, Lighthouse CI, throttled 4G | **≤ 2.5 s** | exceeded |
| **Total Blocking Time** | **≤ 200 ms** | exceeded |
| **Accessibility** — `axe` on both E2E journeys | **zero serious or critical** | any violation |
| **Contrast** | WCAG AA, **both themes** | any pair below ratio |
| **Visual regression** | both journeys × 360 and 1280 px × both languages × both themes | any unreviewed diff |
| Route-group isolation | — | a feature imports another feature; `website/` and `frontend/` import each other |

**On the budgets.** 180 kB per route and 120 kB shared target a mid-range Android phone on 2–5 Mbps. They are starting values, not sacred — but a raise requires a recorded reason, the same discipline the backend applies to its caps. Silent drift is how a 4G-targeted app becomes unusable on 4G.

**On visual regression.** Sixteen renderings per screen cannot be reviewed by hand. Two journeys × two breakpoints × two languages × two themes is the minimum that catches a Hindi string overflowing a button or a parent-theme component that hard-coded purple.

## 11. Build order

Each step is usable before the next begins.

| # | Step | Done when |
|---|---|---|
| **0** | **Close the five foundation gaps FIRST**: auth/session strategy (5.5), error-code table (5.6), streaming approach (7), token values (9.1), CI gates (10.7). Roughly 3.75 days | Each is defined, and every CI gate has been proven to fail on a deliberate violation |
| 1 | Next.js, TypeScript, Tailwind, ESLint (with the boundary, no-literal-string, no-arbitrary-value and no-brand-literal rules), Vitest, Playwright, MSW | An empty test run passes |
| 2 | Design tokens; `components/ui` primitives — Button, Input, Card, Dialog, Skeleton, Badge | Each primitive has a test for every variant |
| 3 | `components/patterns` — EmptyState, ErrorState, LoadingState, PageHeader, StatCard, ConfirmDialog, FormField | All tested. **Do this before any screen** |
| 4 | `AppShell` — mobile bottom navigation, desktop sidebar, offline banner | Correct at 360 px and at 1280 px |
| 5 | i18n scaffold, both dictionaries, the language switch | Switching language re-renders every string |
| 6 | API client, query keys, providers, error boundary | A typed call to the backend succeeds and a 401 redirects |
| 7 | `auth` feature — signup, login, verify, reset | Full flow works against the real backend |
| 8 | `onboarding` feature | Grade, board and subjects persist |
| 9 | **`foxy` feature** — chat, streaming, citations, modes | Every case in Section 7 has a passing test |
| 10 | `practice` feature | Full cycle including timing capture |
| 11 | `progress` feature | Mastery view |
| 12 | `parent-dashboard` feature | Link, snapshot, digest, transcript |
| 13 | `billing` feature | Subscribe and status |
| 14 | Responsive pass on a real device, in both languages | No horizontal scroll anywhere, at any width, in either language |
| 15 | Accessibility pass; the two end-to-end specs | Both journeys pass |

**Steps 2, 3 and 4 feel slow and are not.** They are roughly two days that make every screen afterwards fast and consistent. Skipping them means every screen invents its own loading state, and the fifth screen costs more than the first.

---

## 12. Definition of done

A feature is done when **all** of the following hold:

- No `any`. Every component has a typed props interface.
- No hand-written type for data the backend already defines.
- No literal user-facing string; every string comes from the dictionary, in both languages.
- Loading, empty and error states all exist and are all tested.
- Works at 360 px and at 1280 px, in both languages, with no horizontal scroll.
- Every interactive element is keyboard reachable and has an accessible name.
- Every interactive element is at least 44 by 44 pixels.
- Component tests cover the checklist in 10.3.
- Coverage meets the floor in 10.5.
- No component calls `fetch` or imports the API client directly.
- No feature imports from another feature.
- The page component is under 50 lines.
- Tested on a real phone, not only in an emulator.
