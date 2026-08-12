# Context — resume here

**Last session:** 12 August 2026. Frontend build-order steps 0-8 closed, and the
build blocker (open item 33) turned out to be the Windows host, not Next.
Read `PROGRESS.md` §2 for the full picture; this file is the 30-second version.

## Current task

**Next: build-order step 9 — the Foxy chat UI on `useFoxyStream`.** The hook and
its seven §7 cases are already done and tested; only the UI is missing. Steps
10-13 (practice, progress, parent, billing) follow; both dashboards still render
fixtures.

## Key decisions from this session

- **Build in the container, not on Windows.** `docker build -f frontend/Dockerfile`
  produces `.next/standalone`; `docker run -p 3000:3000` then serves it for
  Playwright and Lighthouse. Nothing in the app was ever broken.
- **Field errors come from the generated request schemas.** The wire envelope is
  `{ error: { code, message } }` and drops `details`, so no field is named on a
  400 — validating with the backend's own copied schema is the only route to
  §5.6's "map onto the form", and the rules cannot drift.
- **A 401 from `POST /auth/login` is a credential verdict, not an expired
  session.** `ApiError` carries the request path so `providers.tsx` can tell them
  apart; without it a wrong password cleared the query cache.

## Next steps

1. Step 9 — the Foxy chat UI.
2. Items 41-43: the bundle gate reads a manifest Next 16.3 no longer emits; LCP
   is ~370 ms over budget on two auth screens; four dashboard baselines are stale
   and need a human before re-recording.
3. Still blocked on the owner: `LLM_API_KEY`, **GitHub Actions billing** (every
   run is `startup_failure`, account-level), and confirming the Foxy caps.

## Gotchas that cost time

- Piping a long build or test run through `tail` throws away the error that
  matters. Write the full log to a file, then grep it.
- Never export a value from a `'use client'` module and read it on the server —
  it does not arrive as a string. That silently broke the language cookie read.
- An async server component nested inside another cannot be rendered in a test.
  One `await` per tree; pass the translator down.
- `frontend/.gitattributes` now forces LF. Without it the generated contracts
  check out as CRLF on Windows and the drift test calls every file stale.
