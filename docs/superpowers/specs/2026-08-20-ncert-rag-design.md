# Pedagogical Evidence Retrieval Fabric — Design

**Version:** 2.0
**Date:** 21 August 2026 (v1: 20 August 2026)
**Status:** Approved design. Implementation plan not yet written.

> **Looking for what to do first?** This is the design record, not the build
> order. Read `docs/superpowers/plans/2026-08-21-rag-build-guide.md` instead —
> phase-by-phase, plain language, checkboxes. Come back here for schemas,
> contracts, model choices, and exact thresholds. If the two disagree, **this
> file wins**; the guide is written to be readable, not precise.

**Parent architecture:** *Alfanumrik Grounded Teaching System (AGTS)* — Architecture
& Research Dossier v1.0, 21 August 2026. This document is the implementation
spec for that dossier's §5 (Knowledge foundation and content supply chain) and
§6 (Pedagogical Evidence Retrieval Fabric). Where the two disagree, AGTS wins on
policy and this document wins on implementation detail. Conflicts resolved in
v2 are listed in §0.3.

---

## 0. Scope

### 0.1 What this module is

A retrieval service that turns an authorised **QueryPlan** into a verified
**EvidencePack** with claim-addressable citations, plus the governed content
pipeline that produces the objects it retrieves.

### 0.2 What this module is NOT

Owned by AGTS, consumed here as inputs, **never** implemented in this module:

| Not ours | Owner | We consume |
|---|---|---|
| Teaching state machine, hint ladders | Pedagogy Controller | `teaching_action`, `max_disclosure` |
| Learner mastery, misconception state | Learner Model service | `learner_state_class`, `prerequisite_gap_ids[]` |
| Assessment items, rubrics, answer keys | Assessment service | `assessment_mode`, `forbidden_object_types[]` |
| Consent, tenancy, role resolution | Policy Gate | `tenant_id`, `role`, `entitlements[]` |
| Response prose generation | Teaching Renderer | we hand it an EvidencePack, it hands us nothing |

This module **never writes learner truth** (AGTS D6) and **never selects a
teaching action** (AGTS D4). It answers one question: *given this plan, what
approved evidence exists, is it sufficient, and where exactly did it come from?*

### 0.3 v1 → v2 changes

Four corrections, all from the AGTS dossier:

1. **Rights default inverted.** v1 treated NCERT as redistributable. It is not —
   NCERT explicitly asserts copyright over its textbooks [R45]. **Every source
   now defaults to `QUARANTINED`** until a documented legal basis is approved.
   Public availability is not permission to embed, transform, or reproduce.
2. **Pre-retrieval policy filters added.** Tenant, role, entitlement, approval,
   active-version, and assessment-disclosure filters now execute *before* any
   candidate can score (AGTS D8). v1 filtered only on grade and subject.
3. **Security threat model added** (§9). v1 had none. Retrieved content is
   untrusted input, not a trusted prompt extension [R40-R43].
4. **Curriculum graph promoted to Phase 1.** v1 deferred it to Phase 5. AGTS
   §14.3 is explicit: create concept/outcome identifiers *before* embeddings.
   A reduced form ships in Phase 1 (§5.4).

These four push the estimate from v1's 10-14 weeks to **17-19** (§12). Rights
approval, policy filters, the security suite, and the graph are not optional
extras — they are AGTS requirements v1 simply did not carry.

One thing v2 **keeps against** the dossier: a **post-rerank recall gate**
(§2, G2). AGTS G1 measures `Recall@20` over candidates only. Nothing in it
measures what survives reranking into the final pack, so a pipeline can pass
G1 and still hand the renderer three wrong passages. See §2.3.

### 0.4 Relationship to Foxxy

Foxxy's `retrieval` module is live and demoed. **Nothing here modifies it.**
It appears below only as evidence — a carefully engineered pipeline that cannot
score itself, which is the failure mode this design exists to avoid.

---

## 1. Locked decisions

| # | Decision | Value |
|---|---|---|
| 1 | Core language | Python (ingest, embed, rerank, eval) |
| 2 | API layer | TypeScript / Fastify |
| 3 | Corpus | NCERT 6-12 all subjects; Exemplar + PYQ; third-party — **all quarantine-by-default** |
| 4 | Corpus language | English (Phase 1-3); reviewed Hindi objects from Phase 4 |
| 5 | Query languages | English + Hinglish + transliteration + typo/ASR noise |
| 6 | Modality | Text + math (LaTeX/MathML) + figure understanding + page-region retrieval |
| 7 | Hosting | Self-hosted embed + rerank on the query path; API VLM at ingest |
| 8 | Retrieval | Plural generators → RRF → cross-encoder rerank → sufficiency gate |
| 9 | Chunking | Small-to-big, typed learning objects, block-derived |
| 10 | Curriculum graph | Reduced form in Phase 1; full graph Phase 4 |

### Rejected, with reasons

**Agentic / open-ended iterative retrieval.** Non-deterministic retrieval makes
gate numbers unstable, which collapses the measurement discipline the whole
design rests on. AGTS §6.5 agrees and is stricter: *"Repeated free-form search
loops are prohibited."* We allow **exactly one** bounded corrective retrieval
(§7), then CLARIFY / ABSTAIN / ESCALATE.

**Contextual-retrieval preambles at Phase 1.** An LLM-written situating sentence
per chunk is well-evidenced but costs one LLM call per chunk across the whole
corpus. Built only if gates do not clear without it. Do not pay upfront to fix
an unmeasured problem.

**Late-interaction (ColBERT/ColPali) index at Phase 1.** Real gains on
fine-grained and page-image matching, real cost in a second index and a second
serving path. Piloted in Phase 4, promoted only against AGTS's scaling rule
(TABLE 11): a component earns its place by failing a documented threshold in
benchmark or load tests, not by appearing on an architecture diagram.

---

## 2. Acceptance gates

### 2.1 Module gates

Owned by this module. All block release.

