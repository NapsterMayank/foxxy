# Roadmap — MVP and the First Year

**Update rule:** revised whenever a phase completes or scope changes, with the reason recorded. Estimates are in solo person-days. If a number here disagrees with `PROGRESS.md`, PROGRESS.md wins — it is measured, this is planned.

Last updated: **9 August 2026** · Track B note added **22 August 2026**

> **This roadmap covers TRACK A only** — the Foxxy product. **Track B**, the new
> retrieval module opened 21 August, has its own phase plan at
> `docs/superpowers/plans/2026-08-21-rag-build-guide.md` (~17-19 weeks, Phase 0
> not yet started). **The two are not additive on one person's calendar.** If
> both are live at once, this roadmap's solo-capacity arithmetic below is wrong
> and needs redoing against whoever actually staffs Track B.

---

## 1. At a glance

| Phase | Theme | Days | Solo weeks | Cumulative |
|---|---|---|---|---|
| **0** | **MVP** — student + parent, guided learning loop | 131 | 26 | ~6 months |
| **1** | Teacher experience | 26 | 5 | ~7.5 months |
| **2** | WhatsApp + voice — reach and accessibility | 35 | 7 | ~9 months |
| **3** | Mobile applications | 35 | 7 | ~11 months |
| **4** | School leadership, internal roles, content workflow | 59 | 12 | ~14 months |
| **5** | White-labelling and multi-tenancy | 30 | 6 | ~15.5 months |

**Solo capacity is roughly 250 days a year.** Year one therefore delivers **Phase 0 through Phase 2, and part of Phase 3.** Phases 4 and 5 need either a second engineer or a second year — state this plainly rather than promising twelve months of work in twelve months of one person's time.

With three engineers after the MVP, Phases 1 through 4 compress into roughly six months and the full list fits inside year one.

---

## 2. Phase 0 — MVP (in progress)

**Goal:** prove the closed learning loop end to end for one student and one parent.

```
Today's Mission → Concept Explanation → Guided Practice
→ Independent Mastery Check → Evidence-Based Decision
→ Progress or Recovery → Retention Scheduling
```

Six of the client's nine session steps. Prerequisite recall, prerequisite recovery and teacher alerts move to Phase 1, because all three depend on the full concept graph and on a teacher existing to receive the alert.

**In scope:** student flow (Today · Learn · Practice · Progress · More), Foxy as a **guided action interface** rather than an open chatbot, NCERT-grounded retrieval with citations and abstention, misconception-based remediation, spaced retention, evidence labels instead of mastery percentages, parent weekly digest and transcript view, bilingual Hindi and English.

**Out of scope, by phase:** teacher and principal surfaces, content authoring workflow, WhatsApp, voice, mobile applications, white-labelling, boards other than CBSE.

Current state and the detailed remaining list live in `PROGRESS.md`.

---

## 3. Phase 1 — Teacher experience · 26 days

**Why first:** the client's document is a school pilot. Without a teacher surface there is no intervention loop, and the pilot's core claim — that the system tells a teacher who needs help and why — cannot be demonstrated.

| Item | Days |
|---|---|
| Teacher Today — who needs attention, what misconception they share, what action to take | 6 |
| Classes and Students, scoped to assigned classes only | 4 |
| Intervention plans — open, act, mark complete | 5 |
| Grouped misconception view across a class | 4 |
| Prerequisite recall and recovery, completing the nine-step session | 4 |
| Teacher escalation when repeated struggle is detected | 3 |

**Reusable from the old repo:** `classes`, `class_enrollments`, `class_teachers`, `class_students`, `school_admins` — the data model already exists and was in production.

**Depends on:** MVP evidence capture — hint level, confidence, changed answers, misconception codes. **If the MVP does not record these, the teacher screen launches empty and stays empty for months.** This is why they are non-negotiable in Phase 0.

---

## 4. Phase 2 — WhatsApp and voice · 35 days

**Why second:** these are the two highest-leverage additions for the Indian market, and both are far cheaper than they look because prior art exists.

### WhatsApp — 23 days

