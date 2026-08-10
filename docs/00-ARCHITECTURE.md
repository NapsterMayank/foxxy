# Alfanumrik / Foxxy — System Architecture

**Read this first.** The backend and frontend plans assume everything here.

| | |
|---|---|
| Product | Alfanumrik — AI-powered CBSE learning platform, grades 6-12 |
| Flows | Student, Parent |
| Core capability | Foxy — NCERT-grounded RAG AI tutor with citations |
| Brand | Alfanumrik is the platform · Foxy is the AI tutor · Foxxy is the repository name |
| Repo layout | `backend/` (Node + Fastify API) · `frontend/` (product Next.js) · `website/` (marketing + CMS) · `docs/` |
| Team | 1 engineer |

---

## 0. Third-party policy — read before adding any dependency

**Governing rule: nothing external sits in the request path, and nothing external holds our data at rest.**

Everything is self-hosted unless it appears in the approved table below. There are exactly three exceptions, each explicitly approved, each behind a port so it can be replaced.

### Approved external services

| Service | Why it cannot be self-hosted | What it can see | Replaceable |
|---|---|---|---|
| **Language model API** | The only external call in a user request. Self-hosting a model good enough to tutor in Hindi requires a GPU node and delivers lower quality today | The student's question and the retrieved textbook passages. **Never** a name, email, phone number, or account identifier | Yes — one adapter file behind `platform/llm`. Self-hostable later with no application change |
| **Voyage** (query embeddings) | Could be self-hosted, and the port supports it. Not worth doing: the existing 16,000-chunk corpus is already embedded with `voyage-3`, so using it avoids re-embedding and preserves already-validated retrieval quality. Cost is roughly ₹30 per month at launch volume, with no infrastructure | The student's question text only, around 20 tokens. No identity, no context | Yes — swap to the self-hosted BGE-M3 adapter behind `platform/embed`. Requires a one-time re-embed of the corpus |
| **Resend** (email) | Self-hosted mail servers suffer severe deliverability failure. Verification emails would silently not arrive, breaking signup | Recipient address and message body | Yes — one adapter behind `platform/mail` |
| **Razorpay** (payments) | Payment processing is regulated. There is no self-hosted route to INR subscriptions or UPI | Payment and billing data only | No |

Unavoidable and not services in any meaningful sense: the hosting provider, the domain registrar, and a TLS certificate authority.

### Self-hosted, no exceptions

| Concern | Component |
|---|---|
| Database, vector search, full-text search | PostgreSQL 16 + pgvector |
| Embeddings | Voyage `voyage-3` today; the self-hosted BGE-M3 adapter exists behind the same port as an exit route |
| Authentication and sessions | Our own tables, Argon2id, opaque tokens |
| Cache and rate limiting | Valkey |
| Object storage | MinIO, or local disk at launch |
| Background jobs | Postgres-backed queue |
| Logging, metrics, error tracking | Our own database and containers |
| Web application firewall, TLS, rate limiting | Caddy or Traefik on our own host |
| Analytics | Product events in our own database; marketing traffic in self-hosted GoatCounter aggregate mode |

### Explicitly rejected

Supabase and any managed backend · Firebase · hosted vector databases · hosted reranking APIs · Cloudflare or any external CDN or edge proxy · hosted object storage · SaaS observability · third-party analytics or session recording.

### Supabase, specifically

The old system runs on Supabase. **We connect to it exactly once, to export four content tables, and never again.** No Supabase client library is installed, no `@supabase/*` package appears in `package.json`, and no code in this repository is aware that Supabase ever existed. Section 6 covers that one-time export.

### What replaces Supabase

Supabase is not one product. It is five bundled together, which is why "replace Supabase" sounds larger than it is. Taken apart, each piece has a direct answer.