| # | Gate | Threshold | Note |
|---|---|---|---|
| **G0** | Lineage | **100%** of served objects approved, active, rights-valid, tenant/role-authorised, source-addressable | AGTS G0. Zero tolerance. |
| **G1** | Candidate recall | `recall@20` ≥ 95% single-hop; ≥ 90% multi-hop / visual / multilingual | AGTS G1 |
| **G2** | **Pack recall** | `recall@k_pack` ≥ 90% — gold span present in the *delivered* EvidencePack | **This module's addition.** §2.3 |
| **G3** | Citation | precision ≥ 98%, completeness ≥ 95%, **100%** of ids resolve to a live source span | AGTS G2 |
| **G4** | Faithfulness | ≥ 95% of asserted claims entailed by a cited span | |
| **G5** | Answerability | unanswerable/insufficient F1 ≥ 90%; abstain policy pass ≥ 98% | AGTS G4 |
| **G6** | Disclosure | **0** answer/rubric/solution leakage in the graded suite; < 1% excessive disclosure in guided practice | AGTS G6. Zero tolerance. |
| **G7** | Isolation | **0** cross-tenant, PII, unapproved, or retired retrieval across ≥ 100k synthetic attacks | AGTS G7. Zero tolerance. |
| **G8** | Latency | `p95` ≤ 300 ms for generators + fusion; ≤ 550 ms through the evidence gate | AGTS TABLE 12 |

G1 is the honest one. If the gold span never enters the candidate set, no
reranker recovers it, and every downstream number is capped by a stage-four
failure. Most *"our RAG is broken"* is a G1 failure diagnosed as a G4 failure.

**Correctness (AGTS G3), pedagogy (G5), learning (G10)** are gated by AGTS
downstream of this module and are not reproduced here.

### 2.2 Per-slice gating — hard requirement

**A single averaged 90% is not a pass.** Every gate is evaluated independently
on every slice, and a slice below its floor fails the whole run.

Slice axes: **grade** × **subject** × **teaching_action** × **question_type** ×
**query language** × **modality** × **evidence condition**.

- Slice with **n ≥ 20** gold cases is **gating**.
- Slice with n < 20 is reported, not gating. Gold-set construction targets
  n ≥ 20 for every slice in the shipped product; this is a bootstrapping
  allowance, not a standing exemption.
- Default slice floor is the global gate value.

**Named exceptions.** Each requires written justification here to exist. This
table is the complete list of places where a number means something other than
what §2.1 says.

| Slice | Floor | Justification |
|---|---|---|
| `question_type = multihop` | G2 ≥ 75% | Structural ceiling without graph expansion. Raising it is the explicit success criterion for the Phase 4 curriculum graph. |
| `question_type = numerical` | **excluded from G1-G2** | *"Solve this quadratic"* is not a retrieval problem; it routes to the Tool Broker (AGTS D7). Tracked and reported, never counted toward a retrieval gate — including it inflates the denominator with questions retrieval was never meant to answer. |
| `language = hinglish` | ≥ 85% entering Phase 4, ≥ 90% leaving it | Lexical retrieval degrades sharply on romanised input. Interim floor lets Phase 4 ship incrementally; the exit floor is the real bar. |
| `modality = visual` | G1 ≥ 90% | AGTS G1 already separates visual. Page-region retrieval is a Phase 4 pilot. |

### 2.3 Why G2 exists

AGTS G1 gates `Recall@20` — candidate recall. Nothing in the dossier measures
what survives reranking into the pack the renderer actually receives.

A reranker can score 20 correct candidates and still order the gold span into
position 9 of a 5-slot pack. G1 passes at 0.95, the renderer gets nothing usable,
and the failure surfaces as a correctness (G3) or faithfulness regression whose
real cause is three stages upstream. **G2 measures the delivered pack**, so
rerank quality has its own number and its own blame.

`k_pack` is action-specific (§6.4), so G2 is evaluated per teaching action.

### 2.4 Reported, non-gating

`nDCG@10`, `MRR`, **rerank lift** (`G2` with reranker minus without — how the
reranker justifies its own cost), evidence-type coverage, authoritative-source
recall, duplicate rate, contradiction rate, per-stage `p50/p95/p99`, cost per
100 turns by action and language.

---

## 3. Models and infrastructure

Every model below is a **default to benchmark against, not a commitment**. AGTS
§6.2 is explicit that candidate generators must win on Alfanumrik's corpus,
languages, device constraints, citations, latency, cost, and failure cases. The
Phase 0 bake-off (§11.1) decides; this section exists so Phase 0 has something
concrete to start from.

### 3.1 Serving stack

| Layer | Choice | Rationale |
|---|---|---|
| System of record | **PostgreSQL 16+** with row-level security | AGTS TABLE 10. Tenant enforcement in the database, not the application. |
| Vector index | **pgvector ≥ 0.8** — HNSW, `halfvec` storage | One store, transactional with the metadata the pre-filters read. |
| Lexical index | **Postgres FTS** initially → **ParadeDB `pg_search`** (real BM25) on measured trigger | AGTS TABLE 10: dedicated engine only after a documented threshold fails. |
| Learned sparse | **BGE-M3 sparse** vectors in `sparsevec` | Carries Hinglish and rare-token recall that BM25 loses. Phase 4. |
| Model serving | **HF text-embeddings-inference (TEI)** | Serves embedders *and* cross-encoder rerankers, batched, one GPU box. |
| Large-model serving | **vLLM** | Only if a reranker above ~1B is promoted. |
| Object store | S3-compatible, versioned, encrypted | Raw PDFs, page images, figure crops, eval artefacts. |
| Cache | Redis / Valkey | Keys include tenant, entitlement, curriculum version, **manifest id**, policy version. |
| Jobs | Transactional outbox + idempotent workers | Ingest, embed, index, evaluate, delete, reproject. |

**Critical pgvector note.** AGTS D8 requires hard pre-filters before scoring.
HNSW with a restrictive `WHERE` is the classic recall killer — the graph walk
finds `ef_search` neighbours *then* the filter discards most of them, so a
narrow filter silently under-retrieves and reads as a thin corpus. Two mitigations,
both required:

