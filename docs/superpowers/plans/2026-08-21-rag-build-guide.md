# RAG Build Guide — what to do, in order

> ## SUPERSEDED — 24 August 2026 (D-398)
>
> The client supplied its own **AI-Native Build Guide** (revised 22 August): a
> 72-hour parallel-agent execution model with blocking human approval gates,
> replacing the 17-19 week plan below. That document is now **authority 2** and
> this file is **authority 3** — implementation detail, consulted where the
> client guide is silent, overridden where it is not.
>
> **Code lives in `D:\personal\agts-retrieval`.** Phase 0 is built there.
>
> Two things below are now **wrong**, not merely outdated:
>
> - **Rights are blocking again.** The cleared checkbox reflects D-397. The
>   client's own §5 reinstates quarantine-by-default and states that verbal
>   assurance is not a rights record (D-399).
> - **The timeline.** ~17-19 weeks assumed human-paced work. Most of it was
>   code, and code compresses; the human assurance window does not.
>
> Still load-bearing and worth reading: the five rules, the blocks/chunks
> separation, block-anchored gold labels, and per-slice scoring. All four
> survive into the client guide as its rules 3, 4 and 9.

**Date:** 21 August 2026
**Track B** — the new retrieval module. **Changes nothing in Foxxy**, whose own
`retrieval` module is permanently out of scope (D-387). Track A is the Foxxy
product, in `PROGRESS.md`.

## How to use this file

