# Context — resume here

**Last session:** 18 August 2026. Build-order **step 14 is closed**, and — the
bigger news — **the browser suite finally runs.** It had been blocked for six
days by one hardcoded line. Read `PROGRESS.md` §5; this file is the 30-second
version.

## Current task

**Next: step 15 — the accessibility pass and the two end-to-end specs.** It is
the last step in the build order. `foundation.spec.ts` already runs axe over
twelve routes with no serious or critical violations, so the pass is narrower
than it looks; §10.6's "exactly two specs" are the student journey and the
parent journey, end to end.

**Then the twelve stale visual baselines** (open item 46) — they need a human to
approve the new look before re-recording, and none of the five newest routes has
a baseline at all.

## Key decisions from this session

- **`PLAYWRIGHT_BASE_URL` and `PLAYWRIGHT_NO_SERVER`** (D-369). Port 3000 is
  held by `backend-api-1`, and the config hardcoded it — so running the suite
  meant stopping the backend. Run it with:
  `docker run -d --name foxxy-fe -p 3001:3000 foxxy/frontend:step14b` then
  `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 PLAYWRIGHT_NO_SERVER=1 npx playwright test`
- **The 44px rule is measured on the activation area** (D-370). A label-wrapped
  checkbox is measured by its label; an unwrapped 16×16 control still fails.
- **The image build downloads Google Fonts at build time** (D-371, item 48).
  Two builds failed on a network blip and passed unchanged on retry. Retry
  before debugging.

## Next steps

1. Step 15 — accessibility pass, two end-to-end specs.
2. Item 46 — the visual baselines, with a human.
3. Still blocked on the owner: `LLM_API_KEY`, `VOYAGE_API_KEY`, **GitHub Actions
   billing** (every run is `startup_failure`, account-level), Foxy caps, a
   **Razorpay account** (no real checkout has ever completed).

## Gotchas that cost time

- A suite that cannot run hides defects in commits that pass every other gate.
  Three touch-target faults and one stale assertion had been sitting in `main`.
- Set the language cookie for the URL under test, not a constant — a cookie is
  set FOR an origin, and the wrong one silently tests English.
- `next build` still only works in the container. `docker build -f
  frontend/Dockerfile`, then `docker run`.
- `frontend;C` in the repository root is an empty stray directory from a
  mistyped command. Untracked; delete it.