1. **`hnsw.iterative_scan = relaxed_order`** (pgvector 0.8+), which keeps
   scanning until the LIMIT is satisfied.
2. **Partition or partial-index by the highest-cardinality hard filter**
   (`grade`, `subject`), so the common path filters by partition rather than by
   predicate.

Set `hnsw.ef_search` as a **connection parameter on every pool that runs vector
queries**, not at module scope. Foxxy set it on one pool and not the worker's,
so background retrieval ran at pgvector's 40-row default for weeks while every
test passed.

### 3.2 Embedding — Phase 0 bake-off

All candidates at **1024 dimensions** so the column type survives the decision.

| Candidate | Host | Why shortlisted |
|---|---|---|
| **BGE-M3** | self | Multilingual, dense + sparse + multi-vector from one model, 8k context. Default. |
| **Qwen3-Embedding** (0.6B / 4B) | self | Strong multilingual, Matryoshka dims, instruction-aware. |
| **multilingual-e5-large** | self | Older, small, fast. Baseline floor. |
| **voyage-3** | API | What Foxxy runs — gives a directly comparable number. |
| **jina-embeddings-v3** | API/self | Task-specific LoRA adapters, Matryoshka. |

Decision protocol in §11.1.

### 3.3 Reranker — Phase 0 bake-off

| Candidate | Host | Why shortlisted |
|---|---|---|
| **bge-reranker-v2-m3** | self (TEI) | Multilingual cross-encoder, ~568M, strong quality/latency. Default. |
| **Qwen3-Reranker-0.6B** | self (TEI) | Same tier, different training. |
| **jina-reranker-v2-base-multilingual** | self | Fast, multilingual. |
| **bge-reranker-v2-gemma** | self (vLLM) | Higher ceiling, materially higher cost. Only if the smaller tier misses G2. |
| **Cohere Rerank 3.5** | API | Quality reference point for the self-hosted tier. Not a serving candidate — an on-path API call breaks the §3.1 hosting decision. |

### 3.4 Parsing — ingest only

| Stage | Choice | Fallback |
|---|---|---|
| Layout, reading order, tables | **Docling** [R12] | **Marker** |
| Math OCR → LaTeX | Docling formula model | **Mathpix API** on low-confidence pages, and **primary for mathematics sources if the Phase 1 probe fails** (§12) |
| Figure understanding | **Claude Sonnet 5** (`claude-sonnet-5`) | **Gemini Flash** tier for bulk re-runs |
| Page-region embedding | **ColQwen2 / ColPali** class | Phase 4 pilot only |

Math extraction is the highest-variance risk in this build (§13). Phase 1
carries a mathematics probe specifically to find out early.

### 3.5 Verification models

| Job | Choice | Note |
|---|---|---|
| Claim entailment (G4) | **MiniCheck** class, or DeBERTa-v3 NLI, self-hosted | Runs per claim, so it must be small and fast. |
| Correctness judge (AGTS G3) | **Claude Opus 5** (`claude-opus-5`) | **Must differ from the generator.** A model grading its own output grades generously. |
| Query canonicalisation (§6.2) | **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) | Only on dictionary miss. Schema-validated output; **cannot relax a filter** (AGTS §6.1). |

### 3.6 Version pinning

`parser_version`, `chunking_version`, `embedding_model` + `embedding_version`,
`vlm_version`, `reranker_version`, `index_manifest_id`. Every served turn
records the tuple (AGTS §13.1). A number that cannot name the code that produced
it is not evidence.

---

## 4. Data model

```
sources ──▶ documents ──▶ blocks ──▶ learning_objects ──▶ embeddings
   │                        │              │
   │                        ▼              ▼
rights_register         figures      object_relations (curriculum graph)
                                           │
                                    index_manifests ──▶ serving alias
```

### 4.1 The load-bearing decision: `blocks` ≠ `learning_objects`

Parsing is expensive and irreversible — VLM calls, Mathpix credits, wall-clock.
Chunking strategy will change many times before the gates go green.

Keeping raw layout output in `blocks` makes re-chunking free and repeatable
forever. Parsing straight into final objects makes every chunking experiment
cost a full re-parse — which in practice means the experiments stop being run,
and the recall left behind in the parser is never recovered.

Foxxy is the worked example: its chunks came from a pipeline in a repository
that no longer exists, fed by PDFs held in neither repo. It cannot be re-chunked
at any price. A permanent quality ceiling, bought for no upfront saving.

### 4.2 Tables

**`sources`** — one row per book.
`title`, `publisher`, `authority_tier` (`board_official` | `school_approved` |
`licensed_publisher` | `alfanumrik_authored` | `untrusted_research`),
`checksum`, `edition`, `publication_date`, `curriculum_applicability`,
`language`, `tenant_scope`, `supersedes_id`, `status`, `parser_version`.

**`rights_register`** — one row per source, **required before extraction**.
`owner`, `basis`, `permitted_transformations[]`, `quotation_limit`,
`display_limit`, `territories[]`, `expiry`, `takedown_contact`,
`derived_retention_after_expiry` (bool), `approved_by`, `approved_at`.

`sources.status` defaults to **`QUARANTINED`**. It becomes `APPROVED` only when
a `rights_register` row exists with a recorded basis and a named approver.
**NCERT is not exempt** [R45]. Enforced three times: quarantine blocks the
parser; the embed stage refuses non-approved sources; the query path joins on
approval and rights validity. A rights decision must not be reversible by
forgetting a `WHERE` clause.

**`documents`** — chapter/unit. `source_id`, `chapter_number`, `title`,
`page_start`, `page_end`.

**`blocks`** — raw layout output, pre-chunking.
`document_id`, `page`, `block_type` (`heading` | `paragraph` | `equation` |
`table` | `figure` | `list` | `example` | `exercise` | `activity`),
`order_index`, `text`, `latex`, `bbox`, `figure_uri`, `parser_confidence`.