| Supabase provided | We use | Where it is specified |
|---|---|---|
| Postgres database | **Postgres.** Supabase *is* Postgres with a wrapper around it | Backend plan, Section 4 |
| Auth (GoTrue) | Our own `users` and `sessions` tables, Argon2id, opaque tokens | Backend plan, Section 6 |
| Auto-generated REST API (PostgREST) | Our Fastify routes | Backend plan, Section 8 |
| Edge Functions | Our Fastify backend and job worker | Backend plan, Section 2 |
| Storage buckets | Local disk at launch; MinIO when file volume justifies it | Section 0, self-hosted table |
| Realtime subscriptions | Not required. Server-sent events cover Foxy streaming | Backend plan, Section 8.5 |
| Dashboard | Drizzle Studio, TablePlus, or pgAdmin | — |

Everything runs as containers on one host:

```
one VPS -> docker compose:
    product postgres + pgvector | CMS postgres | valkey | backend (Fastify)
    product frontend (Next.js) | static marketing site | Payload CMS | GoatCounter | caddy
```

Approximately ₹6,000 to ₹8,000 per month, total, at launch scale. That is less than a managed backend subscription, with full control and no data leaving the machine.

Because Supabase runs standard Postgres, exporting the corpus is an ordinary `pg_dump`. There is no proprietary format and no lock-in on the data — which is what makes the one-time export in Section 6 straightforward.

### Before adding any dependency, answer these

1. Can this be done with Postgres, or with code we already have?
2. If it is external, does it sit in a user's request path? If yes, the answer is no.
3. Does it hold or see user data at rest? If yes, the answer is no.
4. If it must be added, what is the port interface, and what is the fallback when it is unavailable?

An addition that fails questions 2 or 3 requires explicit client approval, recorded in this document.

---

## 1. Why backend, product frontend, and marketing are separate

| | Consequence |
|---|---|
| **Gain** | Backend is reusable by the future mobile app with zero change. Independent scaling and deployment. Clear contract boundary forces discipline |
| **Cost** | Two deployables, two pipelines, a serialisation seam, and duplicated type definitions if you are careless |

**The cost is neutralised by one rule:** all request and response types live in `backend/src/shared/contracts/` as Zod schemas, and the frontend imports the inferred TypeScript types from there. One definition, two consumers. **Never hand-write a type on the frontend that the backend already defines.**

`frontend/` is the authenticated product at `app.<domain>`. `website/` is the independently deployed marketing/CMS subsystem at the main domain. Marketing content, dependencies, deployments and runtime failures must not enter the product build or request path. The complete boundary, cookie/CORS mechanics, static publishing model and pipeline ownership are specified in `06-FRONTEND-SEPARATION-PLAN.md` and recorded by D-080.

---

## 2. Should Foxy be a separate folder?

**Yes — as a first-class module inside the backend. No — not as a third top-level folder.**

```
backend/src/modules/foxy/          <- Foxy lives here
backend/src/modules/retrieval/     <- search, deliberately separate from Foxy
```

**Why a module and not a service (yet):**

