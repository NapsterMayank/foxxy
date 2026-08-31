# Alfanumrik operations panel

The third deployable. `frontend/` is the product, `website/` is marketing, this
is operations — a read-only surface for one internal operator (D-402).

**It writes nothing.** The admin repositories contain no `insert`, `update` or
`delete`, and a lint rule fails the build if one appears.

---

## Run it

```bash
# 1. database and cache
cd backend && docker compose -f docker/compose.yml up -d
npm run db:migrate

# 2. the API
npm run dev                                # http://localhost:4000

# 3. this app
cd ../admin && npm install && npm run dev  # http://localhost:3002
```

No environment overrides needed. `.env.example` carries `:3002` in both CORS
lists as a committed default.

**If every screen shows a network error, it is CORS** — and an `.env` predating
this app will not have `:3002` in `CORS_READ_ORIGINS` and `CORS_WRITE_ORIGINS`.
Add it by hand. The failure is invisible from the server: the browser blocks the
request itself, so nothing reaches the API and the backend log stays clean while
every screen errors.

## Sign in

There is no signup. `SIGNUP_ROLES` is `student|parent` and always will be — a
signup path that could mint a `super_admin` is a privilege-escalation hole with
a form in front of it. The account is created by somebody with a database
credential and in no other way:

```bash
cd backend
npm run ops:admin-create -- --email=ops@example.com --name="Ops"
```

The password is **generated and printed once**. Copy it, sign in at
`http://localhost:3001/login`, and change it through the ordinary
`/auth/change-password` route. Nothing stored it but the Argon2id hash.

To take the role away again — revoking every session it holds:

```bash
npm run ops:admin-revoke -- --email=ops@example.com
```

**Operator sessions last 12 hours**, not the 30 days a learner's does. A cookie
that reads every learner record in the product is worth hours, not weeks.

## What you will see

| Screen | What it answers |
|---|---|
| Overview | counts, what is firing, what is not being measured |
| Monitoring | every signal beside the threshold that would fire on it, the rules, and a dry run |
| Jobs / Workers | queue depth, dead letters, backlog age, heartbeats |
| Users | accounts, masked; one learner's day split into visits |
| Practice / Foxy | sessions, and the shape of a conversation that went wrong |
| Billing / Audit | subscriptions, and the record — including your own reads |
| Content coverage | where the corpus is thin |

### The dry run cannot page anybody

`Monitoring → Run` executes a real collection cycle against the live database
and shows what **would** fire. No dispatcher is constructed in that path, so
there is no code route from it to a channel. The response carries
`delivered: false` and the screen says so.

### Masking

Emails, learner names and message text are masked **on the server**. There is no
`email` field and no message `content` field on any admin response shape — not a
masked one, none. A client-side mask would leave the real value in the network
tab, the response cache, and any HAR file attached to a bug report.

To see a real value, use **Reveal**. It asks for a reason from a closed set,
returns only the field you asked for, and writes an audit row naming you, the
resource, the field and the reason — never the value. Reveals are limited to
**30 per hour per operator**: an audit trail records enumeration, it does not
prevent it.

There is deliberately **no Reveal control in any list**. A disclosure button
repeated fifty times down a page gets clicked without a decision behind it, and
every click writes a row asserting a decision nobody made.

## Gates

```bash
npm run gates    # typecheck, lint, contracts drift, isolation, tests
```

`contracts:check` proves `src/lib/api/generated/` still matches
`backend/src/shared/contracts/`. Never edit a generated file — run
`npm run contracts:sync` and commit the result.

`check:isolation` proves this app imports nothing from `frontend/`, `website/`
or `backend/`. The three images are built from their own directories alone, so a
crossing import type-checks, lints, passes tests and fails in Docker.

## Not yet decided

**Where this is exposed.** It runs locally against the development database
today. Public routing is a separate decision — `next.config.ts` already sends
`X-Robots-Tag: noindex` and `Cache-Control: no-store`, which is the posture it
would need, not a substitute for the decision.