**`learning_objects`** — the retrieval unit. AGTS TABLE 13 types.
`document_id`, `parent_id`, `block_ids[]`, `object_type`, `heading_path`,
`text`, `search_text`, `token_count`, `source_span {page, region, offsets}`,
`concept_ids[]`, `outcome_ids[]`, `prerequisite_ids[]`, `language`, `modality`,
`authority_tier`, **`disclosure_class`** (`public` | `hint_gated` |
`solution` | `rubric` | `protected_item`), `tenant_scope`, `acl`,
`approval_id`, `embedding vector(1024)`, `sparse_embedding sparsevec`,
`content_hash`, `status`, `retired_at`, `deletion_state`, versions.

`disclosure_class` is what makes G6 enforceable. Solutions and rubrics are
separate objects with their own ACL, filtered out **before scoring** in graded
mode — never filtered out of a result set afterwards.

**`contexts`** — parent spans, 1000-1200 tokens. Retrieved via their children,
delivered to the renderer. Not embedded.

**`figures`** — `block_id`, `uri`, `caption`, `alt_text`, `vlm_description`,
`labels[]`, `concept_ids[]`, `vlm_model`, `vlm_version`.

**`object_relations`** — the curriculum graph. `from_id`, `to_id`, `edge_type`
(`PREREQUISITE_OF` | `PART_OF` | `EVIDENCES` | `EXAMPLE_OF` | `CONTRASTS_WITH` |
`COMMONLY_CONFUSED_WITH` | `ALTERNATE_REPRESENTATION_OF` | `REMEDIATES` |
`SUPERSEDES`), `provenance`, `reviewed_by`, `version`.

Relational node/edge tables, not a graph database — AGTS TABLE 11. Promote only
when a documented threshold fails.

**`index_manifests`** — object set, all pipeline versions, checksum, status.
The serving alias points at exactly one. Atomic swap, previous stays
rollback-ready.

**`eval_cases`** — `query`, `query_variants[]` (Hinglish, transliterated, typo,
ASR-noised), `grade`, `subject`, `teaching_action`, `learner_state_class`,
`task_context`, **`gold_block_ids[]`**, `acceptable_evidence_types[]`,
`forbidden_disclosures[]`, `reference_answer`, `answerable`, `question_type`,
`origin`, `adjudicators[]`, `inter_rater_agreement`, `holdout` (bool).

**`retrieval_traces`** — AGTS §11.3. Plan, candidates with generator ranks and
scores, filter and duplicate decisions, reranker features and version, fused and
selected ids, pack order, sufficiency result, citations, per-stage latency and
cost, and the full version tuple.

### 4.3 Deduplication and contradiction

**Dedup:** exact `content_hash`, then MinHash near-duplicate, within and across
sources. Canonical preference: higher `authority_tier` → newer edition → longer
text. Non-canonical rows get `status='duplicate'` and `duplicate_of` — recorded,
never deleted, so the decision is auditable and reversible.

**Contradiction (AGTS TABLE 17):** where two objects of equal authority make
incompatible claims about the same `concept_id`, flag both at publication and
route to academic review. Unresolved contradiction at query time is a
**sufficiency failure**, not a ranking tie-break: the system escalates rather
than silently picking one. Foxxy's corpus was 25% exact duplicates, undetected
for months, competing for the same top-k slots — dedup is not hygiene, it is
recall.

---

## 5. Content supply chain

Nine stages. Each idempotent, resumable, independently versioned — bumping one
version recomputes only what is downstream.

| # | Stage | Output |
|---|---|---|
| S0 | **Register + quarantine** | `sources` row, `rights_register` row, checksum. Malware, PDF-bomb, hidden-text, PII, and prompt-injection scan **before any parser or model sees the file**. |
| S1 | **Rights approval** | `status → APPROVED`. Human, named, dated. Gate: nothing proceeds without it. |
| S2 | **Parse (dual representation)** | `blocks` + page images. Layout, reading order, tables → markdown, equations → LaTeX, figures cropped by bbox. |
| S3 | **Figure understanding** | `figures.vlm_description`, cached by figure hash. |
| S4 | **Compose learning objects** | `learning_objects` + `contexts`. Pure function of blocks + `chunking_version`. |
| S5 | **Curriculum mapping** | `concept_ids[]`, `outcome_ids[]`, `object_relations`. Model-proposed, **human-reviewed**. |
| S6 | **Dedup + contradiction** | `duplicate_of`, contradiction flags. |
| S7 | **Embed** | dense + sparse vectors. |
| S8 | **Publish** | shadow index → suites → two-person approval for protected material → signed manifest → atomic alias swap. |

### 5.1 Quality gates inside the pipeline

These are the point of the pipeline, not decoration.

**After S2**, per document: block count above a per-page floor; no page yielding
zero blocks; text-to-character ratio in band; at least one `equation` block in
any mathematics source; `parser_confidence` distribution within tolerance.
Failure is loud and stops the run.

**After S7**: zero approved objects with a NULL embedding. An object that fails
to embed fails the run — never imported as NULL to be noticed later.

**After S8**: zero active objects missing an embedding, a search vector, a
source span, or an approval id. This is G0.

Foxxy imported 4,686 chunks. 1,199 were exact duplicates (≈25% of the corpus)
and 20 carried no vector at all, invisible to dense search. Both found by hand,
long after the fact. Each is precisely a gate that did not exist.

### 5.2 Composition rules (S4)

- Split on **heading hierarchy first**, token budget second.
- **Never** split an equation, a table, or a figure from its caption.
- `heading_path` is prepended into `search_text` — e.g.
  `"Grade 10 › Science › Ch 9 Light › Refraction"`. Near-free, and it
  disambiguates the many chapters that reuse section names.
- **Question objects**: prompt is a separate object from its solution and
  rubric, with different `disclosure_class` and different ACL (AGTS TABLE 13).
  This is structural, not a filter — a graded-mode query cannot retrieve a
  solution because the solution is not in its addressable set.
- **Worked examples** kept whole, with faded variants as child objects.
- **Hint ladders** stored as ordered stages, each with its own
  `max_disclosure`.
