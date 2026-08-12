# Context — resume here

**Last session:** 12 August 2026. Frontend build-order steps 0, 1-5 and 6 closed.
Read `PROGRESS.md` §2 for the full picture; this file is the 30-second version.

## Current task

Frontend. The data layer, the shared components, the CI gates and i18n are done.
**Next: build-order steps 7-8 — wire the auth and onboarding screens to the live
client.** They are still presentational: they prevent default, set a local
"preview complete" message, and call nothing.

## Key decisions from this session

- `GET /api/v1/auth/me` is the session bootstrap. `/me/profile` cannot be — a
  parent gets 403 and an un-onboarded student 404, and neither carries the role.
- No `proxy.ts` cookie check. The session cookie is host-bound to the API, so the
  Next server never sees it; a presence check would bounce every signed-in user.
- Backend contracts are GENERATED into `frontend/src/lib/api/generated/` and
  committed. Run `npm run contracts:sync` after any backend contract change or
  the drift test fails.

## Next steps

1. Steps 7-8: mutations for signup/login/verify/reset and onboarding, 400 field
   errors onto `FormField`, honour `?next=` after sign-in.
2. Step 9: the Foxy chat UI on top of `useFoxyStream` (the hook and its seven
   §7 cases are already done and tested).
3. Still blocked on the owner: `LLM_API_KEY`, a git remote (CI has never run),
   and confirming the Foxy caps. See `PROGRESS.md` §2.

## Gotchas that cost time

- `next build` dies at worker teardown on Windows (open item 33). `--webpack`
  fails identically, so the bundler is ruled out. No `.next/standalone/` locally.
- Never export a value from a `'use client'` module and read it on the server —
  it does not arrive as a string. That silently broke the language cookie read.
- An async server component nested inside another cannot be rendered in a test.
  One `await` per tree; pass the translator down.