| Document | What it is | Read it when |
|---|---|---|
| **this file** | The plain-language build order. What to do first, second, third. | You are working, or you want to know where the project is |
| `docs/superpowers/specs/2026-08-20-ncert-rag-design.md` | The design record. Schemas, contracts, model choices, exact thresholds. | You are implementing a step and need the detail |
| `docs/03-DECISION-LOG.md` D-387..D-397 | Why each hard choice was made | You are about to change one of them |
| `docs/superpowers/plans/2026-08-21-phase-0-howto.md` | Phase 0 hands-on, day by day, with runnable code | You are actually building Phase 0 |
| AGTS dossier (client, `D:\Downloads\`) | The parent architecture. This module implements its §5-6. | You need the wider system context |

**If this file and the spec disagree, the spec wins** — it is more precise. This file exists to be readable.

---

## Why this project exists

Foxxy's retrieval is 3,892 lines of hybrid search with rank fusion, deduplication, a calibrated abstention floor, and a per-turn trace. It is careful work.

Its test set is `{ query, grade, subject, note }`. **There is no answer key.** So retrieval correctness has never been computed — not badly, *never*. And its chunks came from a pipeline in a repository that no longer exists, fed by PDFs held nowhere, so it can never be re-chunked either.

Two failures, and everything below is shaped by avoiding them:

1. **Build the ruler before the thing you measure.**
2. **Never destroy the ability to redo a step you will redo often.**

---

## Before anything — client decisions

- [x] ~~**Written permission for the books.**~~ **CLEARED 21 August 2026.** The
      client states rights to NCERT and the other books are already held. This is
      no longer a blocker and Phase 1 is not gated on it.
      *Still worth ten minutes:* fill in one `rights_register` row per source
      (owner, basis, approver, date). The quarantine mechanism stays in the
      design because it is nearly free and it is what lets you *prove* the claim
      later — but it starts APPROVED rather than blocking.
- [ ] **Name the pilot.** One grade, one mathematics chapter, one science
      chapter, and which board and edition. **Still open — this is now the only
      thing gating Phase 1.**

---

## Phase 0 — Can we measure? · ~2 weeks

> **Hands-on detail with code:** `2026-08-21-phase-0-howto.md` — day-by-day,
> schema, parsing, chunking, embedding, scoring. Read that to actually build it;
> the checklist below is the summary.

**You build no retrieval in this phase.** You build the ruler.

**You do not type the chapter in.** You point a script at one PDF. The manual
work is the *answer key*, not the content. Everything in the scripted column
below is disposable code you throw away in Phase 1.

| Scripted (throwaway) | Human |
|---|---|
| Parse the PDF → blocks | Pick the chapter |
| Chunk blocks → chunks | Write the concept list |
| Embed | Write 50 questions |
| Search + score | **Mark which block(s) answer each question** |

- [ ] Pick **one** science chapter, grade 10. **Recommended: "Light: Reflection
      and Refraction."** It has prose, equations (mirror and lens formulae), ray
      diagrams and tables, so the baseline is honest rather than flattering — and
      Foxxy's corpus holds it as ch 9, giving a direct comparison number.
      Figure questions will score badly here; the throwaway parser has no figure
      handling, and that gap is what Phase 1's VLM step gets measured against.
- [ ] A human writes the concept list for that chapter — 20-30 ideas, each with an ID. **Not the LLM.** This list is the spine everything else hangs off.
- [ ] Throwaway script parses that one PDF into **blocks**: paragraphs, headings, equations, figures — each with page number and position.
- [ ] **Write 50 questions and mark their answers.** The real work of the phase:
  - 35 a student would actually ask, each tagged with which block(s) hold the answer
  - 10 the chapter *cannot* answer — wrong grade, wrong subject, nonsense
  - 5 Hinglish versions of the answerable ones
  - Every single one verified by a human

  **How, practically:** the parse script dumps blocks to JSON/CSV — `block_id`,
  `page`, first ~100 characters. Read a question, scan the list, write down the
  block ids that hold the answer. **Budget ~4-6 hours for the 50**, plus ~2 for
  the concept list. One person, roughly a day.

  **Faster:** let an LLM read each block and draft the question it answers, then
  a human confirms the question is natural and the block is right — about 10×
  faster than writing cold. **Verify every one.** An unverified generated
  question is drawn from the block it came from, so it scores high and measures
  nothing.
- [ ] Build the scoring script: question in → chunks back → is a gold block among them → print a percentage.
- [ ] **Model bake-off.** 5 embedding models × 3 rerankers against those 50 questions. Record the table, commit it.
- [ ] Write the QueryPlan and EvidencePack schemas — **with no generative model attached.** Prove the filter and disclosure rules first.

**Test the tester:** hand the scoring script a deliberately broken retriever and confirm the number drops. A scorer that cannot fail is not measuring anything.

> ### Guardrail
> **No ingestion code is written until the scoring script prints a real number, reproducible from a git commit.**

---

## Phase 1 — Does it work on a small slice? · ~4-5 weeks

**Scope:** NCERT Science grade 10 — **plus one small mathematics chapter.**

That maths chapter is not coverage, it is a tripwire. Equation extraction is the most likely thing to quietly ruin this build. Finding out in week 4 costs a tenth of finding out in week 12.

### Build, in this order

- [ ] **1. Register every source** — owner, permission, checksum, edition. Default state **QUARANTINED**. A human approves before a parser may open the file.
- [ ] **2. Scan** for malware, PDF bombs, hidden text, injected instructions — *before* any parser or model sees the file.
- [ ] **3. Parse** with Docling → blocks. Equations → LaTeX, tables → markdown, figures → cropped images. **This is the expensive, irreversible step.**
- [ ] **4. Describe every figure** — Claude Sonnet 5, given the crop plus its caption plus surrounding text. Ask what the figure *shows in retrieval terms*, not for prose appreciation.
- [ ] **5. Build chunks from blocks** — small child (~250 tok) for searching, big parent (~1000 tok) for answering. The sentence that *matches* a query is rarely the span that *answers* it.
- [ ] **6. Tag chunks with concept IDs** — LLM proposes, human reviews.
- [ ] **7. Find and kill duplicates.**
- [ ] **8. Embed everything.**
- [ ] **9. Build the search** — keyword and vector in parallel → merge → **rerank with a cross-encoder** → top 5.
- [ ] **10. Add the sufficiency check** — score too low, abstain. Abstention is a successful outcome, decided before any model is called.

**Never split** an equation, a table, or a question from its answer. Those are the chunking bugs that cost recall silently.

### Testing

- [ ] After parsing — does **every** page produce blocks? Does every mathematics document produce equation blocks? A page yielding zero blocks **stops the run**.
- [ ] After embedding — **zero** chunks without a vector. A chunk that fails to embed **fails the run**. It never gets imported blank to be noticed later.
- [ ] Grow the gold set 50 → 100 questions.
- [ ] Score **each slice separately** — science, maths, Hinglish.

> ### Guardrails to pass Phase 1
> | Check | Bar |
> |---|---|
> | Right passage in the top 20 candidates | **95%** |
> | Right passage survives into the final 5 | **90%** |
> | Content from an unapproved source ever returned | **0** |
>
> **Every slice on its own.** Maths at 60% with science at 95% is a **fail** — not an 88% pass.

### Decision point

If maths fails because equations came out as scrambled characters, **switch to Mathpix before Phase 2 is planned** — not after 12 grades have been parsed with a broken parser.

---

## Phase 2 — Does it hold at full size? · ~4 weeks

- [ ] Same pipeline over all NCERT 6-12, mathematics and science.
- [ ] Exemplar and previous-year papers — **different chunking rules.** Question and answer stay glued together, and **solutions become separate objects with their own lock**, so a student mid-test cannot address them at all.
- [ ] Gold set 100 → **300+**, minimum 20 questions per slice.
- [ ] **Re-measure the abstain threshold.** A bigger corpus shifts the score distribution, so the Phase 1 threshold is now wrong.

### Testing

- [ ] Everything from Phase 1, at scale.
- [ ] **100,000 synthetic attack queries.** Try to retrieve another school's content. Try to retrieve a solution during a graded test. Try to retrieve a retired chapter.

> ### Guardrail
> **Zero leaks. Not "low" — zero.** One incident in this category is a company problem, not a bug.

---

## Phase 3 — Does the answer match the source? · ~3 weeks

Only now does a model write prose.

- [ ] TypeScript API — auth, rate limits, streaming.
- [ ] Chunks passed as **structured records with IDs**, never a pasted blob.
- [ ] Model must cite chunk IDs.
- [ ] Check every cited ID exists. *(Foxxy already does this.)*
- [ ] **Check every sentence is actually supported by the chunk it cites** — entailment model, strip what is not. This is the step that takes faithfulness from ~85% to 95%.
- [ ] A **different** model judges correctness against the reference answers. A model grading its own output grades generously.

> ### Guardrails
> 95% of claims traceable to a cited chunk · 98% citation precision · **zero** solution leakage in rendered output · retrieval under 550 ms.

---

## Phase 4 — Hinglish, diagrams, graph · ~4-5 weeks

- [ ] Hinglish dictionary (~2k education terms) with an LLM fallback on miss. **Keep sending the raw query to keyword search** — `refraction`, `sodium`, `velocity` survive inside Hinglish, and that is real signal you would throw away by translating first.
- [ ] Hindi books ingested and reviewed.
- [ ] Page-image retrieval for diagrams.
- [ ] Full concept graph with prerequisite edges — this is what lifts multi-hop questions.

> ### Guardrail
> Hinglish scores **≥90% on its own slice**, never blended into an average.

---

## Phase 5 — Prove it, then grow

- [ ] Red team.
- [ ] Load and failure testing.
- [ ] Shadow traffic against real queries.
- [ ] Third-party books under their licences.
- [ ] Remaining subjects.

---

## Your literal first week

1. **Ask the client for the two decisions at the top.** Today.
2. Pick the science chapter.
3. Sit with a curriculum person and write the concept list.
4. Write the 50 questions and mark their answers.
5. Build the scoring script.

Steps 3 and 4 are human work, and they are the ones that decide whether the number you eventually report is real.

---

## The five rules everything hangs off

1. **Measure before you build.** The ruler comes first.
2. **Keep blocks and chunks separate.** Blocks are what you parsed; chunks are how you sliced it. Slicing changes ten times; parsing costs real money. Foxxy can never re-chunk, because its parse output is gone.
3. **Anchor the answer key to blocks, not chunks.** Otherwise every chunking experiment destroys the test set, so you stop experimenting, so you never find the missing 20 points.
4. **Every slice gets its own number.** One average hides the grade that is broken.
5. **Filter before you score, never after.** A solution that got scored and then discarded still touched the ranking — and is one bug away from touching a student.

---

## Timeline

| Phase | Weeks | Cumulative |
|---|---|---|
| 0 — Measure | 2 | 2 |
| 1 — Small slice | 4-5 | 6-7 |
| 2 — Full size | 4 | 10-11 |
| 3 — Answers | 3 | 13-14 |
| 4 — Language, visual, graph | 4-5 | 17-19 |
| 5 — Assurance and growth | ongoing | — |

**~17-19 weeks** to green gates. Phases 0 and 1 are ~7 of those, and they decide whether the rest is worth building.

**This is the retrieval module only.** AGTS's own 24-30 week estimate additionally covers the pedagogy controller, learner model, assessment integrity, and a learning pilot — none of which are in this scope. **Do not report this timeline as delivering AGTS.**
