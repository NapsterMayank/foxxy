# Phase 0 — hands-on how-to

**Date:** 21 August 2026 · **Track B** · For someone building production RAG for the first time.

Read `2026-08-21-rag-build-guide.md` for the whole plan. This file is Phase 0 only, in detail, with code.

---

## The mental model to fix first

```
Wrong:  PDF ──────────────────────────────▶ Voyage ──▶ done
Right:  PDF ──▶ parse ──▶ blocks ──▶ chunks ──▶ Voyage ──▶ Postgres
                                                              │
                                              50 questions ───┤
                                              + answer key    │
                                                              ▼
                                                         A NUMBER
```

**The number is the deliverable of Phase 0. Not the retriever.** The retriever you write here is throwaway code deleted in Phase 1. What survives is the answer key and the scoring script.

---

## Day 1 — Setup and parse

### Get the chapter

NCERT ships one PDF per chapter. Class 10 Science Ch 9 is `jesc109.pdf` on ncert.nic.in. No splitting needed.

**Recommended chapter: "Light: Reflection and Refraction."** Prose, equations, ray diagrams and tables, so the baseline is honest rather than flattering. Foxxy holds it as ch 9, giving a comparison number.

### Postgres

```bash
docker run -d --name rag-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=rag \
  pgvector/pgvector:pg16
```

**Port 5433 deliberately.** 5432 is Foxxy's and these two must never touch.

### Python

```bash
pip install docling psycopg[binary] voyageai tiktoken numpy
```

### Schema — Phase 0 only, throwaway

The real schema is in the spec and gets built in Phase 1. This is the minimum that proves measurement works.

```sql
create extension if not exists vector;

create table blocks (
  id           text primary key,     -- 'b_0042'
  page         int  not null,
  order_index  int  not null,        -- reading order within the chapter
  block_type   text not null,        -- heading|paragraph|equation|table|figure|list
  text         text not null,
  heading_path text                  -- 'Light > Refraction > Laws of Refraction'
);

create table chunks (
  id         text primary key,
  block_ids  text[] not null,        -- THE LINK. Everything depends on this.
  text       text   not null,
  embedding  vector(1024)
);

create table eval_questions (
  id              int primary key,
  query           text not null,
  gold_block_ids  text[] not null,   -- the answer key
  question_type   text,
  answerable      bool default true
);
```

### Parse

```python
from docling.document_converter import DocumentConverter

doc = DocumentConverter().convert("jesc109.pdf").document

blocks, heading_stack, i = [], [], 0
for item, _ in doc.iterate_items():
    text = (getattr(item, "text", "") or "").strip()
    if not text:
        continue
    kind = item.label            # 'section_header', 'text', 'formula', 'table'...

    if kind in ("section_header", "title"):
        heading_stack = [text]

    blocks.append({
        "id": f"b_{i:04d}",
        "page": item.prov[0].page_no if item.prov else 0,
        "order_index": i,
        "block_type": kind,
        "text": text,
        "heading_path": " > ".join(heading_stack),
    })
    i += 1
```

Insert into `blocks`.

> **NEVER DELETE THIS TABLE.** It is exactly what Foxxy lost — its chunks came from a pipeline in a dead repo fed by PDFs held nowhere, so it can never be re-chunked at any price.

> **Check before moving on:** print block count and which pages are covered. **A page producing zero blocks means the parser failed on it.** Find out why now, not in week 12.

---

## Day 2 — Chunking

### Why chunk at all

- **Whole pages are too big.** A page holds five ideas; its embedding averages all five, so it matches every query weakly and no query strongly.
- **Single sentences are too small.** *"This is because of refraction"* has no standalone meaning.
- **~250 tokens** is the sweet spot for textbook prose.

### Phase 0 simplification

**Single-level chunks only.** Skip the parent/child scheme in the spec — get the loop working first. Parent/child lands in Phase 1.

```python
MAX_TOKENS = 250
ATOMIC = {"formula", "table", "figure"}   # never split these

def ntok(s):
    return int(len(s.split()) * 1.3)      # good enough for Phase 0

def build_chunks(blocks):
    chunks, buf, n = [], [], 0

    def flush():
        nonlocal buf, n
        if not buf:
            return
        head = buf[0]["heading_path"]
        body = "\n".join(b["text"] for b in buf)
        chunks.append({
            "id": f"c_{len(chunks):04d}",
            "block_ids": [b["id"] for b in buf],
            # heading path goes INTO the embedded text - cheap, real recall gain
            "text": f"{head}\n\n{body}" if head else body,
        })
        buf, n = [], 0

    for b in blocks:
        if b["block_type"] in ("section_header", "title"):
            flush()                       # new section = new chunk
            continue
        if b["block_type"] in ATOMIC:
            flush()
            buf = [b]; flush()            # atomic block gets its own chunk
            continue
        if n + ntok(b["text"]) > MAX_TOKENS:
            flush()
        buf.append(b); n += ntok(b["text"])

    flush()
    return chunks
```

### The four rules doing the work