- Small-to-big: the child (200-300 tok) is embedded and ranked; its parent
  context (1000-1200 tok) reaches the renderer. Textbooks punish uniform
  chunking — the sentence that *matches* a query is rarely the span that
  *answers* it.

### 5.3 Retirement and deletion

Serving filters update **immediately** on retirement. Asynchronous index and
object deletion is monitored to completion and proved by tombstone audit. Cache
keys include `index_manifest_id`, so a retired object cannot survive in a warm
cache. AGTS TABLE 28 lists deletion failure as a named threat; proof-of-deletion
is a gate, not a job that probably finished.

---

## 6. Retrieval fabric

### 6.1 Contract

**In:** `QueryPlan` (AGTS TABLE 14) — authorised, schema-validated, produced by
the Retrieval Planner from the Pedagogy Controller's chosen action.
**Out:** `EvidencePack` + `RetrievalTrace`.

The planner is deterministic where rules can decide. A small model may classify
ambiguous intent or propose rewrites, **but its output is schema-validated and
cannot relax a filter** (AGTS §6.1). A model that can widen its own ACL is not a
planner, it is a vulnerability.

### 6.2 Pipeline

```
 1  policy prefilter        tenant, role, entitlement, approval, active manifest,
                            rights validity, grade, curriculum version,
                            disclosure_class ← ALL BEFORE SCORING
 2  normalise + detect      en | hinglish | transliterated | noisy
 3  canonicalise            Hinglish → English concept terms (dict → LLM fallback)
 4  embed canonical query
 5  generators, in parallel  (§6.3)
 6  fuse                    RRF over ranks, per-generator provenance kept
 7  RERANK                  cross-encoder over the fused top set
 8  pack                    action-specific quotas, diversity, source order
 9  sufficiency gate        (§7)
10  emit                    EvidencePack + claim-addressable citations + trace
```

One path. No modes, no fast/full split. A second path drifts from the first, and
which one ran becomes a question nobody can answer from a trace.

**Step 1 is not optional and not reorderable.** Post-filtering a scored set is
worse than wrong — it is *intermittently* wrong, returning two rows for a narrow
filter and reading as a thin corpus rather than as a bug. For graded mode it is
a G6 failure: a solution object that was scored and then discarded still touched
the ranking, and one bug away from touching the renderer.

**Step 3, Hinglish.** A reviewed glossary of ~2k education terms, LLM fallback on
miss, cached hard (student query distribution is extremely repetitive). **The
raw query still goes to the lexical generator** — Hinglish science queries carry
their English technical terms intact (`refraction`, `sodium`, `velocity`), and
translating before BM25 discards signal already in the right language. Concept
resolution is language-neutral: English, Hindi, Hinglish, transliterated, and
typo-heavy forms must converge on the same approved `concept_ids` (AGTS §9.1).

**Step 7 is the accuracy engine.** RRF reads *rank* and discards *score*; a
cross-encoder reads query and object jointly. It is also what makes the
sufficiency gate honest — cross-encoder scores are comparable across queries.
Foxxy abstains on a fused score whose theoretical maximum is
`1/61 + 1/61 = 0.0328`, at a measured threshold of `0.029877`; that is
"ranked top-two in both lists" wearing a confidence costume. Well-calibrated
for what it measures, and incapable of expressing *"good passage, only the
sparse half found it."*

Reranking is **not semantic relevance alone** (AGTS §6.3). Features: curriculum
fit, teaching-action fit, authority tier, learner prerequisite fit, evidence
type, freshness, diversity, contradiction flag.

**Step 8 packs the smallest sufficient set.** Enforce action quotas, drop
redundant passages, include parent context only when needed, preserve logical
and source order to reduce long-context position effects [R13-R14]. More context
is not automatically better; RAG quality follows an inverted U as passages
accumulate.

### 6.3 Generators

| Generator | Phase | Best for | Depth |
|---|---|---|---|
| **Lexical** (BM25 / FTS) | 1 | Exact terms, equations, names, labels, rare tokens | 50 |
| **Dense** | 1 | Paraphrase, semantic intent, cross-lingual | 50 |
| **Hierarchy** (parent/child) | 1 | Parent context, section-level answers | 20 |
| **Curriculum graph** | 1 (reduced) / 4 (full) | Prerequisites, misconception repair, contrasts | 30, **max 2 hops, typed edges only** |
| **Learned sparse** (BGE-M3) | 4 | Hinglish, rare tokens, expansion | 50 |
| **Visual** (page/region) | 4 pilot | Diagrams, complex tables, handwriting | 20 |
| **Assessment / item bank** | 4 | Practice items, hint ladders — **disclosure-aware ACL** | action-specific |
| **Late interaction** | 4 pilot | Fine-grained token/region matching | 30 |

Phase 1 ships four. The rest earn their way in against §1's scaling rule.

### 6.4 Action-specific bundles

`k_pack` and required evidence types vary by teaching action (AGTS TABLE 16).
Retrieval must satisfy the *composition*, not merely return topical passages.

| Action | Required composition | Constraint |
|---|---|---|
| Explain | definition + prerequisite + explanation + example + misconception | answer, then check |
| Diagnose | outcome + discriminating items + misconception signatures | ask, do not lecture |
| Hint | current step + one ladder stage + rubric constraint | **final answer forbidden** |
| Worked example | analogous example + strategy + steps + fading variant | **must not be a near-copy of the graded item** |
| Check answer | prompt + rubric + source proof + misconception candidates | locate error, learner repairs |
| Compare | both concepts + relation edges + example + counterexample | contrast dimensions explicit |
| Diagram | visual region + caption/alt + labels + explanation | **every spatial claim grounded in a region** |
| Quiz | outcome spec + item constraints + exposure history | **no protected answers retrieved** |
| Revision | outcome summary + retrieval cards + error history | recall before re-explanation |

"Bundle contains the evidence types the action requires" is a **gate condition**
(§7), not a ranking preference.

---

## 7. Sufficiency gate and bounded correction

Before anything reaches the renderer, the pack is checked on eight dimensions
(AGTS TABLE 17):

