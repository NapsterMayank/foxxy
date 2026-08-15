# Context — resume here

**Last session:** 17 August 2026. Frontend build-order **step 13 is closed —
every feature step is done.** Steps 0-13 complete. Read `PROGRESS.md` §5 for the
detail; this file is the 30-second version.

## Current task

**Next: steps 14-15 — the responsive pass on a real device, the accessibility
pass, and the two end-to-end specs.** Both need the browser suite, which has
never run: port 3000 is held by `backend-api-1` and `playwright.config.ts`
hardcodes `baseURL` to it. Stop that container or give the config an env
override. Every visual baseline is stale and none of the five live screens has
one at all — open item 46, and it needs a human to approve the new look.

## Key decisions from this session

- **The plan catalogue is served** (D-364). `PLANS` lives in the module, so a
  billing screen could only hard-code "₹299" or show nothing. A hard-coded price
  is not a broken button — it is advertising one figure and charging another.
  `GET /billing/plans` was added to the backend for this.
- **One unknown entitlement must not take down the pricing page** (D-365). As a
  closed enum, a single unrecognised feature rejected the whole catalogue. The
  feature list is parsed as strings; everything that decides money stays strict.
- **A 409 on subscribe means "you already have it", never "try again"** (D-367).
  The thing a customer would retry is a payment.

## Next steps

1. Steps 14-15. Then the backlog in §7 — items 41-47 are the frontend ones.
2. **Run the browser suite** — see above. It has never seen `/student/foxy`,
   `/student/practice`, `/student/progress`, `/parent` or `/parent/billing`.
3. Still blocked on the owner: `LLM_API_KEY`, `VOYAGE_API_KEY`, **GitHub Actions
   billing** (every run is `startup_failure`, account-level), Foxy caps, and a
   **Razorpay account** — no real checkout has ever been completed, so the whole
   payment path is exercised only against the deterministic fake (item 19).

## Gotchas that cost time

- Leniency belongs only where the data is presentational. The billing catalogue
  parses `features` loosely and `amountMinorUnits` strictly, on purpose.
- Almost no parent- or billing-facing prose that describes one account lives in
  the dictionary — prices come from the server, and parent narrative arrives
  bilingual from the server.
- A lint rule refusing your idea twice usually means the idea is in the wrong
  file — true for the transcript freeze (D-351) and the cross-feature import
  (D-356).
- `next build` still only works in the container. `docker build -f
  frontend/Dockerfile`, then `docker run`.
- `frontend;C` in the repository root is an empty stray directory from a
  mistyped command. Untracked; delete it.
