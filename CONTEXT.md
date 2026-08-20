# Context — resume here

**Last session:** 20 August 2026. **The product runs end to end.** Foxy answers
from the corpus on a real model, mail is delivered through Google Workspace, and
the whole student journey has been driven through a browser with the database
checked either side. Read `PROGRESS.md` §2 for the verified picture and §7 for
the ranked issue register; this file is the 30-second version.

## Current task

**Adaptive practice difficulty is MERGED to master** (20 August, merge commit
`436f556`, 14 commits, branch deleted). A session serves one question at a time
and the difficulty moves on the answers actually given — up on two quick correct
answers, down on one wrong or two slow, unmoved by anything under three seconds.
Both suites green on the merged result: backend 3,261 + 349 integration,
frontend 508.

**In progress: item 53, the option letter prefixes.** Design agreed, nothing
written yet. Strip `^[A-D][).]\s*` inside `question-eligibility.ts` (before the
distinctness check, so future imports reject what it reveals), then a one-off
idempotent script over the 984 affected rows. **Two questions the prefix was
hiding must be deactivated, not deleted** — see item 53 in the register for
both. The write against live data had not run as of this note.

**Then, in cost order:** item 54 (study → practice → Foxy pass the chapter,
0.5 d, design agreed 20 August), item 55 (Foxy reads mastery and the mission
engine, 1-1.5 d, carries a copy decision), item 56 (tag questions to concepts,
2-3 d), item 49 (`questions` has no `hint_level_*` and no `question_hi` columns).

**Blocked on the client:** item 57, the ingestion pipeline. The corpus is
mathematics and science, grades 6-10, and nothing else. Whether that is the
pilot scope decides whether item 57 is urgent or Phase 2.

## How to run it

```
# 1. database and cache (the Foxxy ones — `backend-postgres-1` is another project)
cd backend && docker compose -f docker/compose.yml up -d

# 2. backend, with the origin the frontend container uses
APP_URL=http://localhost:3001 CORS_READ_ORIGINS=http://localhost:3001 \
  CORS_WRITE_ORIGINS=http://localhost:3001 npm run dev

# 3. frontend
docker build -f frontend/Dockerfile -t foxxy/frontend:local \
  --build-arg NEXT_PUBLIC_API_URL=http://localhost:4000 frontend/
docker run -d --name foxxy-fe -p 3001:3000 foxxy/frontend:local
```

Then **http://localhost:3001**, sign in as `demo@alfanumrik.com` /
`DemoPassw0rd!2026` (grade 10, both subjects, verified).

**`npm run ops:status`** reports what is wired, what has data, and what is still
a fake. Run it before believing anything in this file.

## Key decisions from this session

- **A session serves one question at a time, chosen as it goes** (D-384). A
  frozen set drawn at `startSession` cannot adapt to the answers it exists to
  adapt to — `AnswerResult.questionCount` is the target, `SubmissionResult`'s
  is what was actually served, and they differ only when a chapter runs dry.
- **The ladder is replayed from the session's answers, never stored** (D-385).
  Two qualifying answers step it up, one wrong or two slow step it down, and
  the three-second floor is not negotiable — `anti-cheat.ts` already zeroes an
  attempt for exactly that behaviour.
- **`time_target_ms` is frozen onto the response** (D-386), so retuning
  `TIME_TARGET_MS` cannot rewrite what "fast" meant for an answer already on
  the books. The pace query lives in `PROGRESS.md` beside the practice section.
- **A profile you can edit, and a header that reads it** (D-379). The PATCH
  sends only the fields that changed; a 404 is unfinished onboarding, not a
  failure; `ProductShell` takes an `identity` SLOT because a server component
  cannot read the session cookie.
- **The dashboard is live and the week strip is gone** (D-380). No endpoint
  carries a streak, so the decoration was deleted rather than faked.
- **Saving a language switches the interface** (D-381), one direction only —
  the header switch is per-device and still does not write the profile.
- **The browser suite got fixtures** (D-382). `stubStudentData` in
  `tests/e2e/support/session.ts`, frozen in time. All 14 visual baselines
  re-recorded; 126 browser checks pass.
- **Every "preview" claim is deleted** (D-383) — the banner, both role labels,
  the parent header name, and the dead `ProgressSummary`.
- **Guardian linking is code + OTP** (D-373). The old student-approval model
  could never complete — no endpoint gave a student the pending link's id.
- **The SSE route had no CORS headers** (D-377), so Foxy was blocked in every
  browser while all 3,220 tests passed. `app.inject` does not enforce CORS.
  Fixed, plus the repository's first real-socket test.
- **Study is subject → chapter → concept, in the URL** (D-378). Also fixes
  Foxy's subject dropdown defaulting to mathematics.
- **Change password requires the current one** (D-372), even with a live session.

## Gotchas that cost time

- **`LLM_API_KEY`, not `ANTHROPIC_API_KEY`.** The config names the PORT, not the
  vendor. The key was in `.env` under the wrong name for days.
- **`pg_stat_user_tables` is a stale estimate** — it reported 0 rows for tables
  holding thousands. Use `count(*)`.
- **The CORS allow-list and the CSRF origin allow-list are different lists**
  (D-082). Asserting against the wrong one makes correct code look broken.
- **`playwright --update-snapshots` can pass without rewriting anything**
  (D-383). Delete `visual.spec.ts-snapshots/` and regenerate, then run clean.
- **A test fixture must satisfy the response schema.** `apiRequest` validates
  everything; a non-UUID id in a fixture renders as "nothing works".
- **Signup is rate limited 3/hour per IP.** Clear it in dev with
  `docker exec foxxy-valkey valkey-cli FLUSHALL`.
- `next build` still only works in the container.
- `frontend;C` in the repository root is an empty stray directory. Delete it.