- A separate service now costs you network hops, a second deployment, distributed tracing and duplicated auth — for zero benefit at current scale.
- Foxy needs synchronous access to `learner` (the student's grade) and `content` (chapter metadata). Across a network that becomes latency you cannot get back.
- A single engineer maintaining two deployables is a permanent tax.

**Why it is still a separate module:**

- Foxy has a different scaling curve to everything else. It is the first thing that will need to be extracted.
- Because callers only ever import `modules/foxy/index.ts`, extraction later means replacing the body of that one file with an HTTP client. Nothing else in the codebase changes.

**Why `retrieval` is split out from `foxy`:** search is also used by practice-question selection and, later, by teacher tooling. Foxy is one consumer of retrieval, not its owner. Keeping them apart means you can improve search without touching prompts, and change prompts without touching search.

**The extraction trigger, written down now so it is not a judgement call later:** move Foxy to its own service when p95 chat latency is degraded by resource contention with ordinary API traffic, **or** when the process needs to scale independently more than twice as fast as the rest. Not before.

---

## 3. The four foundations

Everything else is negotiable. These are not — they are what let the system grow without a rewrite.

### Foundation 1 — Module boundaries are mechanical

Every module exposes exactly one public file, `index.ts`. Anything else inside it is private.

```
modules/<name>/
  index.ts              the ONLY file another module may import
  <name>.routes.ts      HTTP layer
  <name>.service.ts     use-cases and orchestration
  <name>.repository.ts  database access
  <name>.schema.ts      Zod validation schemas
  domain/               pure business logic, zero I/O
  __tests__/            unit tests living next to the code
```

Enforced by an ESLint `no-restricted-imports` rule that rejects any path matching `modules/*/!(index)`. A rule, not a habit. When it fires, the answer is either "call the public function" or "this belongs in a shared place" — never "add an exception".

### Foundation 2 — Dependencies point one way

```
app  ->  modules  ->  platform
                 ->  shared
```

- `platform/` never imports `modules/`. If you feel the need, the logic belongs in a module.
- `shared/` imports nothing. It is types and constants only.
- Modules may import other modules **only through `index.ts`**, and only along edges declared in Section 4.
- `domain/` folders import nothing outside their own module. This is what makes business logic testable without a database.

### Foundation 3 — External systems sit behind ports

The database, language model, embedding service, cache, mailer and payment gateway are each reached through an interface in `platform/`. Modules depend on the interface, never on a vendor SDK.

Two payoffs: swapping a vendor is one file, and unit tests substitute a fake with no mocking library and no network.

### Foundation 4 — Every behaviour has a test, written with it

Not "tests at the end". A feature is not done until its tests pass. Details in the backend and frontend plans.

---

## 4. Module map and permitted dependencies

| Module | Owns | May call |
|---|---|---|
| `identity` | Users, credentials, sessions, parent-child links | — |
| `learner` | Student profile, grade, subjects, mastery | `identity` |
| `content` | Syllabus, chapters, question bank | — |
| `retrieval` | Hybrid search over NCERT chunks, ranking, abstention | `content` |
| `foxy` | Chat sessions, modes, prompts, citations, traces | `retrieval`, `learner`, `content` |
| `practice` | Quiz sessions, scoring, XP, progress | `content`, `learner` |
| `parent` | Snapshot, weekly digest, transcript access, consent | `learner`, `practice`, `foxy`, `identity` |
| `billing` | Subscription, payment verification, entitlements | `identity` |
| `notify` | Email and in-app notifications | — |

**No cycles.** If you need one, the shared concept belongs in a lower module or in `platform/`.

---

## 5. What we reuse from the existing Alfanumrik repository

Located at `D:\personal\alfanumerik\Alfanumrik`. The existing codebase is not being extended — it is being **harvested**. Take the assets, leave the plumbing.

### Take as-is — highest value

| Asset | Where it is now | Why it matters |
|---|---|---|
| **NCERT corpus** — approx. 16,000 chunks covering 750 of 761 chapters | `rag_content_chunks` table | Months of ingestion work. Portable by database dump. **This is the single most valuable thing you own** |
| **Embeddings already computed** | same table, `vector(1024)`, model `voyage-3` | **No re-embedding required.** Restore the table, build an HNSW index, and search works on day one |
| **Full-text search vectors** | `search_vector tsvector` | The keyword half of hybrid search arrives pre-built |
| **Full-text search vectors** | same table, `search_vector tsvector` | The keyword half of hybrid search arrives pre-built |
| **Question bank + CBSE syllabus** | `question_bank`, `cbse_syllabus` | Content, not code |
| **XP and scoring rules** | `packages/lib/src/xp-rules.ts` | Pure logic, no I/O. Copy into `modules/practice/domain/` |
| **Retrieval evaluation harness** | `eval/rag/harness/` | Golden set, metrics, verdict logic. Port the concepts |

### Take the idea, rewrite the code

| Asset | Why it cannot be copied |
|---|---|
| `packages/lib/src/ai/retrieval/ncert-retriever.ts` | The ranking approach (hybrid + rank fusion + quality floor) is sound and worth studying. The implementation is bound to Supabase RPCs and a service-role client. Rewrite against Drizzle; keep the algorithm |
| Foxy prompt design | Extract the prompt content from `apps/host/src/app/api/foxy/route.ts`. Do not copy the route — 3,318 lines is what accumulated dual code paths look like |
| Razorpay flow | The webhook-verification and idempotency reasoning is correct. The Supabase plumbing is not |

### Do not take

Supabase client code and RLS policies · the 510-file migration history · the re-export stub layer · feature-flag sprawl · the super-admin surface · anything importing `@supabase/*`.

### Lessons the old repo paid for — do not repeat them

| Mistake | Rule for this repo |
|---|---|
| Two retrieval paths (a "primary" and a "legacy fallback") that drifted apart | **One code path.** Configuration changes parameters, never which code runs |
| Similarity thresholds guessed, then calibrated a year later after silently filtering every result | **Every threshold is measured before it ships**, and the measurement is recorded next to the constant |
| Hand-maintained counts in documentation that drifted from reality | **Documentation states rules, never counts.** Anything countable is generated by a script |
| Path-based enforcement rules that matched nothing after a directory move | **Every rule is verified to fire.** A rule that has never failed is not known to work |
| A 3,318-line route file | **Route handlers stay under 100 lines.** They validate, call a service, and format a response |

---

## 6. Corpus migration — do this on day one

Not day five. Everything downstream depends on it, and it is the only step gated on something you do not control — read access to the old database. This is a **one-time export**. Once the four tables are dumped, the old system is never contacted again and nothing in the new codebase knows it existed.

1. Obtain read credentials for the existing production database.
2. Dump the four content tables: `rag_content_chunks`, `question_bank`, `cbse_syllabus`, and any chapter metadata table they reference.
3. Restore into the new Postgres instance, with the `vector` extension enabled first.
4. **Keep the existing embeddings.** They were produced by `voyage-3` at 1024 dimensions, and the query path uses the same model, so the vector space matches. No re-embedding.
5. Build the HNSW index on the embedding column and a GIN index on the tsvector column.
6. **Verify before moving on:** run one vector similarity query and one full-text query by hand. Confirm both return sensible rows for a real question.

If step 1 is blocked, the entire schedule is blocked. Establish access before anything else.

---

## 7. Scaling path

The same codebase carries you through all four stages. Nothing here requires a rewrite.

| Stage | Load | Change |
|---|---|---|
| 0 | Launch | One application process, one database. Backend and frontend on one host |
| 1 | ~1k daily users | Split background jobs into their own process. Add a Redis-compatible cache. Add a read replica |
| 2 | ~10k | Multiple stateless backend replicas behind a load balancer. Partition high-volume tables (Foxy messages, quiz responses) by month. Tune HNSW search parameters |
| 3 | ~50k+ | Extract `modules/foxy` into its own service. Its callers already use only `index.ts`, so nothing else changes |

**Stateless from day one, without exception:** no in-memory sessions, no in-memory rate-limit counters, no writing files to local disk. Sessions in Postgres, counters in the cache, files in object storage. Violate this once and horizontal scaling stops working — silently, and only under load.

---

## 8. How to read the rest of these documents

| Document | Contents |
|---|---|
| `01-BACKEND-IMPLEMENTATION-PLAN.md` | Folder structure, database schema, authentication in full detail, every module, testing strategy, build order |
| `02-FRONTEND-IMPLEMENTATION-PLAN.md` | Authenticated product frontend structure, components, state, testing and build order |
| `06-FRONTEND-SEPARATION-PLAN.md` | Marketing/product domain split, CMS publishing, transport rules, SEO and deployment isolation |
| `../PROGRESS.md` | **Current state, the single next action, and everything remaining. Read this first when resuming work.** |
| `03-DECISION-LOG.md` | **Every decision taken during implementation that these plans did not specify, or that contradicts them.** Read it before assuming a plan document is current. Open items and deliberate deferrals are listed at the end |

The plans are written to be followed step by step without prior context. Where a decision has a trap in it, the trap is called out rather than assumed to be obvious.