| Dimension | Pass condition |
|---|---|
| Authority | ≥1 source at the action's authority tier; contested claims need two independent approved sources |
| Coverage | every planned factual or algorithmic claim maps to a source span or a deterministic tool output |
| Curriculum fit | correct board, version, grade, outcome; superseded material excluded or explicitly labelled |
| Pedagogical fit | the action's required evidence types are present |
| Conflict | no unresolved contradiction among authoritative objects |
| Freshness | version and expiry within policy |
| **Disclosure** | no forbidden solution, rubric, teacher note, or other learner's data present |
| Modality | visual claims have region support; formula and table claims preserve structure and units |

**On failure**, the gate emits a machine-readable gap reason and the planner may
run **exactly one** bounded correction: rewrite the query, add a lexical variant,
follow one reviewed graph edge, fetch an authoritative parent, or switch from
OCR text to page-region retrieval.

A second failure is terminal: **CLARIFY**, **ABSTAIN**, or **ESCALATE**. Never
improvisation, never an open-web fallback, never a loop.

**Abstention is a successful outcome**, decided before the renderer is called —
never a model judgement. Foxxy gets this right; it is kept.

---

## 8. Grounding and verification

The *"feels like an LLM wrapper"* complaint is answered structurally:
**retrieval carries correctness, generation is verifiably constrained.**

- **Structured evidence, never a concatenated blob.** Each object arrives as a
  record with id, `heading_path`, source, page, region, authority, and rights.
  The renderer cites ids and **cannot cite outside the pack**.
- **Three-level verification.**
  1. every cited id exists in the delivered pack;
  2. every cited id resolves to a live span in the **serving manifest** (G3);
  3. **claim-level entailment** — each asserted sentence checked against the
     span it cites by an NLI model; unsupported spans stripped before the
     student sees them (G4).

  Foxxy does (1). Level (3) is what moves faithfulness from roughly 85% to 95%.
- **Disclosure verifier** re-checks the rendered output against
  `forbidden_content_ids[]` and `max_disclosure`. Structural filtering (§5.2)
  plus pre-score filtering (§6.2) plus this makes three independent barriers on
  G6 — appropriate for a zero-tolerance gate.
- **Judge ≠ generator.** A model grading its own output grades generously.

---

## 9. Security — retrieved content is untrusted input

New in v2. Absent from v1, which is the kind of gap that ships.

| Threat | Failure | Control |
|---|---|---|
| **Poisoned source** [R43] | Malicious or subtly wrong content ranks highly | Rights + authority gate, quarantine, duplicate/outlier/contradiction scan, academic review, signed manifest, standing poisoning suite |
| **Prompt injection in content** [R40-R41] | A document instructs the model to ignore rules or call a tool | Content is passed as **quoted data**, never as instruction. Strict instruction/data separation. **Retrieved content can never select a tool or construct a privileged argument.** |
| **Cross-tenant retrieval** | School A's private content reaches School B | Pre-score tenant ACL, Postgres row-level security, tenant in cache **and index** keys, zero-tolerance synthetic suite (G7) |
| **Answer leakage** | Protected solution reaches a graded response | Separate objects, separate ACL, pre-score disclosure filter, exposure logging, output verifier (G6) |
| **Source spoof / version conflict** | Wrong edition, or a fabricated citation | Immutable source hash, version, coordinates; citation resolver validates **every** id against the live manifest |
| **Learner prompt extraction** | Student asks for the system prompt, answers, or another learner's data | No secrets in prompt, role-scoped data, refusal templates, red team |
| **Deletion failure** | Retired content persists in an index or cache | Tombstone, immediate serving filter, idempotent deletion jobs, proof-of-deletion audit |

**Incident classes** follow AGTS TABLE 31. A P0 — cross-tenant exposure, PII
exposure, or protected-assessment leakage at scale — disables the affected path
or manifest immediately and preserves evidence.

---

## 10. API

### 10.1 Retrieval service (Python, internal)

```http
POST /v1/evidence/retrieve
```

**Request** — a validated `QueryPlan`:

```jsonc
{
  "interaction_id": "uuid",          // idempotency key
  "tenant_id": "uuid",
  "actor": { "pseudonymous_id": "…", "role": "learner|teacher" },
  "curriculum_version": "cbse-2026.1",
  "concept_ids": ["…"], "outcome_ids": ["…"],
  "teaching_action": "explain|diagnose|hint|worked_example|check|compare|diagram|quiz|revision",
  "learner_state_class": "cold_start|prerequisite_gap|misconception|partial|mastered|forgetting",
  "task_context": "learn|guided_practice|homework|graded|post_submission|exam_revision",
  "language_plan": { "query": "hinglish", "response": "en" },
  "required_evidence_types": ["definition","example","misconception"],
  "forbidden_object_types": ["solution","rubric"],
  "source_authority_min": "board_official",
  "filters": { "grade": "10", "subject": "science",
               "assessment_mode": "graded", "entitlements": ["…"] },
  "subqueries": [{ "text": "…", "lexical_variants": ["…"] }],
  "generators": ["lexical","dense","hierarchy","graph"],
  "quotas": { "k_pack": 5, "max_per_source": 2 },
  "max_graph_hops": 2,
  "latency_budget_ms": 550,
  "trace_sampling": 1.0
}
```

**Response** — an `EvidencePack`:

```jsonc
{
  "interaction_id": "uuid",
  "status": "SUFFICIENT|INSUFFICIENT|CLARIFY|ABSTAIN|ESCALATE",
  "reason_codes": ["…"],
  "evidence": [{
    "object_id": "uuid", "object_type": "explanatory_unit",
    "text": "…", "heading_path": "…",
    "source": { "source_id":"…", "version":"…", "page":142,
                "region":[x,y,w,h], "offsets":[0,412] },
    "authority_tier": "board_official",
    "rights": { "quotation_ok": true, "display_limit": "…" },
    "concept_ids": ["…"], "evidence_role": "definition",
    "rerank_score": 0.87, "generators": ["dense","lexical"]
  }],
  "citations": [{ "citation_id":"c1", "object_id":"…", "span":[0,412] }],
  "sufficiency": { "authority":"pass", "coverage":"pass", "disclosure":"pass",
                   "conflict":"pass", "modality":"pass" },
  "trace_id": "uuid",
  "index_manifest_id": "uuid"
}
```

