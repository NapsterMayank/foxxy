# Context — resume here

**Last session:** 14 August 2026. Frontend build-order **step 9 is closed** — the
Foxy chat UI is built, wired and tested. Read `PROGRESS.md` §5 for the detail;
this file is the 30-second version.

## Current task

**Next: build-order steps 10-11 — practice and progress.** Both student
dashboards still render fixtures. Step 12 (parent) and 13 (billing) follow.
`GET /foxy/sessions` is written and unused — there is no session list screen yet.

## Key decisions from this session

- **A completed turn marks the transcript stale WITHOUT refetching it**
  (`refetchType: 'none'`). Stored history and live messages are concatenated,
  never merged, and deduplication is impossible — a user message has no server
  id, ever. Freezing the history instead is refused by two lint rules, both
  right (D-351).
- **The open conversation lives in the URL**, `?session=<id>`, written with
  `router.replace`. §7 asks that a refresh show the same history; with the id in
  `useState` a refresh strands the turns on the server (D-352).
- **The action buttons and their labels come from the server**, never from the
  generated `FOXY_ACTIONS`. A test asserts an action this build has never heard
  of still renders (D-353 covers the third find — a failed *start* was reporting
  an interrupted *answer*).

## Next steps

1. Steps 10-11 — practice, then progress.
2. **Run the browser suite against `/student/foxy`.** It has never seen this
   screen: port 3000 is held by `backend-api-1` and `playwright.config.ts`
   hardcodes `baseURL` to it. No visual baseline exists for the route yet.
3. Still blocked on the owner: `LLM_API_KEY`, `VOYAGE_API_KEY`, **GitHub Actions
   billing** (every run is `startup_failure`, account-level), Foxy caps.

## Gotchas that cost time

- The Foxy contract declares its RESPONSES as interfaces, not Zod schemas —
  nothing on the server parses them. `apiRequest` needs a schema, so they live in
  `features/foxy/api/foxy-responses.ts` pinned with `satisfies z.ZodType<...>`.
- A lint rule refusing both spellings of an idea (ref, and state-plus-effect)
  usually means the idea is in the wrong file. It was — see D-351.
- `next build` still only works in the container. `docker build -f
  frontend/Dockerfile`, then `docker run`.
- `frontend;C` in the repository root is an empty stray directory from a
  mistyped command. Untracked; delete it.