1. **Break at headings.** A section boundary is a meaning boundary.
2. **Never split equations or tables.** Half a formula retrieves nothing.
3. **Prepend the heading path.** Makes each chunk self-describing and disambiguates chapters that reuse section names.
4. **Record `block_ids`.** This is what lets you re-chunk without re-labelling. **Do not skip it.**

Expect ~80-150 chunks from one chapter.

---

## Day 2 (cont.) — Embed

```python
import voyageai
vo = voyageai.Client()

for batch in batched(chunks, 128):
    vecs = vo.embed([c["text"] for c in batch],
                    model="voyage-3", input_type="document").embeddings
    # store into chunks.embedding
```

**`input_type` matters.** `"document"` when storing, `"query"` when searching. Voyage embeds the two differently and mixing them costs real accuracy.

```sql
create index on chunks using hnsw (embedding vector_cosine_ops);
```

> **Check:** `select count(*) from chunks where embedding is null;` must be **0**.
> Foxxy has 20 active chunks with no vector, invisible to dense search, found by hand months later. A chunk that fails to embed **fails the run** — it never gets stored blank to be noticed later.

---

## Day 3 — Retrieve and score

### Retrieve

```python
qv = vo.embed([question], model="voyage-3", input_type="query").embeddings[0]

cur.execute("""
  select id, block_ids, text
  from chunks
  order by embedding <=> %s::vector
  limit %s
""", (str(qv), k))
```

### Score

```python
def recall_at_k(questions, k):
    hits = 0
    for q in questions:
        found = set()
        for c in retrieve(q["query"], k):
            found |= set(c["block_ids"])
        if found & set(q["gold_block_ids"]):
            hits += 1
    return hits / len(questions)
```

**A chunk counts as correct if it contains any gold block.** That single line is why `block_ids` exists: change your chunking tomorrow and this still works, with zero relabelling.

Report **per slice** from day one — answerable vs unanswerable, English vs Hinglish. One average hides everything.

---

## Days 4-5 — The answer key (human work)

Dump blocks for reading: `block_id`, `page`, first ~100 characters → CSV → open in Excel.

Write 50 questions:

| Count | Kind | Example |
|---|---|---|
| 35 | Answerable, phrased how a student actually types | `why does a pencil look bent in water` |
| 10 | **Unanswerable** | `who invented the telephone` · `explain integration` |
| 5 | Hinglish | `pencil paani me tedhi kyun dikhti hai` |

```json
{"id": 1,
 "query": "why does a pencil look bent when kept in water",
 "gold_block_ids": ["b_0042", "b_0043"],
 "question_type": "factual",
 "answerable": true}
```

Unanswerable questions get `"gold_block_ids": []` — correct behaviour is retrieving nothing above threshold.

**Budget 4-6 hours**, plus ~2 for the concept list.

**Faster:** have an LLM read each block and draft the question it answers, then verify every one by hand.

> **Verify every single one.** An unverified generated question is written *from* the block it points at, so it scores near 100% and measures nothing. This is the single easiest way to produce a fake number and believe it.

---

## Day 6 — First real number

Run it. **Expect recall@10 around 70-85% dense-only.**

If you get 95% on the first attempt, your questions are too easy — they are probably echoing the chapter's own wording instead of how a student would ask.

### Test the tester

Deliberately break retrieval — return random chunks. **The number must collapse to near zero.** A scorer that cannot fail is not measuring anything.

---

## Days 7-8 — The bake-off

Add one component at a time and watch the number move. This is how you learn what actually pays for itself.

| Step | Added | Typical recall@10 |
|---|---|---|
| 1 | Dense only (voyage-3) | ~75% |
| 2 | + BM25, merged with RRF | ~85% |
| 3 | + cross-encoder rerank | recall@3 jumps hard |

**If a component does not move the number, you just learned it is not worth its cost.** That is a real result, not a failure.

Then swap embedders — BGE-M3, Qwen3-Embedding, multilingual-e5-large — same 50 questions, same script, same slices. Record the table and commit it.

**Check the Hinglish 5 separately.** That is where multilingual models diverge most from their English numbers, and it is invisible in an average.

---

## Definition of done

- [ ] Scoring script prints a number, reproducible from a git commit
- [ ] Proven the script can fail (broken retriever → near zero)
- [ ] 50 human-verified questions, anchored to `block_ids`
- [ ] Per-slice reporting working (answerable / unanswerable / Hinglish)
- [ ] Bake-off table committed, winner named with its measurements
- [ ] Zero chunks with a null embedding
- [ ] `blocks` table intact and backed up

**Only then** write Phase 1's real ingestion pipeline.

---

## The three mistakes that ruin Phase 0

1. **Writing the retriever before the answer key.** You end up tuning against a number you invented, and the whole project inherits it. This is precisely what happened to Foxxy: 3,892 lines of careful retrieval, no gold chunk ids, correctness never once computed.
2. **Not recording `block_ids` on chunks.** Then every chunking experiment costs a full re-label, so the experiments stop, so the recall left in the parser is never recovered.
3. **Trusting generated questions.** They score high and measure nothing. Human-verify all 50.