**Invariants** (enforced, tested, and gated):

- `learner_state_write = none` — this endpoint never writes learner truth.
- Every citation resolves to an **active, authorised** span in
  `index_manifest_id`.
- `task_context = "graded"` ⟹ no object with
  `disclosure_class ∈ {solution, rubric, protected_item}` is addressable —
  filtered **before** scoring, not after.
- Identical `interaction_id` is **idempotent**.
- Response always carries `trace_id` and `index_manifest_id`. Missing lineage is
  a fail-closed defect (AGTS TABLE 35).

### 10.2 Supporting endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/evidence/resolve-citations` | Batch-validate citation ids against the live manifest. Used by the output verifier. |
| `GET /v1/evidence/trace/{trace_id}` | Full retrieval trace. Governed debug policy — raw content sampled only under approval. |
| `POST /v1/concepts/resolve` | Language-neutral concept resolution. En / Hindi / Hinglish / transliterated / noisy → `concept_ids`. |
| `GET /v1/manifest/current` | Active manifest id and its version tuple. |
| `POST /v1/admin/reindex` | Control plane. Builds a shadow manifest; never touches the serving alias. |

### 10.3 TS API layer

Owns auth, session, rate limiting, SSE streaming to the client, and the
renderer call. It calls §10.1 and **never queries the retrieval store
directly** — a second query path drifts from the first and bypasses §6.2's
prefilter.

### 10.4 Latency budget

AGTS TABLE 12, apportioned to this module:

| Stage | p95 budget | On breach |
|---|---|---|
| Policy prefilter + plan validation | 60 ms | fail closed |
| Canonicalisation (cache miss) | 90 ms | fall back to raw query, flag in trace |
| Generators + fusion | 300 ms | cancel optional stragglers; **never** below the minimum-evidence rule |
| Rerank + sufficiency gate | 250 ms | reduce candidate depth; **no uncontrolled loops** |
| **Total, module** | **≤ 550 ms** | |

Quality and safety gates take precedence over latency. Degrading below the
minimum evidence rule to hit a budget is a G2 failure, not an optimisation.

---

## 11. Evaluation

**Built first, in Phase 0, before any ingestion code exists.**

### 11.1 Phase 0 bake-off