| Stage | Days | Notes |
|---|---|---|
| Business API onboarding via a provider, template approval, opt-in and consent | 5 | Meta requires pre-approved templates for business-initiated messages. Approval takes days and is outside our control — **start this early** |
| Parent weekly digest delivered over WhatsApp | 5 | Parents open WhatsApp; they do not open email. This alone is likely to move parent engagement more than any in-app work |
| Student daily mission nudge | 4 | Respect quiet hours; strict frequency caps |
| Teacher intervention alerts | 3 | Depends on Phase 1 |
| **Foxy over WhatsApp** — ask a doubt, receive a cited answer | 6 | The same retrieval and guardrails as the web tutor, delivered through a different channel |

**Reusable:** `whatsapp-notify` and `whatsapp-send` Edge Functions.

**Foundation needed in Phase 0:** the `notify` module must define a **channel port** — email, in-app, WhatsApp, push — from the start. Adding a channel then becomes one adapter. Without it, every notification call site has to be rewritten.

### Voice — 12 days

| Item | Days | Why |
|---|---|---|
| Read aloud (text to speech), Hindi and English | 5 | The client's Screen 3 requires it. It is an **accessibility requirement**, not a feature — it serves students who read slowly or are learning in their second language |
| Ask by voice (speech to text) | 7 | Typing a mathematics question on a phone is painful. Voice removes the largest input barrier for younger students |

**Reusable:** `voice.ts`, `voice-python-client.ts`, `voice-feature-flag.ts`, `voice-reply-language.ts`, and prior work on Indian-accent voice selection.

**Foundation needed in Phase 0:** `preferred_language` and accessibility preferences on the student profile — already built.

---

## 5. Phase 3 — Mobile applications · 35 days

**Why third and not earlier:** the web application is an installable PWA from day one, which covers most of the need. Native apps matter for three things a PWA cannot do well — reliable push notifications, genuine offline use, and app-store presence as a trust signal when selling to schools and parents.

| Item | Days |
|---|---|
| Shared client against the existing API — no backend change required | 8 |
| Student experience: Today, Learn, Practice, Progress | 10 |
| Parent experience | 5 |
| Offline-first: download a mission, complete it offline, sync on reconnect | 7 |
| Push notifications | 3 |
| Play Store and App Store submission, review cycles | 2 |

**Reusable:** a complete Flutter application exists in the old repo, along with a Play Store listing and release history.

**Foundation needed in Phase 0:** already satisfied. The backend and frontend split means mobile is another client of the same contracts. **No backend work is required for mobile beyond what the MVP already provides** — this was the main reason for accepting the split's cost.

**Decision required before Phase 3 starts:** reuse the existing Flutter application, or rebuild. Reuse is faster but inherits assumptions from the previous product's data model. Assess it when the phase begins, not now.

---

## 6. Phase 4 — School leadership, internal roles, content workflow · 59 days

Everything in the client's sections 7 and 8.

| Item | Days |
|---|---|
| Principal dashboard — activation, sessions completed, improvement by cohort, four-week retention, comparison groups, continuation recommendation | 12 |
| Implementation manager — attendance, devices, timetable adherence, operational issues | 6 |
| Support agent — diagnostics with masked student identity | 4 |
| School success manager — implementation, outcomes, renewal readiness | 4 |
| **Content author and academic reviewer** — draft, review, approve, version, publish | 15 |
| Full role matrix, audited "view as", complete audit log | 12 |
| School billing — seats, invoices, subscriptions | 6 |

**Reusable:** `schools`, `school_admins`, `school_subscriptions`, `school_seat_usage`, `school_invoices`, `school_audit_log`, `school_invite_codes`, `school_alert_rules`. The content workflow columns already exist on `question_bank` — `content_status`, `created_by`, `reviewed_by`, `published_by`, `published_at`, `review_notes`.

**Foundation needed in Phase 0:** the role enum, a `schools`/`classes` stub, and the `audit_log` table. **Three days now against roughly eight days plus a live-data migration later.** Already on the must-have list.

---

## 7. Phase 5 — White-labelling and multi-tenancy · 30 days

