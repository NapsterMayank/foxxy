# Context — resume here

**Last session:** 15 August 2026. Frontend build-order **steps 10 and 11 are
closed** — practice and progress are live. Steps 0-11 are all done. Read
`PROGRESS.md` §5 for the detail; this file is the 30-second version.

## Current task

**Next: build-order step 12 — the parent dashboard.** `ChildSummary` exists as a
fixture component; the `parent` module has six live endpoints (children,
snapshot, digest, transcript, consent). Step 13 (billing) follows. The student
dashboard is still fixtures too — open item 45, and it is wiring rather than
design, because the mission and XP it should show are already on the wire.

## Key decisions from this session

- **`EvidenceLabel` takes the wire code and is translated** (D-354). It used to
  take a hand-written union of English strings and render them directly, so a
  Hindi reader saw "Strong evidence" on their own progress. `src/types/
  learning-evidence.ts` is deleted.
- **Ownership of a wire call follows the caller, not the URL prefix** (D-356).
  `/practice/progress` and `/practice/history` live in `features/progress/api`
  because both their readers are that screen. The boundary lint rule caught the
  first arrangement and was right.
- **"4 of 6", never "67%"** (D-357). `scorePercent` is on the wire and is never
  rendered — a session score and a mastery percentage are indistinguishable to a
  child, and §9.1 forbids the second.

## Next steps

1. Step 12 — the parent dashboard, then step 13 — billing.
2. **Run the browser suite.** It has never seen `/student/foxy`,
   `/student/practice` or `/student/progress`: port 3000 is held by
   `backend-api-1` and `playwright.config.ts` hardcodes `baseURL` to it. No
   visual baseline exists for any of the three, and D-354 moved the evidence
   badges on the two baselines that do exist.
3. Still blocked on the owner: `LLM_API_KEY`, `VOYAGE_API_KEY`, **GitHub Actions
   billing** (every run is `startup_failure`, account-level), Foxy caps.

## Gotchas that cost time

- The generated `EVIDENCE_LABELS` order is DECLARATION order (`strong` first),
  not an ordering of strength. A step bar built from it fills backwards — see
  `features/progress/lib/evidence-order.ts`.
- A lint rule refusing your idea twice usually means the idea is in the wrong
  file. That was true for the transcript freeze (D-351) and for the cross-feature
  import (D-356); both times the comment explaining the exception was the tell.
- `next build` still only works in the container. `docker build -f
  frontend/Dockerfile`, then `docker run`.
- `frontend;C` in the repository root is an empty stray directory from a
  mistyped command. Untracked; delete it.