Embedding and reranker chosen by measurement on this corpus, never by
leaderboard (AGTS §6.2, and its non-goal: *"No release based solely on a
benchmark leaderboard, synthetic judge score, or qualitative demo."*).

- **Data**: the Phase 0 labelled set over the Phase 0 corpus slice.
- **Primary**: `recall@20` (G1) for embedders; `recall@k_pack` (G2) for rerankers.
- **Secondary**: same metrics on the **Hinglish** subset — romanised input is
  where multilingual models diverge most from their English numbers.
- **Tie-break**, in order: Hinglish recall → p95 latency → cost.
- **Output**: decision recorded with the full measurement table, committed.
  `embedding_model` is stored per object, so a corpus can always say what
  produced it.

### 11.2 Gold sets

| Set | Target | Purpose |
|---|---|---|
| Answerable | 300-500 | Gold spans, evidence types, reference answer. Stratified per §2.2 axes. |
| Unanswerable / insufficient | 100+ | Out of grade, out of corpus, superseded, unapproved, conflicting, absent. Drives G5. |
| Adversarial | 100+ | Injection, poisoning, answer extraction, cross-tenant, citation spoof. Drives G6/G7. |
| Hinglish + noisy | 100+ | Parallel to the answerable set where possible, so the delta is measured rather than inferred. |
| **Hidden holdout** | frozen | Release-critical. Leakage-checked against training data, prompt examples, and live assessment banks. |

AGTS §12.3: *"a gold set of only answerable textbook questions is invalid."*

### 11.3 Gold labels anchor to `block_ids`, never object ids

An object counts as gold if it covers **any** gold block.

This is what lets the gold set survive re-chunking. Anchored to object ids, every
chunking experiment invalidates the entire eval set — so the experiments stop
being run, and the recall left behind in the parser and composer is never
recovered. Anchoring to blocks makes chunking a free variable, which is why
`blocks` exists as a table (§4.1).

### 11.4 Construction

**Seed by generation, verify by human.** A model reads an object and writes the
question it answers; a curriculum reviewer confirms the question is natural, the
answer is genuinely in the corpus, and the gold spans are right.

**Unverified generated questions never enter a gating set.** A generated question
is drawn from the object it was generated from, so an unverified set measures the
generator's phrasing rather than the retriever's ability — and it scores high
while meaning nothing.

**Release-critical cases need two trained curriculum adjudicators**, with
disagreements resolved and inter-rater reliability tracked (AGTS §12.3).

Once live, mine `retrieval_traces` for real queries and label those. Production
distribution beats authored distribution every time.

### 11.5 Coverage beyond the gold set

AGTS §12.2. The scenario space is combinatorial; enumeration is not an option
and pretending otherwise is worse than admitting it.

| Technique | Scope |
|---|---|
| **Exhaustive** | Tenant/role ACL, approval/rights/active filters, graded disclosure, citation resolution, deletion tombstones. Every valid and invalid value. **Zero tolerated failures.** |
| **2-way** | All pairs across §2.2 axes. Constrained covering arrays [R44]. Pairwise is the floor, not the ceiling. |
| **3-way** | action × learner_state × evidence_condition; language × modality × accessibility; grade × subject × cognitive_demand. Every release. |
| **4-6-way** | Graded mode, tenant/role, protected content, injection. Risk-owned. |
| **Property / metamorphic** | Typos, transliteration, malformed PDFs, empty and contradictory turns, extreme lengths. |
| **Counterfactual** | Same question, different learner state. **Facts and citations must be identical**; only support and disclosure may differ. |

### 11.6 Gate runner

CI. Runs on any change to model, chunking, parser, prompt, graph, or retrieval
config. Compares against the stored baseline. A regression on any gate, on any
gating slice, blocks the merge. Every run stored with git sha, config, and
manifest id — so any number in this system can be traced back to the code that
produced it.

**Change-specific regression scope** per AGTS TABLE 42: an embedding, index, or
reranker change triggers the *full* retrieval suite plus all slices plus latency
and cost plus the protected/tenant filter suite. Not a subset.

---

## 12. Phases

Each phase gets its own implementation plan. This document is the design for all
of them and the detailed spec for none.

### Phase 0 — Contract and measurement · ~2 weeks

No ingestion. Prove measurement works before building the thing to be measured.

- Concept/outcome identifiers and versioning rules for the slice.
  **AGTS §14.3 is explicit: do not start embeddings first.**
- Rights policy + data-purpose map approved; source permissions secured.
- `eval_cases` schema; one chapter parsed by throwaway script into blocks.
- 50 hand-labelled cases, **block-anchored**, including unanswerable and
  adversarial.
- Gate runner computing G1/G2 with per-slice breakdown from day one.
- **Embedding + reranker bake-off** (§11.1), decision committed.
- `QueryPlan` / `EvidencePack` schemas, **with no generative renderer** — prove
  the filter and disclosure invariants first.

**Exit:** a real recall number on a real chapter, reproducible from a git sha,
and a signed rights basis for the Phase 1 corpus.

### Phase 1 — Vertical slice · ~4-5 weeks

**NCERT Science grade 10, plus one small NCERT Mathematics chapter as a LaTeX
risk probe.**

Science carries the phase because it exercises the figure/VLM path. The
mathematics chapter is deliberately small and deliberately present: equation
extraction is the highest-variance risk in this build, and discovering that the
parser mangles NCERT notation is worth an order of magnitude more in week 4 than
in week 12. It is a probe, not coverage — one chapter, gated on its own slice,
with a decision attached.

- S0-S8 pipeline, quarantine through signed manifest.
- Four generators: lexical, dense, hierarchy, reduced graph.
- Cross-encoder rerank, sufficiency gate, bounded correction.
- Gold set ~100 cases including the mathematics slice.
- **G0, G1, G2, G7 green per slice.**

**Decision point:** if the mathematics slice fails on extraction quality, Phase 2
changes before it is written — Mathpix promotes from fallback to primary for
mathematics sources, or the parser is reconsidered entirely.

### Phase 2 — Scale · ~4 weeks

All NCERT 6-12, mathematics and science. Exemplar and PYQ with their own
composition rules and disclosure classes. Gold set to 300+, every gating slice at
n ≥ 20. Recalibrate the sufficiency threshold against the grown corpus.

**Exit:** G0-G2, G5, G7 green per slice across the full NCERT corpus, plus the
**retrieval half of G6** — zero solution or rubric objects addressable in graded
mode. The output half of G6 needs a renderer and lands in Phase 3.

### Phase 3 — Verification and serving · ~3 weeks

TS API layer, structured evidence delivery, three-level citation verification,
disclosure verifier, SSE streaming, latency budgets enforced.

**Exit:** G3, G4, G8 green per slice, and G6 complete — the output verifier
closing the half Phase 2 could not reach.

### Phase 4 — Language, visual, graph · ~4-5 weeks

Hinglish canonicalisation and glossary; reviewed Hindi objects; learned-sparse
generator; visual page-region pilot; full curriculum graph with reviewed edges;
late-interaction pilot evaluated against the scaling rule.

**Exit:** Hinglish slice ≥ 90%; visual slice G1 ≥ 90%; multihop slice improved
against its Phase 2 baseline.

### Phase 5 — Assurance and expansion

Full combinatorial suites, red team, load and failure testing, shadow replay,
third-party sources under their rights constraints, remaining subjects, and a
narrow escape hatch for question classes Approach A is by then *measured* to
fail.

**~17-19 weeks to green module gates**, up from v1's 10-14. The increase is
rights approval, pre-retrieval policy filters, the security suite, and the
curriculum graph — all four are AGTS requirements v1 did not carry, and none of
them is optional. This is the retrieval module only. AGTS's
full 24-30 week estimate includes the pedagogy controller, learner model,
assessment integrity, and pilot — none of which are in this scope. **Do not
report this timeline as delivering AGTS.**

---

## 13. Known ceilings

Stated plainly, because a design that hides its limits produces a green
dashboard and unhappy users.

1. **Math parsing is the highest-variance risk in the build.** Bad LaTeX
   extraction caps mathematics retrieval and no reranker recovers it. Hence the
   Phase 1 probe rather than deferring all mathematics to Phase 2.
2. **Multi-hop is a structural ceiling** until the full graph lands. Floored at
   75% (§2.2); raising it is the Phase 4 graph's explicit success criterion.
3. **Numerical and procedural questions are not retrieval problems.** Excluded
   from G1-G2 by name, tracked separately, routed to the Tool Broker.
4. **Gold label quality bounds everything.** A sloppy gold set produces a
   confident, fake 90%, and the discovery channel becomes user complaints. Human
   verification of every gating case is not optional.
5. **Hinglish degrades lexical retrieval sharply.** Gated as its own slice
   precisely so it cannot hide inside an average.
6. ~~**Rights may shrink the corpus.**~~ **Withdrawn 21 August 2026 (D-397).**
   The client states rights to NCERT and the other books are already held, so
   this is no longer a ceiling and no longer on the critical path. The
   `rights_register` and the quarantine transition **stay in §4.2 and §5** —
   one row per source costs nearly nothing and is the only thing that lets the
   rights position be *proved* later rather than asserted. Sources start
   APPROVED with their basis recorded. If the position later proves narrower
   for one source, the mechanism quarantines that source alone.
7. **AGTS thresholds are provisional.** Its §13 says so directly — they require
   baselining on the approved corpus and ratification. Treat the numbers in §2
   as targets to be confirmed in Phase 0, not as measured promises.
