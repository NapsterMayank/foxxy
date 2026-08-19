# Adaptive practice difficulty, timed per question — design

**Date:** 19 August 2026
**Status:** proposed, awaiting review
**Decisions it will produce:** D-384 (serve-on-demand sessions), D-385 (the ladder), D-386 (frozen time targets)

---

## 1. What is being asked for

A student's pace on each question decides what they get next. Two questions
answered correctly and inside a time target make the next one harder; a wrong
answer, or a pattern of labouring, makes it easier. Every question's time is
recorded so it can be reported on later.

**No screens change.** The timing is an internal record for now — reporting on
it is a separate piece of work with its own copy decisions.

## 2. What already exists

This is less new than it looks.

| Already there | Where |
|---|---|
| Per-question timing, recorded on every answer | `practice_responses.time_spent_ms`, NOT NULL |
| The difficulty of the question as authored | `questions.difficulty` — easy / medium / hard, on all 2,741 |
| That difficulty frozen onto the answer | `practice_responses.authored_difficulty`, so a later correction cannot rewrite history |
| A server-side backstop against a lying client | `submitSession` clamps the claimed total to `now - started_at` |
| Nine pure domain rules with tests, no I/O | `src/modules/practice/domain/` |

**The corpus supports the ladder.** 134 chapters hold active questions,
averaging 20.5 each; 127 of them have all three difficulties. Three chapters
have no `hard` and three have no `easy` — §7 says what happens there.

## 3. The obstacle, and the decision taken

`POST /practice/sessions` draws every question up front, freezes their ids in
`practice_sessions.question_ids`, builds one option-shuffle map for all of them,
and hands the whole set to the client. Nothing downstream can change what
question 3 is, because question 3 was chosen before question 1 was answered.

**Decision: sessions serve one question at a time.** A session begins with a
target length and its first question. Each answer returns the next one, chosen
by the ladder from what that student has just done.

The alternative considered — keep the frozen set of N and rewrite the
unanswered tail — lands the same behaviour for less work, and was rejected for
one reason: it leaves a column called `question_ids` that the schema presents as
the session's questions and the service quietly rewrites mid-session. This
codebase has repeatedly paid for shapes that describe something other than what
they do (D-283, D-361). Serving on demand makes the data honest: `question_ids`
becomes the list of questions actually served, in the order served.

**A side benefit worth naming:** the client stops receiving questions the
student has not reached yet.

## 4. Schema changes

Two columns and one migration. Both follow the freeze-what-was-used pattern
`authored_difficulty` already sets.

```sql
ALTER TABLE practice_sessions
  ADD COLUMN target_question_count integer NOT NULL DEFAULT 6
    CHECK (target_question_count BETWEEN 1 AND 20);

ALTER TABLE practice_responses
  ADD COLUMN time_target_ms integer NOT NULL DEFAULT 45000
    CHECK (time_target_ms > 0);
```

**`target_question_count` is required by the serving model.** Today
`questionCount` means `question_ids.length`, and scoring, the anti-cheat count
rule and the progress indicator all read it. Once ids are appended as the
session runs, that length is "how far the student has got", which is a different
number. The target is what those three must use.

**`time_target_ms` is what makes the record reportable.** It stores the target
in force when that question was served. Without it, retuning the constants in
§5 silently rewrites what "fast" meant for every answer ever recorded, and last
term's report changes shape because somebody edited a constant this term.

The defaults exist for the rows that are already there and are dropped from the
column afterwards for `time_target_ms` — a default target on a new answer would
be a target nobody chose.

## 5. The time targets

```
easy    30 s
medium  45 s
hard    60 s
```

One constants file, `domain/time-targets.ts`, exported as milliseconds. Tuning
them is an edit, never a migration, and — because §4 freezes the value onto each
answer — tuning them does not disturb answers already recorded.

**These are targets, not limits.** Nothing is cut off, nothing is scored down
for being slow, and the student is never shown a countdown. The number decides
what comes next; it does not decide what the answer was worth.

## 6. The classification, and the anti-cheat floor

Each answer is classified, in this order:

| Class | Condition |
|---|---|
| `discounted` | `timeSpentMs < 3000` |
| `wrong` | not correct |
| `qualifying` | correct and `timeSpentMs <= target` |
| `slow` | correct and `timeSpentMs > target` |

**`discounted` is first and it is the important one.** The existing anti-cheat
rule scores an attempt ZERO when its average falls below three seconds per
question. A ladder that rewards speed without a floor would push students toward
the exact behaviour that invalidates their own session — we would be teaching
them to fail. An answer under three seconds is not evidence of skill; it moves
nothing, up or down.

It is not punished either. It is recorded, it counts toward the attempt's
answers, and if the whole attempt averages under three seconds the existing rule
already handles it.

## 7. The ladder

State: one of `easy | medium | hard`, plus two streak counts.

**Where it starts** — from the student's existing evidence for that chapter,
which `chapter_mastery` already holds:

| Evidence | Starting rung |
|---|---|
| `not_assessed`, `needs_another_session` | easy |
| `developing` | medium |
| `strong` | hard |

**How it moves**, applied to each answer after it is classified:

- **two consecutive `qualifying` → up one rung.** Both streaks reset.
- **any `wrong` → down one rung, immediately.** Both streaks reset.
- **two consecutive `slow` → down one rung.** Both streaks reset. A student who
  is right but labouring is not being helped by something harder.
- `discounted` → no movement, no streak change.
- Clamped at `easy` and `hard`.

**When the rung has nothing left to serve.** The ladder asks for a difficulty;
the chapter may not have an unserved question at it — always true for the six
chapters missing a rung, and true for any chapter late in a long session. The
fallback is nearest-rung-first (`hard → medium → easy`, `easy → medium → hard`),
and if the chapter is exhausted entirely the session ends early with the
questions served so far. **The rung does not move because a question was
missing** — that would let a content gap masquerade as a judgement about the
student.

**The ladder is recomputed, never stored.** No `current_rung` column. It is a
pure function of the responses already recorded for the session — each carries
its correctness, its time, its authored difficulty and its frozen target. This
is the same rule that keeps `totalXp` a SUM over the ledger rather than a
counter: a stored rung is a second source of truth that can drift from the rows,
and the rows are the evidence.

```ts
// domain/difficulty-ladder.ts — pure. No clock, no I/O, no randomness.
export type Rung = 'easy' | 'medium' | 'hard';
export type AnswerClass = 'qualifying' | 'slow' | 'wrong' | 'discounted';

export function classifyAnswer(input: {
  isCorrect: boolean;
  timeSpentMs: number;
  targetMs: number;
}): AnswerClass;

/** Replays the whole session's answers. Order matters; the result is total. */
export function rungAfter(startingRung: Rung, classes: readonly AnswerClass[]): Rung;
```

## 8. Contract and API changes

`AnswerResult` gains one field:

```ts
/**
 * The next question, chosen by the ladder from this answer. Null when the
 * session has reached its target length or the chapter is exhausted.
 */
nextQuestion: practiceQuestionSchema.nullable();
```

`PracticeSession.questions` keeps its shape and carries the questions served so
far — one, at the start. `questionCount` on `AnswerResult` becomes the session's
TARGET, which is what a progress indicator has always needed it to mean.

`POST /practice/sessions/:id/answers` therefore does, in one transaction: record
the response with its frozen target, recompute the ladder, choose and append the
next question, extend `option_order` with that question's shuffle, and return
both the answer result and the next question.

**Everything the answer endpoint already guarantees is unchanged**, and one of
them constrains this design: a second answer to the same question is refused
with 409, because the answer key is disclosed on the first (D-281). Serving the
next question in the same response does not weaken that — the new question's key
is not disclosed until it, too, is answered.

## 9. The client

`practice-screen.tsx` renders one question at a time already, from a set it
holds. It will instead render the question it has, and replace it with
`nextQuestion` when an answer returns. When `nextQuestion` is null the session is
over and the existing submit path runs.

The progress indicator reads `answeredCount` / `questionCount`, both of which
still arrive on every answer.

## 10. The report this makes possible

No screen changes. The data is queryable, and the query is documented rather
than left to be reinvented:

```sql
-- Pace by difficulty, one student, one chapter.
SELECT r.authored_difficulty,
       count(*)                                                    AS answers,
       round(avg(r.time_spent_ms) / 1000.0, 1)                     AS avg_seconds,
       round(avg(r.time_target_ms) / 1000.0, 1)                    AS target_seconds,
       round(100.0 * avg((r.time_spent_ms <= r.time_target_ms
                          AND r.is_correct)::int), 0)              AS pct_qualifying
FROM practice_responses r
JOIN practice_sessions s ON s.id = r.session_id
WHERE r.student_user_id = $1 AND s.chapter_id = $2
GROUP BY r.authored_difficulty;
```

The ladder's path through a session is `authored_difficulty` in `created_at`
order — no extra storage, because §7 keeps the rung derived.

## 11. Testing

| Level | What |
|---|---|
| Domain, pure | `classifyAnswer` at every boundary — 2999/3000 ms, exactly at target, one over. `rungAfter` over sequences: two qualifying steps up, one wrong steps down from anywhere, two slow steps down, clamps hold, discounted moves nothing and does not break a streak |
| Service | Next question honours the rung; the fallback fires when a rung is empty; the rung does NOT move when a question was missing; a session ends early on an exhausted chapter; `time_target_ms` is frozen from the served question's difficulty |
| Route | The answer response carries `nextQuestion`, and null on the last one; the 409 on a re-answer still holds |
| Anti-cheat | The count rule reads `target_question_count`; a session that ended early is validated against what it served, not against the target |
| Frontend | The screen advances on `nextQuestion`, submits when it is null |

## 12. What this deliberately does not do

- **No countdown, no timer on screen.** The record is for the report; showing it
  would turn practice into a test, which is the opposite of §9.1's stance on
  scores and ranking.
- **No per-question learned baselines.** Fixed targets by difficulty, chosen
  because 14 responses exist today; a learned median would run on defaults for
  months and be untestable until it did not.
- **No change to XP, scoring or evidence.** A harder question is not worth more
  today. That is a real question and it is not this one.
- **No hint interaction.** `hint_level_used` is recorded and the ladder ignores
  it, because the hint ladder is unrouted and unpopulated (item 44). When hints
  exist, a hinted correct answer probably should not count as qualifying.