Schools want the product to carry their name. This is a commercial lever, not a feature: it raises contract value and reduces churn because the school has adopted it as their own.

| Item | Days |
|---|---|
| Tenant isolation enforced at the authorisation boundary | 8 |
| Theming — logo, colours, typography, per tenant | 6 |
| Custom domain per school, with automatic certificates | 6 |
| Tenant-scoped content — a school's own questions alongside the shared bank | 5 |
| Per-tenant configuration and feature flags | 5 |

**Reusable:** `schools`, `school_questions`, `school_api_keys` — an API-key table implies white-label API access was already anticipated.

> ⚠️ **`tenant_id` is the one item on this roadmap that is genuinely expensive to retrofit.** Adding it to every table after real student data exists means a migration across every row, every query and every authorisation check, with no safe intermediate state.
>
> **Decision required during Phase 0:** either add `tenant_id` (nullable, defaulted) to student-owned tables now — roughly 2 days — or accept a painful migration later. Given the client's document is explicitly a school pilot, **do it now.**

---

## 8. Foundation hooks that must land in Phase 0 — **ALL DONE, 9 August 2026**

Each is cheap now and expensive or impossible later. This table is the reason the roadmap exists.

| Hook | Status | Cost later, avoided | Enables |
|---|---|---|---|
| Full evidence capture — first answer, hint level, confidence, changed answers, explanation format | ✅ migration `0006` | **Unrecoverable.** History cannot be backfilled | Phase 1 teacher screen, Phase 4 principal dashboard |
| Notification **channel port** — email, in-app, WhatsApp, push | ✅ `platform/notify-channel` | Rewrite every call site | Phase 2 WhatsApp |
| Role enum, `schools`/`classes` stub, `audit_log` | ✅ migration `0005` | ~8 d plus a live-data migration | Phases 1 and 4 |
| `tenant_id` on student-owned tables | ✅ migration `0004` + `platform/authz` | Migration across every table, query and authorisation check | Phase 5 |
| Backend and frontend split, API-first | ✅ done earlier | — | Phase 3 mobile |
| `preferred_language`, accessibility preferences | ✅ done earlier | — | Phase 2 voice |
| Misconception codes, held-out questions | ✅ done earlier | Re-authoring the question bank | Phases 1 and 4 |

**The estimate was about 6 days. Delivered in one pass**, together with two items that were not on this table but were prerequisites for it: `platform/metrics` (resilience plan §5 required breaker transitions to be "emitted as a metric" and the only sink was a no-op) and the **worker process** (§3.2 listed it as "already in place"; it did not exist, and it is on the MVP critical path because it generates the parent weekly digest).

### What "done" means here, and what it does not

**None of the features these hooks support has been built.** There is no teacher module, no principal dashboard, no WhatsApp, no digest, no multi-tenancy. What exists is the ground each one stands on:

- `schools`, `classes`, `class_enrolments` are **schema-only stubs** — no module, no service, no routes, and nothing reads them.
- `users.role` accepts ten values; **self-service signup still accepts exactly two**, and a test drives all eight widened roles at `POST /auth/signup` asserting a 400 for each.
- The five evidence columns exist and **nothing writes them yet** — `practice` is build step 11.
- `whatsapp` and `push` are **declared and deliberately unimplemented**: they throw `DependencyError`, so enabling one before it is built is loud rather than silently dropping every message.

### The one thing left provisional — read this before Phase 5 starts

`tenant_id` is **nullable with a default**, and the guard denies only when *both* the actor and the resource carry a tenant and they differ. That is deliberate (D-061) and it is weaker than it will need to be.

> **Before a second tenant row is ever created**, `tenantId` becomes required on `Actor` and on every tenant-scoped `Resource`, the columns become `NOT NULL`, and `assertCanAccess` denies when either side is missing rather than passing.

That change is mechanical — the compiler lists every call site — and it is only mechanical because the column, the type and the authorisation branch already exist. Phase 5's 8-day "tenant isolation" line assumes this has been done first.

---

## 9. Prior art in the previous codebase

