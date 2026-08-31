# Context — resume here

**Last session:** 26 August 2026. **The admin panel is built, running, and was
driven through a real browser.** Nineteen endpoints, ten screens, nothing
committed. Read `docs/superpowers/specs/2026-08-25-admin-panel-design.md` for
the design and D-401..D-403 in `docs/03-DECISION-LOG.md` for the decisions.

> **Two workstreams still.** Track A is the Foxxy product. Track B is the
> separate retrieval module in `D:\personal\agts-retrieval` (D-400).
> **30 August: Track B advanced substantially and Track A did not change.**
> Phases 0-2 are built and holdout-validated there — 8/8 unanswerable refused
> and 27/30 answered on unseen cases, citation completeness 96.3%, 0 lineage
> failures, 138 tests, corpus persisted in its own Postgres container. Still
> blocked on the client for *release*, not for construction: rights records
> (Q3), named pilot scope (Q1), holdout seal timing (Q2), §9 scope (Q5), two
> named adjudicators, and a Mathpix key. Start at `agts-retrieval/README.md`.

## The admin panel — new this session

**`admin/` is a third deployable**, beside `frontend/` and `website/`. Read-only
operations surface for one internal operator. It writes nothing: the admin
repositories contain no `insert`/`update`/`delete` and the `admin/no-writes`
lint rule fails the build if one appears.

**Run it** — full instructions in `admin/README.md`:

```
cd backend && docker compose -f docker/compose.yml up -d && npm run db:migrate
npm run dev                                # API on 4000
cd ../admin && npm install && npm run dev  # panel on 3002
```

**There is no signup.** Create the operator, sign in on the product app (3001),
then reload the panel — the API sets one cookie both apps read:

```
cd backend && npm run ops:admin-create -- --email=<addr> --name=<name>
cd backend && npm run ops:admin-revoke -- --email=<addr>   # demote + kill sessions
```

The password prints once. Operator sessions last 12 hours, not the 30 days a
learner's does.

## Key decisions

- **D-401** — `visit_id` on `chat_sessions` and `practice_sessions`, plus the
  `v_learner_activity` view. Answers "how many sittings was this", which a
  timestamp cannot.
- **D-402** — the panel. Gate answers **404, not 403**, so it is invisible
  rather than forbidden. PII masked **server-side** — no `email` field and no
  message `content` field exists on any admin response shape. Reveal is the one
  exception: closed field matrix, closed reason codes, audited, 30/hour.
  Admin deliberately bypasses `assertCanAccess` (it is cross-tenant by design);
  three things stand in for it — the gate, the audit row per read, and nothing
  writes.
- **D-403** — the audit of that work. Five indexes (every admin list was a
  sequential scan), 12-hour operator sessions, the reveal throttle,
  `ops:admin-revoke`, and a 500→400 fix for bodyless POSTs.

## Next steps

1. **Commit.** ~30 untracked paths including all of `admin/`. Nothing from this
   session is in git.
2. **Decide where the panel is exposed.** It runs locally today. `next.config.ts`
   already sends `noindex` and `no-store`, which is the posture, not the decision.
3. **Track A register** — item 53 (option letter prefixes, 984 rows) is still
   the next product item; see `PROGRESS.md` §7.

## Gotchas that cost time this session

- **Backticks inside a `sql\`\`` template literal** end the string. SQL comments
  in a tagged template must not contain them — it reads as a TypeScript syntax
  error hundreds of lines away.
- **A global `addContentTypeParser` breaks billing** (`FST_ERR_CTP_ALREADY_PRESENT`).
  `billing.routes.ts` installs a raw-body parser for the webhook HMAC and its
  comment says so. Map the error in `toAppError` instead.
- **`git checkout -- <untracked file>` silently does nothing**, so a bad edit
  survives what looks like a revert.
- **The app harness must build every module.** It omitted `admin`, so `/admin`
  requests hit Fastify's route-not-found and a whole suite passed vacuously.
