# Context — resume here

**Last session:** 16 August 2026. Frontend build-order **step 12 is closed** —
the parent dashboard is live and its fixtures are deleted. Steps 0-12 are done.
Read `PROGRESS.md` §5 for the detail; this file is the 30-second version.

## Current task

**Next: build-order step 13 — billing.** It is the last feature step, and the
last frontend blocker of substance: `billing.contract.ts` is generated, the
module is wired, and the Razorpay half is unproven against the live API because
no account exists (open item 19). Then steps 14-15 — the responsive and
accessibility passes, and the two end-to-end specs.

The student dashboard at `/student` is now the ONLY fixture screen in the
product — open item 45, and it is wiring rather than design.

## Key decisions from this session

- **The child-visibility notice renders before every branch** (D-359). §10.4's
  only bold requirement. It sits above the source/empty/populated fork so the
  two paths that show no conversation still carry it — a parent who looks, sees
  nothing and is told nothing is the case the rule exists for.
- **A 403 means two things to a parent** (D-361). On a GET it is the child
  having revoked the link — a state, no retry offered. On the revoke POST it is
  a stale page. Confusing them is a false alarm about their own child.
- **Four queries, not one aggregate** (D-362). A failed panel still leaves the
  consent controls reachable, which is the one part of the page a parent must
  always be able to use.

## Next steps

1. Step 13 — billing. Then 14-15.
2. **Run the browser suite.** It has never seen any of the four live screens
   (`/student/foxy`, `/student/practice`, `/student/progress`, `/parent`): port
   3000 is held by `backend-api-1` and `playwright.config.ts` hardcodes
   `baseURL` to it. Every existing visual baseline is now stale — open item 46.
3. Still blocked on the owner: `LLM_API_KEY`, `VOYAGE_API_KEY`, **GitHub Actions
   billing** (every run is `startup_failure`, account-level), Foxy caps, and a
   Razorpay account before step 13 can be proven against anything real.

## Gotchas that cost time

- Almost no parent-facing prose lives in the dictionary. The summary, digest,
  suggested action, disclosure and consent notice all arrive from the server in
  BOTH languages, because they are sentences about one particular child.
- A lint rule refusing your idea twice usually means the idea is in the wrong
  file — true for the transcript freeze (D-351) and the cross-feature import
  (D-356). The comment explaining the exception was the tell both times.
- `next build` still only works in the container. `docker build -f
  frontend/Dockerfile`, then `docker run`.
- `frontend;C` in the repository root is an empty stray directory from a
  mistyped command. Untracked; delete it.
