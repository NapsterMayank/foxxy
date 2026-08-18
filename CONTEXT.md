# Context — resume here

**Last session:** 19 August 2026. **The product runs end to end.** Foxy answers
from the corpus on a real model, mail is delivered through Google Workspace, and
the whole student journey has been driven through a browser with the database
checked either side. Read `PROGRESS.md` §2 for the verified picture and §7 for
the ranked issue register; this file is the 30-second version.

## Current task

**Next: the student dashboard — open item 51.** `/student` is the LAST fixture
screen. It shows `sampleProgress` and a hard-coded name while Learn, Practice,
Progress, Foxy, Parent and Billing all read live data, and it is the first screen
a client sees after login. It is also where "continue where you left off" belongs:
`/practice/progress` already carries `lastPractisedAt` per chapter.

The one open design question is where that read lives, since
`no-cross-feature-imports` stops the dashboard importing `features/progress`.
Resolve it the way D-356 did — ownership follows the caller.

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
- **A test fixture must satisfy the response schema.** `apiRequest` validates
  everything; a non-UUID id in a fixture renders as "nothing works".
- **Signup is rate limited 3/hour per IP.** Clear it in dev with
  `docker exec foxxy-valkey valkey-cli FLUSHALL`.
- `next build` still only works in the container.
- `frontend;C` in the repository root is an empty stray directory. Delete it.