The old repository is not being extended, but it is being harvested. Substantial parts of this roadmap already exist there.

| Phase | Existing assets |
|---|---|
| 0 | NCERT corpus (~16,000 chunks, 750 of 761 chapters), `chapter_concepts`, `concept_graph`, `misconception_patterns`, `wrong_answer_remediations`, `question_bank` with three hint levels and `solution_steps`, nine content-generation Edge Functions |
| 1 | `classes`, `class_enrollments`, `class_teachers`, `class_students` |
| 2 | `whatsapp-notify`, `whatsapp-send`; four voice modules including Indian-accent voice selection |
| 3 | A complete Flutter application with Play Store listing and release history |
| 4 | Seventeen school tables; the content review workflow already modelled on `question_bank` |
| 5 | `school_questions`, `school_api_keys` |

**Whether these tables hold data, as opposed to merely existing, is unverified.** The query to settle it is in `PROGRESS.md`. Until it is run, every estimate above that depends on reuse carries the same caveat.

---

## 10. Sequencing rationale

Why this order, and not another:

1. **Teacher before principal.** A principal dashboard reporting "teacher interventions completed" is empty until teachers can record interventions. Building the leadership view first produces a dashboard with nothing in it.
2. **WhatsApp before mobile.** WhatsApp reaches a parent who will never install an app, costs a fraction of a native client, and prior art exists. In India it is the higher-return channel by a wide margin.
3. **Voice with WhatsApp, not later.** Read-aloud is an accessibility requirement in the client's own specification, not an enhancement. It also happens to be the cheapest item on the roadmap.
4. **Mobile after both.** The PWA covers most of the need. Native earns its place through push, offline and store presence — all valuable, none urgent.
5. **Content workflow last among the internal tools.** Content is generated by pipeline and reviewed in bulk during the pilot. A polished authoring interface matters when non-engineers own content day to day, which is a scale problem, not a pilot problem.
6. **White-labelling last, but its foundation first.** The feature can wait. `tenant_id` cannot.

---

## 11. Deliberately not planned

Recording these prevents them being re-proposed every quarter.

| Item | Reason |
|---|---|
| Public leaderboards | The client excluded them: they discourage struggling students and distort learning behaviour |
| Boards beyond CBSE | Prove one curriculum first. Roughly 20 days per board once the content pipeline is proven |
| Regional languages beyond Hindi | Roughly 15 days per language. Sequence by where schools are actually sold |
| Live classes and video conferencing | A different product with different infrastructure. Integrate a third party if a school demands it |
| Social features between students | Safety and moderation burden for a platform serving minors, with no learning benefit demonstrated |
| Self-hosted language model | Revisit when monthly model spend exceeds the cost of a GPU node. Behind a provider interface, so it stays a configuration change |

---

## 12. Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| 1 | **Are `chapter_concepts`, `concept_graph` and `misconception_patterns` populated, or empty tables from an unrun feature?** | Every reuse estimate in this document | Run the query in `PROGRESS.md` |
| 2 | Is this confirmed as a school (B2B) sale? | Phases 1, 4 and 5, and whether parent subscription billing is built at all | Client |
| 3 | Who pays, and for what? The client's specification never mentions payment | Billing scope in Phase 0 and Phase 4 | Client |
| 4 | Reuse the existing Flutter application or rebuild? | Phase 3 estimate | Assess at Phase 3 |
| 5 | Which WhatsApp provider? Approval lead time is outside our control | Phase 2 start date | Decide during Phase 1 |
| 6 | Second engineer after the MVP? | Whether year one reaches Phase 3 or Phase 5 | Commercial |

---

## 13. The honest summary

**One engineer, one year: MVP plus the teacher experience plus WhatsApp and voice.** That is a demonstrable, sellable school pilot with the reach channel that matters in India.

**Mobile, leadership tooling and white-labelling need a second year, or a second engineer.**

The architecture is built so none of it requires a rewrite — every phase adds modules and surfaces over evidence that already exists. That property is worth more than any single feature on this list, and it is the reason the six days of foundation hooks in section 8 are not optional.
